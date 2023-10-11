import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { BlockHash } from '@polkadot/types/interfaces';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SchedulerRegistry } from '@nestjs/schedule';
import { MILLISECONDS_PER_SECOND, SECONDS_PER_MINUTE } from 'time-constants';
import { InjectRedis } from '@liaoliaots/nestjs-redis';
import Redis from 'ioredis';
import { ConfigService } from './config/config.service';
import { UpdateTransitiveGraphs, createGraphUpdateJob } from './interfaces/graph-update-job.interface';
import { BlockchainService } from './blockchain/blockchain.service';

export const LAST_SEEN_BLOCK_NUMBER_KEY = 'lastSeenBlockNumber';

@Injectable()
export class BlockchainScannerService implements OnApplicationBootstrap {
  private logger: Logger;

  private scanInProgress = false;

  async onApplicationBootstrap() {
    // Set up recurring interval
    const interval = setInterval(() => this.scan(), this.configService.getBlockchainScanIntervalMinutes() * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND);
    this.schedulerRegistry.addInterval('blockchainScan', interval);

    // Kick off initial scan
    const initialTimeout = setTimeout(() => this.scan(), 0);
    this.schedulerRegistry.addTimeout('initialScan', initialTimeout);
  }

  constructor(
    @InjectRedis() private cacheManager: Redis,
    @InjectQueue('graphUpdateQueue') private graphUpdateQueue: Queue,
    private readonly configService: ConfigService,
    private schedulerRegistry: SchedulerRegistry,
    private blockchainService: BlockchainService,
  ) {
    this.logger = new Logger(BlockchainScannerService.name);
  }

  public async scan(): Promise<void> {
    // Uncomment below if you want to create a bunch of empty blocks on your local chain for testing
    //
    // if (/:(\/\/0\.0\.0\.0|localhost)/.test(this.configService.frequencyUrl!.toString())) {
    //   this.logger.warn('Local chain detected; making sure we have blocks');
    //   let currentBlock = (await this.api.rpc.chain.getBlock()).block.header.number.toNumber();
    //   while (currentBlock < 4000) {
    //     const res = await this.api.rpc.engine.createBlock(true, true);
    //     await this.api.rpc.engine.finalizeBlock(res.blockHash);
    //     currentBlock = (await this.api.rpc.chain.getBlock()).block.header.number.toNumber();
    //   }
    // }

    try {
      if (this.scanInProgress) {
        this.logger.log('Scheduled blockchain scan skipped due to previous scan still in progress');
        return;
      }

      // Only scan blocks if queue is empty
      let queueSize = await this.graphUpdateQueue.count();
      if (queueSize > 0) {
        this.logger.log('Deferring next blockchain scan until queue is empty');
        return;
      }

      this.scanInProgress = true;
      let currentBlockNumber: bigint;
      let currentBlockHash: BlockHash;

      const lastSeenBlockNumber = await this.getLastSeenBlockNumber();
      currentBlockNumber = lastSeenBlockNumber + 1n;
      currentBlockHash = await this.blockchainService.getBlockHash(currentBlockNumber);

      if (!currentBlockHash.some((byte) => byte !== 0)) {
        this.logger.log('No new blocks to read; no scan performed.');
        this.scanInProgress = false;
        return;
      }
      this.logger.log(`Starting scan from block #${currentBlockNumber} (${currentBlockHash})`);

      while (!currentBlockHash.isEmpty && queueSize < this.configService.getQueueHighWater()) {
        // eslint-disable-next-line no-await-in-loop
        const events = (await this.blockchainService.queryAt(currentBlockHash, 'system', 'events')).toArray();

        const filteredEvents = events.filter(({ event }) =>
          this.blockchainService.api.events.msa.DelegationGranted.is(event) &&
          event.data.providerId.eq(this.configService.getProviderId()));

        if (filteredEvents.length > 0) {
          this.logger.debug(`Found ${filteredEvents.length} delegations at block #${currentBlockNumber}`);
        }
        const jobs = filteredEvents.map(async ({event}) => {
          const { key: jobId, data } = createGraphUpdateJob(event.data.delegatorId, event.data.providerId, UpdateTransitiveGraphs);
          const job = await this.graphUpdateQueue.getJob(jobId);
          if (job && (await job.isCompleted() || await job.isFailed())) {
            await job.retry();
          } else {
            await this.graphUpdateQueue.add(`graphUpdate:${data.dsnpId}`, data, { jobId });
          }
        });

        // eslint-disable-next-line no-await-in-loop
        await Promise.all(jobs);
        // eslint-disable-next-line no-await-in-loop
        await this.saveProgress(currentBlockNumber);

        // Move to the next block
        currentBlockNumber += 1n;
        // eslint-disable-next-line no-await-in-loop
        currentBlockHash = await this.blockchainService.getBlockHash(currentBlockNumber);
        // eslint-disable-next-line no-await-in-loop
        queueSize = await this.graphUpdateQueue.count();
      }

      if (currentBlockHash.isEmpty) {
        this.logger.log(`Scan reached end-of-chain at block ${currentBlockNumber - 1n}`);
      } else if (queueSize > this.configService.getQueueHighWater()) {
        this.logger.log('Queue soft limit reached; pausing scan until next iteration');
      }
    } catch (e) {
      this.logger.error(JSON.stringify(e));
      throw e;
    } finally {
      this.scanInProgress = false;
    }
  }

  private async saveProgress(blockNumber: bigint): Promise<void> {
    await this.setLastSeenBlockNumber(blockNumber);
  }

  public async getLastSeenBlockNumber(): Promise<bigint> {
    return BigInt(((await this.cacheManager.get(LAST_SEEN_BLOCK_NUMBER_KEY)) ?? 0).toString());
  }

  private async setLastSeenBlockNumber(b: bigint): Promise<void> {
    await this.cacheManager.set(LAST_SEEN_BLOCK_NUMBER_KEY, b.toString());
  }
}
