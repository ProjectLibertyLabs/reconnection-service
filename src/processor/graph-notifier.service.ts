import { InjectRedis } from '@liaoliaots/nestjs-redis';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import { MILLISECONDS_PER_SECOND } from 'time-constants';
import { RegistryError } from '@polkadot/types/types';
import { BlockchainService } from '#app/blockchain/blockchain.service';
import { BlockchainConstants } from '#app/blockchain/blockchain-constants';
import { ITxMonitorJob } from '#app/interfaces/monitor.job.interface';
import { IGraphUpdateJob } from '#app/interfaces/graph-update-job.interface';

@Injectable()
@Processor('graphTxMonitorQueue')
export class GraphNotifierService extends WorkerHost {
  private logger: Logger;

  constructor(
    @InjectRedis() private cacheManager: Redis,
    @InjectQueue('graphUpdateQueue') private reconnectionQueue: Queue,
    private blockchainService: BlockchainService,
  ) {
    super();
    this.logger = new Logger(this.constructor.name);
  }

  async process(job: Job<ITxMonitorJob, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of type ${job.name}`);
    try {
      const numberBlocksToParse = BlockchainConstants.NUMBER_BLOCKS_TO_CRAWL;
      const txCapacityEpoch = job.data.epoch;
      const previousKnownBlockNumber = (await this.blockchainService.getBlock(job.data.lastFinalizedBlockHash)).block.header.number.toBigInt();
      const currentFinalizedBlockNumber = await this.blockchainService.getLatestFinalizedBlockNumber();
      const blockList = Array.from(
        { length: Math.min(Number(numberBlocksToParse), Number(currentFinalizedBlockNumber) - Number(previousKnownBlockNumber)) },
        (_, index) => previousKnownBlockNumber + BigInt(index) + 1n,
      );
      const txResult = await this.blockchainService.crawlBlockListForTx(job.data.txHash, blockList, [{ pallet: 'system', event: 'ExtrinsicSuccess' }]);
      if (!txResult.found) {
        this.logger.error(`Tx ${job.data.txHash} not found in block list`);
        throw new Error(`Tx ${job.data.txHash} not found in block list`);
      } else {
        // Set current epoch capacity
        await this.setEpochCapacity(txCapacityEpoch, BigInt(txResult.capacityWithDrawn ?? 0n));
        if (txResult.error) {
          this.logger.debug(`Error found in tx result: ${JSON.stringify(txResult.error)}`);
          const errorReport = await this.handleMessagesFailure(txResult.error);
          if (errorReport.pause) {
            await this.reconnectionQueue.pause();
          }
          if (errorReport.retry) {
            await this.retryRequestJob(job.data.id);
          } else {
            throw new Error(`Job ${job.data.id} failed with error ${JSON.stringify(txResult.error)}`);
          }
        }

        if (txResult.success) {
          this.logger.verbose(`Successfully found ${job.data.txHash} found in block ${txResult.blockHash}`);
          await this.removeSuccessJobs(job.data.id);
        }
      }
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  private async removeSuccessJobs(referenceId: string): Promise<void> {
    this.logger.debug(`Removing success jobs for ${referenceId}`);
    this.reconnectionQueue.remove(referenceId);
  }

  private async retryRequestJob(requestReferenceId: string): Promise<void> {
    this.logger.debug(`Retrying graph change request job ${requestReferenceId}`);
    const requestJob: Job<IGraphUpdateJob, any, string> | undefined = await this.reconnectionQueue.getJob(requestReferenceId);
    if (!requestJob) {
      this.logger.debug(`Job ${requestReferenceId} not found in queue`);
      return;
    }
    await this.reconnectionQueue.remove(requestReferenceId);
    await this.reconnectionQueue.add(`Retrying publish job - ${requestReferenceId}`, requestJob.data, {
      jobId: requestReferenceId,
    });
  }

  private async setEpochCapacity(epoch: string, capacityWithdrew: bigint): Promise<void> {
    const epochCapacityKey = `epochCapacity:${epoch}`;

    try {
      const savedCapacity = await this.cacheManager.get(epochCapacityKey);
      const epochCapacity = BigInt(savedCapacity ?? 0);
      const newEpochCapacity = epochCapacity + capacityWithdrew;

      const epochDurationBlocks = await this.blockchainService.getCurrentEpochLength();
      const epochDuration = epochDurationBlocks * BlockchainConstants.SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND;
      await this.cacheManager.setex(epochCapacityKey, epochDuration, newEpochCapacity.toString());
    } catch (error) {
      this.logger.error(`Error setting epoch capacity: ${error}`);
    }
  }

  private async handleMessagesFailure(moduleError: RegistryError): Promise<{ pause: boolean; retry: boolean }> {
    try {
      switch (moduleError.method) {
        case 'StalePageState':
        case 'ProofHasExpired':
        case 'ProofNotYetValid':
        case 'InvalidSignature':
          // Re-try the job in the request change queue
          return { pause: false, retry: true };
        case 'InvalidSchemaId':
          return { pause: true, retry: false };
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
          return { pause: false, retry: false };
        default:
          this.logger.error(`Unknown module error ${moduleError}`);
          break;
      }
    } catch (error) {
      this.logger.error(`Error handling module error: ${error}`);
    }

    // unknown error, pause the queue
    return { pause: false, retry: false };
  }
}
