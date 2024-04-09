import { Logger } from '@nestjs/common';
import { BlockHash } from '@polkadot/types/interfaces';
import Redis from 'ioredis';
import { BlockchainService } from './blockchain/blockchain.service';

export const LAST_SEEN_BLOCK_NUMBER_KEY = 'lastSeenBlockNumber';

export abstract class BlockchainScannerService {
  protected readonly cacheManager: Redis;

  protected readonly blockchainService: BlockchainService;

  protected readonly logger: Logger;

  protected scanInProgress = false;

  protected readonly cachePrefix: string | undefined;

  private readonly lastSeenBlockNumberKey: string;

  constructor(cacheManager: Redis, blockchainService: BlockchainService, logger: Logger, options?: { cachePrefix?: string }) {
    this.cacheManager = cacheManager;
    this.blockchainService = blockchainService;
    this.logger = logger;

    this.cachePrefix = options?.cachePrefix;
    this.lastSeenBlockNumberKey = options?.cachePrefix ? `${options.cachePrefix}:${LAST_SEEN_BLOCK_NUMBER_KEY}` : LAST_SEEN_BLOCK_NUMBER_KEY;
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

      // Only scan blocks if initial conditions met
      if (!(await this.checkInitialScanParameters())) {
        this.logger.log('Skipping blockchain scan--initial conditions not met');
        return;
      }

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
    return Number((await this.cacheManager.get(this.lastSeenBlockNumberKey)) ?? 0);
  }

  protected async setLastSeenBlockNumber(b: number): Promise<void> {
    await this.cacheManager.set(this.lastSeenBlockNumberKey, b);
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
