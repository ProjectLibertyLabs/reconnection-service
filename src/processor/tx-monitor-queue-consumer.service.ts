import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job, Queue } from 'bullmq';
import { GraphUpdateJobState, IGraphUpdateJob } from '#app/interfaces/graph-update-job.interface';
import { BlockchainService } from '#app/blockchain/blockchain.service';
import { MILLISECONDS_PER_SECOND } from 'time-constants';
import { SchedulerRegistry } from '@nestjs/schedule';
import { BlockchainConstants } from '#app/blockchain/blockchain-constants';
import { ReconnectionCacheMgrService } from '#app/cache/reconnection-cache-mgr.service';
import { ReconnectionServiceConstants } from '#app/constants';

const CAPACITY_EPOCH_TIMEOUT_NAME = 'capacity_check';

@Injectable()
@Processor(ReconnectionServiceConstants.TX_MONITOR_QUEUE_NAME)
export class TxMonitorQueueConsumerService extends WorkerHost implements OnApplicationBootstrap, OnModuleDestroy {
  private logger: Logger;

  public async onApplicationBootstrap() {
    await Promise.all([this.blockchainService.api.isReady, this.blockchainService.apiPromise.isReady]);
    await this.blockchainService.checkCapacity();
    this.txMonitorQueue.resume();
  }

  public onModuleDestroy() {
    try {
      this.schedulerRegistry.deleteTimeout(CAPACITY_EPOCH_TIMEOUT_NAME);
    } catch (e) {
      // ignore error
    }
  }

  constructor(
    @InjectQueue(ReconnectionServiceConstants.TX_MONITOR_QUEUE_NAME) private readonly txMonitorQueue: Queue,
    @InjectQueue(ReconnectionServiceConstants.GRAPH_UPDATE_QUEUE_NAME) private readonly graphUpdateQueue: Queue,
    private readonly cacheManager: ReconnectionCacheMgrService,
    private readonly blockchainService: BlockchainService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    super();
    this.logger = new Logger(this.constructor.name);
  }

  async process(job: Job<any, any, string>): Promise<void> {
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
