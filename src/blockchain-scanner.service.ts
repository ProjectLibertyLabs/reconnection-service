import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { options } from '@frequency-chain/api-augment';
import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api';
import { BlockHash } from '@polkadot/types/interfaces';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SchedulerRegistry } from '@nestjs/schedule';
import { MILLISECONDS_PER_SECOND, SECONDS_PER_MINUTE } from 'time-constants';
import { InjectRedis } from '@liaoliaots/nestjs-redis';
import Redis from 'ioredis';
import { MessageSourceId, ProviderId } from '@frequency-chain/api-augment/interfaces';
import { ConfigService } from './config/config.service';
import { createGraphUpdateJob } from './interfaces/graph-update-job.interface';

const LAST_SEEN_BLOCK_NUMBER_KEY = 'lastSeenBlockNumber';

@Injectable()
export class BlockchainScannerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private api: ApiPromise;

  private logger: Logger;

  private scanInProgress = false;

  async onApplicationBootstrap() {
    const providerUrl = this.configService.frequencyUrl!;
    let provider: any;
    if (/^ws/.test(providerUrl.toString())) {
      provider = new WsProvider(providerUrl.toString());
    } else if (/^http/.test(providerUrl.toString())) {
      provider = new HttpProvider(providerUrl.toString());
    } else {
      this.logger.error(`Unrecognized chain URL type: ${providerUrl.toString()}`);
      throw new Error('Unrecognized chain URL type');
    }
    this.api = await ApiPromise.create({ provider, ...options });
    await this.api.isReady;
    this.logger.log('Blockchain API ready.');

    // Set up recurring interval
    const interval = setInterval(() => this.scan(), this.configService.getBlockchainScanIntervalMinutes() * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND);
    this.schedulerRegistry.addInterval('blockchainScan', interval);

    // Kick off initial scan
    const initialTimeout = setTimeout(() => this.scan(), 0);
    this.schedulerRegistry.addTimeout('initialScan', initialTimeout);
  }

  async onApplicationShutdown() {
    await this.api.disconnect();
  }

  constructor(
    @InjectRedis() private cacheManager: Redis,
    @InjectQueue('graphUpdateQueue') private graphUpdateQueue: Queue,
    private readonly configService: ConfigService,
    private schedulerRegistry: SchedulerRegistry,
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
      currentBlockHash = await this.getBlockHashForBlock(currentBlockNumber);

      this.logger.log(`Starting scan from block #${currentBlockNumber} (${currentBlockHash})`);

      while (!currentBlockHash.isEmpty && queueSize < this.configService.getQueueHighWater()) {
        this.logger.debug(`Processing block #${currentBlockNumber} ${currentBlockHash.toHuman()}`);
        // eslint-disable-next-line no-await-in-loop
        const currentApi = await this.api.at(currentBlockHash);
        // eslint-disable-next-line no-await-in-loop
        const events = (await currentApi.query.system.events()).toArray();
        const filteredEvents = events.reduce((jobs: Promise<any>[], { event }) => {
          if (this.api.events.msa.DelegationGranted.is(event)) {
            const { key: jobId, data } = createGraphUpdateJob(event.data.delegatorId, event.data.providerId);
            jobs.push(this.graphUpdateQueue.add('graphUpdate', data, { jobId }));
            this.logger.debug(`Queued graph update for DSNP user ${data.dsnpId}, provider ${data.providerId}`);
          }
          return jobs;
        }, []);

        this.logger.debug(`Found ${filteredEvents.length} delegations at block #${currentBlockNumber}`);
        // eslint-disable-next-line no-await-in-loop
        await Promise.all(filteredEvents);
        // eslint-disable-next-line no-await-in-loop
        await this.saveProgress(currentBlockNumber);

        // Move to the next block
        currentBlockNumber += 1n;
        // eslint-disable-next-line no-await-in-loop
        currentBlockHash = await this.getBlockHashForBlock(currentBlockNumber);
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

  public async getBlockNumberForHash(hash: string): Promise<number | undefined> {
    const block = await this.api.rpc.chain.getBlock(hash);
    if (block) {
      this.logger.debug(`Retrieved block number (${block.block.header.number.toNumber()} for hash ${hash})`);
      return block.block.header.number.toNumber();
    }

    this.logger.error(`No block found corresponding to hash ${hash}`);
    return undefined;
  }

  private getBlockHashForBlock(n: bigint): Promise<BlockHash> {
    return this.api.rpc.chain.getBlockHash(n);
  }
}
