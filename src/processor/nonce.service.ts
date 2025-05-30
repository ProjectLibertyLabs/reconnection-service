import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import fs from 'fs';
import { ReconnectionCacheMgrService } from '#app/cache/reconnection-cache-mgr.service';
import { createKeys } from '#app/blockchain/create-keys';
import * as CacheUtils from '#app/cache/cache-utils';
import { BlockchainService } from '#app/blockchain/blockchain.service';
import { ConfigService } from '#app/config/config.service';
import { getKeyringPairFromSecp256k1PrivateKey, getUnifiedPublicKey } from '@frequency-chain/ethereum-utils';
import { hexToU8a, u8aToHex } from '@polkadot/util';

@Injectable()
export class NonceService implements OnApplicationBootstrap {
  private logger: Logger;

  private accountId: Uint8Array;
  private ethereumAccountId: Uint8Array;

  constructor(
    private cacheService: ReconnectionCacheMgrService,
    private blockchainService: BlockchainService,
    private configService: ConfigService,
  ) {
    this.logger = new Logger(NonceService.name);
    cacheService.redis.defineCommand('incrementNonce', {
      numberOfKeys: CacheUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK,
      lua: fs.readFileSync('lua/incrementNonce.lua', 'utf8'),
    });
    cacheService.redis.defineCommand('peekNonce', {
      numberOfKeys: CacheUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK,
      lua: fs.readFileSync('lua/peekNonce.lua', 'utf-8'),
    });
  }

  // tries to use the ethereum key first and uses the legacy account as a backup
  getPreferredAccountId(): Uint8Array {
    return this.ethereumAccountId && this.ethereumAccountId.length > 0 ? this.ethereumAccountId : this.accountId;
  }

  async onApplicationBootstrap() {
    this.accountId = createKeys(this.configService.getProviderAccountSeedPhrase()).publicKey;
    const ethereumKeySecret = this.configService.getEthereumProviderAccountPrivateKey();
    if (ethereumKeySecret?.length) {
      this.ethereumAccountId = getUnifiedPublicKey(getKeyringPairFromSecp256k1PrivateKey(hexToU8a(ethereumKeySecret)));
    }
    const nextNonce = await this.peekNextNonce();
    this.logger.log(`Initialized nonce to ${nextNonce}`);
  }

  async peekNextNonce(): Promise<number> {
    const accountId = this.getPreferredAccountId();
    const nonceNumber = (await this.blockchainService.getNonce(accountId)).toNumber();
    const keys = this.getNextPossibleKeys(nonceNumber);
    // @ts-expect-error peekNonce is a custom command
    const nextNonceIndex = await this.cacheService.redis.peekNonce(...keys, keys.length);
    if (nextNonceIndex === -1) {
      this.logger.warn(`nextNonce was full even with ${CacheUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK} ${nonceNumber}`);
      return nonceNumber + CacheUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK;
    }
    const nextNonce = nonceNumber + nextNonceIndex - 1;
    this.logger.debug(`nextNonce ${nextNonce}`);
    return nextNonce;
  }

  async getNextNonce(): Promise<number> {
    const accountId = this.getPreferredAccountId();
    const nonceNumber = (await this.blockchainService.getNonce(accountId)).toNumber();
    const keys = this.getNextPossibleKeys(nonceNumber);
    // @ts-expect-error incrementNonce is a custom command
    const nextNonceIndex = await this.cacheService.redis.incrementNonce(...keys, keys.length, CacheUtils.NONCE_KEY_EXPIRE_SECONDS);
    if (nextNonceIndex === -1) {
      this.logger.warn(`nextNonce was full even with ${CacheUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK} ${nonceNumber}`);
      return nonceNumber + CacheUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK;
    }
    const nextNonce = nonceNumber + nextNonceIndex - 1;
    this.logger.debug(`nextNonce ${nextNonce}`);
    return nextNonce;
  }

  // eslint-disable-next-line class-methods-use-this
  getNextPossibleKeys(currentNonce: number): string[] {
    const keys: string[] = Array(CacheUtils.NUMBER_OF_NONCE_KEYS_TO_CHECK)
      .fill(null)
      .map((_entry, i) => CacheUtils.getNonceKey(`${currentNonce + i}`));
    return keys;
  }
}
