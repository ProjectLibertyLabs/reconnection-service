import { InjectRedis } from '@liaoliaots/nestjs-redis';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import Redis from 'ioredis';
import fs from 'fs';
import { createKeys } from '../blockchain/create-keys';
import { RedisUtils } from '../utils/redis';
import { BlockchainService } from '../blockchain/blockchain.service';
import { ConfigService } from '../config/config.service';

@Injectable()
export class NonceService implements OnApplicationBootstrap {
  private logger: Logger;

  private accountId: Uint8Array;

  constructor(
    @InjectRedis() private redis: Redis,
    private blockchainService: BlockchainService,
    private configService: ConfigService,
  ) {
    this.logger = new Logger(NonceService.name);
    redis.defineCommand('incrementNonce', {
      numberOfKeys: RedisUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK,
      lua: fs.readFileSync('lua/incrementNonce.lua', 'utf8'),
    });
    redis.defineCommand('peekNonce', {
      numberOfKeys: RedisUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK,
      lua: fs.readFileSync('lua/peekNonce.lua', 'utf-8'),
    });
  }

  async onApplicationBootstrap() {
    this.accountId = createKeys(this.configService.getProviderAccountSeedPhrase()).publicKey;
    const nextNonce = await this.peekNextNonce();
    this.logger.log(`Initialized nonce to ${nextNonce}`);
  }

  async peekNextNonce(): Promise<number> {
    const nonceNumber = (await this.blockchainService.getNonce(this.accountId)).toNumber();
    const keys = this.getNextPossibleKeys(nonceNumber);
    // @ts-ignore
    const nextNonceIndex = await this.redis.peekNonce(...keys, keys.length);
    if (nextNonceIndex === -1) {
      this.logger.warn(`nextNonce was full even with ${RedisUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK} ${nonceNumber}`);
      return nonceNumber + RedisUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK;
    }
    const nextNonce = nonceNumber + nextNonceIndex - 1;
    this.logger.debug(`nextNonce ${nextNonce}`);
    return nextNonce;
  }

  async getNextNonce(): Promise<number> {
    const nonceNumber = (await this.blockchainService.getNonce(this.accountId)).toNumber();
    const keys = this.getNextPossibleKeys(nonceNumber);
    // @ts-ignore
    const nextNonceIndex = await this.redis.incrementNonce(...keys, keys.length, RedisUtils.NONCE_KEY_EXPIRE_SECONDS);
    if (nextNonceIndex === -1) {
      this.logger.warn(`nextNonce was full even with ${RedisUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK} ${nonceNumber}`);
      return nonceNumber + RedisUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK;
    }
    const nextNonce = nonceNumber + nextNonceIndex - 1;
    this.logger.debug(`nextNonce ${nextNonce}`);
    return nextNonce;
  }

  // eslint-disable-next-line class-methods-use-this
  getNextPossibleKeys(currentNonce: number): string[] {
    const keys: string[] = Array(RedisUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK).fill(null).map((_entry, i) => RedisUtils.getNonceKey(`${currentNonce + i}`));
    return keys;
  }
}
