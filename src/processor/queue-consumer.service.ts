import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job, Queue, UnrecoverableError, WaitingChildrenError } from 'bullmq';
import { GraphUpdateJobState, IGraphUpdateJob, createGraphUpdateJob } from '#app/interfaces/graph-update-job.interface';
import { ReconnectionGraphService } from '#app/processor/reconnection-graph.service';
import { BlockchainService } from '#app/blockchain/blockchain.service';
import { ConfigService } from '#app/config/config.service';
import { MILLISECONDS_PER_SECOND } from 'time-constants';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { BlockchainConstants } from '#app/blockchain/blockchain-constants';
import { ReconnectionCacheMgrService } from '#app/cache/reconnection-cache-mgr.service';
import { ReconnectionServiceConstants } from '#app/constants';
import { ITxMonitorJob } from '#app/interfaces/monitor.job.interface';
import { CapacityLowError } from './errors';

const CAPACITY_EPOCH_TIMEOUT_NAME = 'capacity_check';

@Injectable()
@Processor(ReconnectionServiceConstants.GRAPH_UPDATE_QUEUE_NAME)
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
    @InjectQueue(ReconnectionServiceConstants.GRAPH_UPDATE_QUEUE_NAME) private graphUpdateQueue: Queue,
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

  async process(job: Job<any, any, string>): Promise<void> {
    if (job.name === ReconnectionServiceConstants.GRAPH_UPDATE_JOB_TYPE) {
      return this.processGraphUpdateJob(job);
    }
    if (job.name === 'monitorJobStatus') {
      return this.monitorUpdateTxns(job);
    }

    throw new UnrecoverableError(`Unknown job type ${job.name}`);
  }

  private async monitorUpdateTxns(job: Job<ITxMonitorJob, any, string>): Promise<void> {
    this.logger.debug(`Processing monitorUpdateTxns job ${job.id}`);
    const jobTxns = await this.cacheManager.getAllTxnsForJob(job.data.id);
    const sourceJob: Job<IGraphUpdateJob, any, string> | undefined = await this.graphUpdateQueue.getJob(job.data.id);
    if (!sourceJob) {
      throw new Error(`Unable to find source job ${job.id}`);
    }
    const allJobTxns = Object.values(jobTxns);
    const pending = allJobTxns.filter((tx) => tx.status === 'pending');
    const success = allJobTxns.filter((tx) => tx.status === 'success');
    const failed = allJobTxns.filter((tx) => tx.status === 'failed');
    const expired = allJobTxns.filter((tx) => tx.status === 'expired');

    if (allJobTxns.length === 0 || pending.length === 0) {
      await this.cacheManager.removeJob(sourceJob.id!);
    }

    if (allJobTxns.length === 0) {
      this.logger.verbose(`No transactions to await for job ${sourceJob.id}; marking completed`);
      await sourceJob.updateData({ ...sourceJob.data, state: GraphUpdateJobState.MonitorSuccess });
    } else if (pending.length === 0 && failed.length === 0 && expired.length === 0 && success.length > 0) {
      this.logger.verbose(`All transactions completed for job ${sourceJob.id}`);
      await sourceJob.updateData({ ...sourceJob.data, state: GraphUpdateJobState.MonitorSuccess });
    } else if (pending.length > 0) {
      this.logger.verbose(`Job ${sourceJob.id} still has pending transactions`);
      await job.moveToDelayed(Date.now() + BlockchainConstants.SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND, job.token);
      throw new DelayedError();
    } else if (failed.length > 0) {
      // Check types of failures to determine whether we pause queue or retry
      let pause = false;
      let retry = false;
      let failure: string | undefined;
      failed.forEach(({ error }) => {
        const errorReport = this.handleMessagesFailure(error!);
        pause = pause || errorReport.pause;
        retry = retry || errorReport.retry;
        if (!errorReport.pause && !errorReport.retry) {
          failure = error;
        }
      });

      if (pause) {
        // eslint-disable-next-line no-await-in-loop
        await this.graphUpdateQueue.pause();
      }

      if (retry) {
        this.logger.error(`Job ${sourceJob.id} had transactions that failed; retrying`);
        await sourceJob.updateData({ ...sourceJob.data, state: GraphUpdateJobState.ChainFailureRetry });
      } else if (failure) {
        this.logger.error(`Job ${sourceJob.id} failed with error ${failure}`);
        await sourceJob.updateData({ ...sourceJob.data, state: GraphUpdateJobState.ChainFailureNoRetry });
      }
    } else if (expired.length > 0) {
      this.logger.error(`Job ${sourceJob.id} had transactions that expired; retrying`);
      await sourceJob.updateData({ ...sourceJob.data, state: GraphUpdateJobState.ChainFailureRetry });
    } else {
      await job.moveToDelayed(Date.now() + BlockchainConstants.SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND, job.token);
      throw new DelayedError();
    }
  }

  // eslint-disable-next-line consistent-return
  private async processGraphUpdateJob(job: Job<IGraphUpdateJob, any, string>): Promise<void> {
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
        this.graphUpdateQueue.add(
          'monitorJobStatus',
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
      this.logger.error(`Job ${job.id} failed (attempts=${job.attemptsMade})`, e);
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
        await this.graphUpdateQueue.add(ReconnectionServiceConstants.GRAPH_UPDATE_JOB_TYPE, delayJobData, { jobId: deadLetterDelayedJobId, delay });
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

  private handleMessagesFailure(error: string): { pause: boolean; retry: boolean } {
    let retval = { pause: false, retry: false };
    switch (error) {
      case 'StalePageState':
      case 'ProofHasExpired':
      case 'ProofNotYetValid':
      case 'InvalidSignature':
        // Re-try the job in the request change queue
        retval = { pause: false, retry: true };
        break;

      case 'InvalidSchemaId':
        retval = { pause: true, retry: false };
        break;

      case 'InvalidMessageSourceAccount':
      case 'UnauthorizedDelegate':
      case 'CorruptedState':
      case 'InvalidItemAction':
      case 'PageIdExceedsMaxAllowed':
      case 'PageExceedsMaxPageSizeBytes':
      case 'UnsupportedOperationForSchema':
      case 'InvalidPayloadLocation':
      case 'SchemaPayloadLocationMismatch':
        // fail the job since this is unrecoverable
        retval = { pause: false, retry: false };
        break;

      default:
        this.logger.error(`Unknown module error ${error}`);
        break;
    }

    return retval;
  }
}
