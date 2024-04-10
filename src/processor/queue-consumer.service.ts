import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { IGraphUpdateJob, createGraphUpdateJob } from '#app/interfaces/graph-update-job.interface';
import { ReconnectionGraphService } from '#app/processor/reconnection-graph.service';
import { BlockchainService } from '#app/blockchain/blockchain.service';
import { ConfigService } from '#app/config/config.service';
import { MILLISECONDS_PER_SECOND } from 'time-constants';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { BlockchainConstants } from '#app/blockchain/blockchain-constants';
import { ReconnectionCacheMgrService } from '#app/cache/reconnection-cache-mgr.service';
import { CapacityLowError } from './errors';

const CAPACITY_EPOCH_TIMEOUT_NAME = 'capacity_check';

@Injectable()
@Processor('graphUpdateQueue')
export class QueueConsumerService extends WorkerHost implements OnApplicationBootstrap, OnModuleDestroy {
  private logger: Logger;

  private capacityExhausted = false;

  private webhookOk = true;

  public async onApplicationBootstrap() {
    await Promise.all([this.blockchainService.api.isReady, this.blockchainService.apiPromise.isReady]);
    await this.checkCapacity();
    this.graphUpdateQueue.resume();
  }

  public onModuleDestroy() {
    try {
      this.schedulerRegistry.deleteTimeout(CAPACITY_EPOCH_TIMEOUT_NAME);
    } catch (e) {
      // ignore error
    }
  }

  constructor(
    @InjectQueue('graphUpdateQueue') private graphUpdateQueue: Queue,
    private cacheManager: ReconnectionCacheMgrService,
    private graphSdkService: ReconnectionGraphService,
    private blockchainService: BlockchainService,
    private configService: ConfigService,
    private schedulerRegistry: SchedulerRegistry,
    private eventEmitter: EventEmitter2,
  ) {
    super();
    this.logger = new Logger(this.constructor.name);
    graphUpdateQueue.pause(); // pause queue until we're ready to start processing
  }

  async process(job: Job<IGraphUpdateJob, any, string>) {
    this.logger.debug(`Processing job ${job.id}, attempts: ${job.attemptsMade}`);

    // Handle dev/debug jobs
    if (typeof job.data.debugDisposition !== 'undefined') {
      const debugData: any = job.data.debugDisposition;
      switch (debugData?.action) {
        // This is too dangerous to leave enabled unless you're doing serious debugging
        // case 'abort':
        //   this.logger.debug(`Forcing abort in order to generate stalled job: ${job.id}`);
        //   process.exit(1);

        // eslint-disable-next-line no-fallthrough
        case 'fail':
          this.logger.debug(`Force-failing job ${job.id}--attempt ${job.attemptsMade} of ${job.opts.attempts}`);
          throw new Error('Forcing job failure');

        case 'complete':
          if (debugData?.attempts >= 0) {
            if (job.attemptsMade < debugData.attempts) {
              this.logger.debug(`Force-failing job ${job.id}--attempt ${job.attemptsMade} of ${job.opts.attempts}`);
              throw new Error(`Job ${job.id} failing temporarily (attempt ${job.attemptsMade} of ${debugData.attempts}`);
            } else {
              this.logger.debug(`Completing job ${job.id} after ${job.attemptsMade} attempts`);
            }
          }
          break;

        default:
          break;
      }
    }

    try {
      await this.graphSdkService.updateUserGraph(job.id ?? '', job.data.dsnpId, job.data.providerId, job.data.processTransitiveUpdates);
      this.logger.verbose(`Successfully completed job ${job.id}`);
    } catch (e) {
      this.logger.error(`Job ${job.id} failed (attempts=${job.attemptsMade})`);
      const isDeadLetter = job.id?.search(this.configService.getDeadLetterPrefix()) === 0;
      if (!isDeadLetter && job.attemptsMade === 1 && job.id) {
        // if capacity is low, saying for some failing transactions
        // add delay to job and continue
        // all failing txs due to low capacity will be delayed until next epoch
        const capacity = await this.blockchainService.capacityInfo(this.configService.getProviderId());
        const blocksRemaining = capacity.nextEpochStart - capacity.currentBlockNumber;
        const blockDelay = BlockchainConstants.SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND;
        const delay = e instanceof CapacityLowError ? blocksRemaining * blockDelay : blockDelay;
        this.logger.debug(`Adding delay to job ${job.id} for ${delay}ms`);
        const { key: delayJobId, data: delayJobData } = createGraphUpdateJob(job.data.dsnpId, job.data.providerId, job.data.processTransitiveUpdates);
        const deadLetterDelayedJobId = `${this.configService.getDeadLetterPrefix()}${delayJobId}`;
        await this.graphUpdateQueue.remove(deadLetterDelayedJobId);
        await this.graphUpdateQueue.remove(job.id);
        await this.graphUpdateQueue.add(`graphUpdate:${delayJobData.dsnpId}`, delayJobData, { jobId: deadLetterDelayedJobId, delay });
      }
      throw e;
    } finally {
      await this.checkCapacity();
    }
  }

  @OnEvent('webhook.gone', { async: true, promisify: true })
  private async handleWebhookGone() {
    this.logger.debug('Received webhook.gone event');
    this.webhookOk = false;
    await this.graphUpdateQueue.pause();
  }

  @OnEvent('webhook.healthy', { async: true, promisify: true })
  private async handleWebhookRestored() {
    this.logger.debug('Received webhook.healthy event');
    this.webhookOk = true;
    if (!this.capacityExhausted) {
      await this.graphUpdateQueue.resume();
    }
  }

  @OnEvent('capacity.exhausted', { async: true, promisify: true })
  private async handleCapacityExhausted() {
    this.logger.debug('Received capacity.exhausted event');
    this.capacityExhausted = true;
    await this.graphUpdateQueue.pause();
    const capacityLimit = this.configService.getCapacityLimit();
    const capacity = await this.blockchainService.capacityInfo(this.configService.getProviderId());

    this.logger.debug(`
    Capacity limit: ${JSON.stringify(capacityLimit)}
    Capacity info: ${JSON.stringify(capacity)}`);

    await this.graphUpdateQueue.pause();
    const blocksRemaining = capacity.nextEpochStart - capacity.currentBlockNumber;
    try {
      this.schedulerRegistry.addTimeout(
        CAPACITY_EPOCH_TIMEOUT_NAME,
        setTimeout(() => this.checkCapacity(), blocksRemaining * BlockchainConstants.SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND),
      );
    } catch (err) {
      // ignore duplicate timeout
    }
  }

  @OnEvent('capacity.refilled', { async: true, promisify: true })
  private async handleCapacityRefilled() {
    this.logger.debug('Received capacity.refilled event');
    this.capacityExhausted = false;
    try {
      this.schedulerRegistry.deleteTimeout(CAPACITY_EPOCH_TIMEOUT_NAME);
    } catch (err) {
      // ignore
    }

    if (this.webhookOk) {
      await this.graphUpdateQueue.resume();
    }
  }

  private async checkCapacity(): Promise<void> {
    try {
      const capacityLimit = this.configService.getCapacityLimit();
      const capacity = await this.blockchainService.capacityInfo(this.configService.getProviderId());
      const { remainingCapacity } = capacity;
      const { currentEpoch } = capacity;
      const epochCapacityKey = `epochCapacity:${currentEpoch}`;
      const epochUsedCapacity = BigInt((await this.cacheManager.redis.get(epochCapacityKey)) ?? 0); // Fetch capacity used by the service
      let outOfCapacity = remainingCapacity <= 0n;

      if (!outOfCapacity) {
        this.logger.debug(`Capacity remaining: ${remainingCapacity}`);
        if (capacityLimit.type === 'percentage') {
          const capacityLimitPercentage = BigInt(capacityLimit.value);
          const capacityLimitThreshold = (capacity.totalCapacityIssued * capacityLimitPercentage) / 100n;
          this.logger.debug(`Capacity limit threshold: ${capacityLimitThreshold}`);
          if (epochUsedCapacity >= capacityLimitThreshold) {
            outOfCapacity = true;
            this.logger.warn(`Capacity threshold reached: used ${epochUsedCapacity} of ${capacityLimitThreshold}`);
          }
        } else if (epochUsedCapacity >= capacityLimit.value) {
          outOfCapacity = true;
          this.logger.warn(`Capacity threshold reached: used ${epochUsedCapacity} of ${capacityLimit.value}`);
        }
      }

      if (outOfCapacity) {
        await this.eventEmitter.emitAsync('capacity.exhausted');
      } else {
        await this.eventEmitter.emitAsync('capacity.refilled');
      }
    } catch (err: any) {
      this.logger.error('Caught error in checkCapacity', err?.stack);
    }
  }
}
