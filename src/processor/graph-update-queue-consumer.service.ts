import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError, WaitingChildrenError } from 'bullmq';
import { GraphUpdateJobState, IGraphUpdateJob, createGraphUpdateJob } from '#app/interfaces/graph-update-job.interface';
import { ReconnectionGraphService } from '#app/processor/reconnection-graph.service';
import { BlockchainService } from '#app/blockchain/blockchain.service';
import { ConfigService } from '#app/config/config.service';
import { MILLISECONDS_PER_SECOND } from 'time-constants';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import * as BlockchainConstants from '#app/blockchain/blockchain-constants';
import { ReconnectionCacheMgrService } from '#app/cache/reconnection-cache-mgr.service';
import * as ReconnectionServiceConstants from '#app/constants';
import { CapacityLowError } from './errors';

const CAPACITY_EPOCH_TIMEOUT_NAME = 'capacity_check';

@Injectable()
@Processor(ReconnectionServiceConstants.GRAPH_UPDATE_QUEUE_NAME)
export class GraphUpdateQueueConsumerService extends WorkerHost implements OnApplicationBootstrap, OnModuleDestroy {
  private logger: Logger;

  private capacityExhausted = false;

  private webhookOk = true;

  public async onApplicationBootstrap() {
    await Promise.all([this.blockchainService.api.isReady, this.blockchainService.apiPromise.isReady]);
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
    @InjectQueue(ReconnectionServiceConstants.GRAPH_UPDATE_QUEUE_NAME) private readonly graphUpdateQueue: Queue,
    @InjectQueue(ReconnectionServiceConstants.TX_MONITOR_QUEUE_NAME) private readonly txMonitorQueue: Queue,
    private readonly cacheManager: ReconnectionCacheMgrService,
    private readonly graphSdkService: ReconnectionGraphService,
    private readonly blockchainService: BlockchainService,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    super();
    this.logger = new Logger(this.constructor.name);
    graphUpdateQueue.pause(); // pause queue until we're ready to start processing
  }

  async process(job: Job<any, any, string>): Promise<void> {
    switch (job.data.state) {
      case GraphUpdateJobState.Unprocessed:
        return this.updateGraph(job);

      case GraphUpdateJobState.Submitted:
        this.logger.error(`Processing job ${job.id} in state 'Submitted'; should not happen`);
        throw new UnrecoverableError('Processing job in Submitted state');
        // eslint-disable-next-line no-unreachable
        break;

      case GraphUpdateJobState.ChainFailureNoRetry:
        await job.moveToFailed(new Error('Fatal job error condition after chain submission'), job.token!);
        break;

      case GraphUpdateJobState.ChainFailureRetry:
        await job.updateData({ ...job.data, state: GraphUpdateJobState.Unprocessed });
        throw new Error('Error detected on-chain; will retry if allowed');
        // eslint-disable-next-line no-unreachable
        break;

      case GraphUpdateJobState.MonitorSuccess:
      default:
    }

    return Promise.resolve();
  }

  private async updateGraph(job: Job<IGraphUpdateJob, any, string>) {
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
      let doTrack = false;
      if (await this.cacheManager.doesJobKeyExist(job.id!)) {
        doTrack = true;
        this.logger.debug(`Already tracking transactions for ${job.id}; adding a child job`);
      } else {
        doTrack = await this.graphSdkService.updateUserGraph(job.id ?? '', job.data.dsnpId, job.data.providerId, job.data.processTransitiveUpdates);
        this.logger.verbose(`Successfully ${doTrack ? 'submitted' : 'processed'} graph update for ${job.id}`);
      }
      if (doTrack) {
        this.txMonitorQueue.add(
          ReconnectionServiceConstants.TX_MONITOR_JOB_NAME,
          { id: job.id },
          {
            lifo: true,
            failParentOnFailure: true,
            parent: {
              id: job.id!,
              queue: job.queueQualifiedName,
            },
          },
        );

        const shouldWait = await job.moveToWaitingChildren(job.token!);
        if (!shouldWait) {
          throw new Error('Failed to await monitor job');
        }
        await job.updateData({ ...job.data, state: GraphUpdateJobState.Submitted });
        throw new WaitingChildrenError();
      }
    } catch (e) {
      if (e instanceof WaitingChildrenError) {
        throw e;
      }
      this.logger.error(`Job ${job.id} failed (attempts=${job.attemptsMade})`);
      const isDeadLetter = job.id?.search(ReconnectionServiceConstants.DEAD_LETTER_QUEUE_PREFIX) === 0;
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
        const deadLetterDelayedJobId = `${ReconnectionServiceConstants.DEAD_LETTER_QUEUE_PREFIX}${delayJobId}`;
        await this.graphUpdateQueue.remove(deadLetterDelayedJobId);
        await this.graphUpdateQueue.remove(job.id);
        await this.graphUpdateQueue.add(ReconnectionServiceConstants.GRAPH_UPDATE_JOB_TYPE, delayJobData, { jobId: deadLetterDelayedJobId, delay });
      }
      throw e;
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
        setTimeout(() => this.blockchainService.checkCapacity(), blocksRemaining * BlockchainConstants.SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND),
      );
    } catch (err) {
      // ignore duplicate timeout
    }
  }

  @OnEvent('capacity.refilled', { async: true, promisify: true })
  private async handleCapacityRefilled() {
    if (this.capacityExhausted) {
      this.logger.debug('Received capacity.refilled event');
    }
    this.capacityExhausted = false;
    try {
      this.schedulerRegistry.deleteTimeout(CAPACITY_EPOCH_TIMEOUT_NAME);
    } catch (err) {
      // ignore
    }

    if (this.webhookOk && (await this.graphUpdateQueue.isPaused())) {
      await this.graphUpdateQueue.resume();
    }
  }
}
