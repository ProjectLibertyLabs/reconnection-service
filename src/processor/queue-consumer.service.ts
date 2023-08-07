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
import { CapacityLowError } from './errors';

export const SECONDS_PER_BLOCK = 12;
const CAPACITY_EPOCH_TIMEOUT_NAME = 'capacity_check';

@Injectable()
@Processor('graphUpdateQueue')
export class QueueConsumerService extends WorkerHost implements OnApplicationBootstrap, OnModuleDestroy {
  private logger: Logger;

  private capacityExhausted = false;

  private webhookOk = true;

  public async onApplicationBootstrap() {
    await this.checkCapacity();
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
    private graphSdkService: ReconnectionGraphService,
    private blockchainService: BlockchainService,
    private configService: ConfigService,
    private schedulerRegistry: SchedulerRegistry,
    private eventEmitter: EventEmitter2,
  ) {
    super();
    this.logger = new Logger(this.constructor.name);
  }

  // eslint-disable-next-line class-methods-use-this
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
      await this.graphSdkService.updateUserGraph(job.data.dsnpId, job.data.providerId, job.data.processTransitiveUpdates);
      this.logger.verbose(`Successfully completed job ${job.id}`);
    } catch (e) {
      this.logger.error(`Job ${job.id} failed (attempts=${job.attemptsMade})`);
      if(e instanceof CapacityLowError){
        // if capacity is low, saying for some failing transactions
        // add delay to job and continue
        // all failing txs due to low capacity will be delayed until next epoch
        const capacity = await this.blockchainService.capacityInfo(this.configService.getProviderId());
        const blocksRemaining = capacity.nextEpochStart - capacity.currentBlockNumber;
        const delay = blocksRemaining * SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND;
        this.logger.debug(`Adding delay to job ${job.id} for ${delay}ms`);
        const {key: delayJobId, data: delayJobData} = createGraphUpdateJob(job.data.dsnpId, job.data.providerId, job.data.processTransitiveUpdates);
        await this.graphUpdateQueue.add(delayJobId, delayJobData, {delay});
        return;
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
        setTimeout(() => this.checkCapacity(), blocksRemaining * SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND),
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
    const capacityLimit = this.configService.getCapacityLimit();
    const capacity = await this.blockchainService.capacityInfo(this.configService.getProviderId());
    const remainingCapacity = capacity.remainingCapacity;
    let outOfCapacity = capacity.remainingCapacity <= 0n;

      if(!outOfCapacity) {
        this.logger.debug(`Capacity remaining: ${remainingCapacity}`);
        if (capacityLimit.type === 'percentage') {
          const minRemainingPct = 100 - capacityLimit.value;
          const percentageRemaining = (capacity.remainingCapacity * 100n) / (capacity.totalCapacityIssued || 1n);
          if (percentageRemaining <= minRemainingPct ) {
            outOfCapacity = true;
            this.logger.warn(
              `Capacity threshold reached: remaining pct = ${percentageRemaining}% (${minRemainingPct}% required (${
                (capacity.remainingCapacity * 100n) / capacity.totalCapacityIssued
              }))`,
            );
          }
        } else {
          const capacityUsed = capacity.totalCapacityIssued - capacity.remainingCapacity;
          if (capacityUsed >= capacityLimit.value) {
            outOfCapacity = true;
            this.logger.warn(`Capacity threshold reached: used ${capacityUsed} of ${capacityLimit.value}`);
          }
      }
    }

    if (outOfCapacity) {
      await this.eventEmitter.emitAsync('capacity.exhausted');
    } else {
      await this.eventEmitter.emitAsync('capacity.refilled');
    }
  }
}
