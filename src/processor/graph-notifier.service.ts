import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { MILLISECONDS_PER_SECOND } from 'time-constants';
import { BlockchainService } from '#app/blockchain/blockchain.service';
import { BlockchainConstants } from '#app/blockchain/blockchain-constants';
import { IGraphUpdateJob } from '#app/interfaces/graph-update-job.interface';
import { BlockchainScannerService } from '#app/blockchain-scanner.service';
import { SchedulerRegistry } from '@nestjs/schedule';
import { BlockHash } from '@polkadot/types/interfaces';
import { HexString } from '@polkadot/util/types';
import { ReconnectionCacheMgrService } from '#app/cache/reconnection-cache-mgr.service';

@Injectable()
export class GraphUpdateCompletionMonitorService extends BlockchainScannerService implements OnApplicationBootstrap, OnApplicationShutdown {
  onApplicationBootstrap() {
    this.schedulerRegistry.addInterval(
      `${this.cachePrefix}:blockchainScan`,
      setInterval(() => this.scan(), BlockchainConstants.SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND),
    );

    super.onApplicationBootstrap();
  }

  async onApplicationShutdown(signal?: string | undefined) {
    const interval = this.schedulerRegistry.getInterval(`${this.cachePrefix}:blockchainScan`);
    if (interval) {
      this.schedulerRegistry.deleteInterval(`${this.cachePrefix}:blockchainScan`);
    }

    super.onApplicationShutdown(signal);
  }

  constructor(
    cacheManager: ReconnectionCacheMgrService,
    @InjectQueue('graphUpdateQueue') private reconnectionQueue: Queue,
    private readonly schedulerRegistry: SchedulerRegistry,
    blockchainService: BlockchainService,
    private readonly cacheService: ReconnectionCacheMgrService,
  ) {
    super(cacheManager, blockchainService, new Logger(GraphUpdateCompletionMonitorService.name), { cachePrefix: 'graphUpdateMonitor' });
  }

  async processCurrentBlock(currentBlockHash: BlockHash, _currentBlockNumber: number): Promise<void> {
    // Get set of tx hashes to monitor from cache
    let pendingTxns = await this.cacheService.getAllPendingTxns();

    const block = await this.blockchainService.getBlock(currentBlockHash);
    const extrinsicIndices: [HexString, number][] = [];
    block.block.extrinsics.forEach((extrinsic, index) => {
      if (Object.keys(pendingTxns).some((txHash) => txHash === extrinsic.hash.toHex())) {
        extrinsicIndices.push([extrinsic.hash.toHex(), index]);
      }
    });

    if (extrinsicIndices.length > 0) {
      const at = await this.blockchainService.apiPromise.at(currentBlockHash);
      const epoch = (await at.query.capacity.currentEpoch()).toNumber();
      let totalCapacityWithdrawn: bigint = 0n;
      const events = (await at.query.system.events()).filter(({ phase }) => phase.isApplyExtrinsic && extrinsicIndices.some((index) => phase.asApplyExtrinsic.eq(index)));
      const capacityAmounts: bigint[] = events
        .filter(({ event }) => at.events.capacity.CapacityWithdrawn.is(event))
        .map(({ event }) => (event as unknown as any).data.amount.toBigInt());
      totalCapacityWithdrawn = capacityAmounts.reduce((prev, curr) => prev + curr, totalCapacityWithdrawn);

      // eslint-disable-next-line no-restricted-syntax
      for (const [txHash, txIndex] of extrinsicIndices) {
        const extrinsicEvents = events.filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(txIndex));
        const hasSuccess = extrinsicEvents.some(({ event }) => at.events.utility.BatchCompleted.is(event));
        const failureEvent = extrinsicEvents.find(({ event }) => at.events.system.ExtrinsicFailed.is(event));

        // eslint-disable-next-line no-await-in-loop
        const txStatus = pendingTxns[txHash];

        if (failureEvent && at.events.system.ExtrinsicFailed.is(failureEvent.event)) {
          if (hasSuccess) {
            this.logger.warn(`Events for tx ${txHash} include both success and failure ???`);
          }
          const { asModule: moduleThatErrored, registry } = failureEvent.event.data.dispatchError;
          const moduleError = registry.findMetaError(moduleThatErrored);
          txStatus.error = moduleError.method;
          txStatus.status = 'failed';
        } else if (hasSuccess) {
          txStatus.status = 'success';
        } else {
          this.logger.error(`Tx hash ${txHash} found in block, but neither success nor failure`);
        }

        // eslint-disable-next-line no-await-in-loop
        await this.cacheService.upsertWatchedTxns(txStatus);
      }

      await this.setEpochCapacity(epoch, totalCapacityWithdrawn);

      // Now check all pending transactions for expiration
      const lastBlock = await this.blockchainService.getLatestFinalizedBlockNumber();
      pendingTxns = await this.cacheService.getAllPendingTxns();
      // eslint-disable-next-line no-restricted-syntax
      for (const txStatus of Object.values(pendingTxns)) {
        if (BigInt(txStatus.death) >= lastBlock) {
          txStatus.status = 'expired';
          this.logger.verbose(`Tx ${txStatus.txHash} expired`);
          // eslint-disable-next-line no-await-in-loop
          await this.cacheService.upsertWatchedTxns(txStatus);
        }
      }
    }

    // Now go through all pending jobs and determine disposition
    const jobs = await this.cacheService.getAllPendingJobs();
    // eslint-disable-next-line no-restricted-syntax
    for (const key of jobs) {
      const job = key.replace(/^pending:/, '');
      this.logger.verbose(`Checking disposition of ${job}`);
      // eslint-disable-next-line no-await-in-loop
      const jobTxns = await this.cacheService.getAllTxnsForJob(job);
      const allJobTxns = Object.values(jobTxns);
      const pending = allJobTxns.filter((tx) => tx.status === 'pending');
      const success = allJobTxns.filter((tx) => tx.status === 'success');
      const failed = allJobTxns.filter((tx) => tx.status === 'failed');
      const expired = allJobTxns.filter((tx) => tx.status === 'expired');

      if (pending.length === 0 && failed.length === 0 && expired.length === 0 && success.length > 0) {
        this.logger.verbose(`All transactions completed for job ${job}`);
        // eslint-disable-next-line no-await-in-loop
        await this.removeSuccessJobs(job);
      } else if (pending.length > 0) {
        this.logger.verbose(`Job ${job} still has pending transactions`);
        // eslint-disable-next-line no-continue
        continue;
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
          await this.reconnectionQueue.pause();
        }

        if (retry) {
          this.logger.error(`Job ${job} had transactions that failed; retrying`);
          // eslint-disable-next-line no-await-in-loop
          await this.retryRequestJob(job);
        } else if (failure) {
          this.logger.error(`Job ${job} failed with error ${failure}`);
        }
      } else if (expired.length > 0) {
        this.logger.error(`Job ${job} had transactions that expired; retrying`);
        // eslint-disable-next-line no-await-in-loop
        await this.retryRequestJob(job);
      }
    }
  }

  private async removeSuccessJobs(referenceId: string): Promise<void> {
    this.logger.debug(`Removing success jobs for ${referenceId}`);
    await this.reconnectionQueue.remove(referenceId);
    await this.cacheService.removeJob(referenceId);
  }

  private async retryRequestJob(requestReferenceId: string, error?: string): Promise<void> {
    this.logger.debug(`Retrying graph change request job ${requestReferenceId}`);
    const requestJob: Job<IGraphUpdateJob, any, string> | undefined = await this.reconnectionQueue.getJob(requestReferenceId);
    if (!requestJob) {
      this.logger.warn(`Job ${requestReferenceId} not found in queue`);
      return;
    }

    let attempts = await this.cacheService.getJobAttempts(requestReferenceId);
    attempts = await this.cacheService.incrJobAttempts(requestReferenceId);
    if (attempts > 3) {
      this.logger.warn(`Max retries exceeded; will not retry job (${requestReferenceId})`);
      this.reconnectionQueue.remove(requestReferenceId);
      this.cacheService.removeJob(requestReferenceId);
      return;
    }

    await this.cacheService.clearTxnsForJob(requestReferenceId);
    attempts = await this.cacheService.getJobAttempts(requestReferenceId);
    await this.reconnectionQueue.remove(requestReferenceId);
    await this.reconnectionQueue.add(`Retrying publish job - ${requestReferenceId}`, requestJob.data, {
      jobId: requestReferenceId,
    });
  }

  private async setEpochCapacity(epoch: number, capacityWithdrawn: bigint): Promise<void> {
    const epochCapacityKey = `epochCapacity:${epoch}`;

    try {
      const savedCapacity = await this.cacheManager.redis.get(epochCapacityKey);
      const epochCapacity = BigInt(savedCapacity ?? 0);
      const newEpochCapacity = epochCapacity + capacityWithdrawn;

      const epochDurationBlocks = await this.blockchainService.getCurrentEpochLength();
      const epochDuration = epochDurationBlocks * BlockchainConstants.SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND;
      await this.cacheManager.redis.setex(epochCapacityKey, epochDuration, newEpochCapacity.toString());
    } catch (error) {
      this.logger.error(`Error setting epoch capacity: ${error}`);
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
