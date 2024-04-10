import { Logger } from '@nestjs/common';
import { BlockHash } from '@polkadot/types/interfaces';
import { OnQueueEvent, QueueEventsHost, QueueEventsListener } from '@nestjs/bullmq';
import { BlockchainService } from './blockchain/blockchain.service';
import { ReconnectionCacheMgrService } from './cache/reconnection-cache-mgr.service';

export const LAST_SEEN_BLOCK_NUMBER_KEY = 'lastSeenBlockNumber';

@QueueEventsListener('graphUpdateQueue')
export abstract class BlockchainScannerService extends QueueEventsHost {
  protected scanInProgress = false;

  protected readonly cachePrefix: string | undefined;

  private readonly lastSeenBlockNumberKey: string;

  constructor(
    protected readonly cacheManager: ReconnectionCacheMgrService,
    protected readonly blockchainService: BlockchainService,
    protected readonly logger: Logger,
    options?: { cachePrefix?: string },
  ) {
    super();
    this.cachePrefix = options?.cachePrefix;
    this.lastSeenBlockNumberKey = options?.cachePrefix ? `${options.cachePrefix}:${LAST_SEEN_BLOCK_NUMBER_KEY}` : LAST_SEEN_BLOCK_NUMBER_KEY;
  }

  @OnQueueEvent('drained')
  handleEmptyQueue() {
    this.logger.log('Empty queue; resuming chain scan');
    setTimeout(() => this.scan(), 0);
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

    if (this.scanInProgress) {
      this.logger.log('Scheduled blockchain scan skipped due to previous scan still in progress');
      return;
    }

    // Only scan blocks if initial conditions met
    if (!(await this.checkInitialScanParameters())) {
      this.logger.log('Skipping blockchain scan--initial conditions not met');
      return;
    }

    try {
      this.scanInProgress = true;
      let currentBlockNumber: number;
      let currentBlockHash: BlockHash;

      const lastSeenBlockNumber = await this.getLastSeenBlockNumber();
      currentBlockNumber = lastSeenBlockNumber + 1;
      currentBlockHash = await this.blockchainService.getBlockHash(currentBlockNumber);

      if (!currentBlockHash.some((byte) => byte !== 0)) {
        this.logger.log('No new blocks to read; no scan performed.');
        this.scanInProgress = false;
        return;
      }
      this.logger.log(`Starting scan from block #${currentBlockNumber} (${currentBlockHash})`);

      // eslint-disable-next-line no-await-in-loop
      while (!currentBlockHash.isEmpty && !!(await this.checkScanParameters())) {
        // eslint-disable-next-line no-await-in-loop
        await this.processCurrentBlock(currentBlockHash, currentBlockNumber);
        // eslint-disable-next-line no-await-in-loop
        await this.setLastSeenBlockNumber(currentBlockNumber);

        // Move to the next block
        currentBlockNumber += 1;
        // eslint-disable-next-line no-await-in-loop
        currentBlockHash = await this.blockchainService.getBlockHash(currentBlockNumber);
      }

      if (currentBlockHash.isEmpty) {
        this.logger.log(`Scan reached end-of-chain at block ${currentBlockNumber - 1}`);
      }
    } catch (e) {
      this.logger.error(JSON.stringify(e));
      throw e;
    } finally {
      this.scanInProgress = false;
    }
  }

  public async getLastSeenBlockNumber(): Promise<number> {
    return Number((await this.cacheManager.redis.get(this.lastSeenBlockNumberKey)) ?? 0);
  }

  protected async setLastSeenBlockNumber(b: number): Promise<void> {
    await this.cacheManager.redis.set(this.lastSeenBlockNumberKey, b);
  }

  // eslint-disable-next-line class-methods-use-this
  protected checkInitialScanParameters(): Promise<boolean> {
    return Promise.resolve(true);
  }

  // eslint-disable-next-line class-methods-use-this
  protected checkScanParameters(): Promise<boolean> {
    return Promise.resolve(true);
  }

  protected abstract processCurrentBlock(currentBlockHash: BlockHash, currentBlockNumber: number): Promise<void>;
}
