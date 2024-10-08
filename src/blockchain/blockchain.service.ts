/* eslint-disable no-underscore-dangle */
import { ConfigService } from '#app/config/config.service';
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { options } from '@frequency-chain/api-augment';
import { firstValueFrom } from 'rxjs';
import { KeyringPair } from '@polkadot/keyring/types';
import { BlockHash, BlockNumber, Index, SignedBlock } from '@polkadot/types/interfaces';
import { SubmittableExtrinsic } from '@polkadot/api/types';
import { AnyNumber, ISubmittableResult } from '@polkadot/types/types';
import { u32, Option } from '@polkadot/types';
import { PalletCapacityCapacityDetails, PalletCapacityEpochInfo } from '@polkadot/types/lookup';
import { HexString } from '@polkadot/util/types';
import { ReconnectionCacheMgrService } from '#app/cache/reconnection-cache-mgr.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as ReconnectionServiceConstants from '#app/constants';
import { Extrinsic } from './extrinsic';
import { ICapacityLimit } from '#app/interfaces/capacity-limit.interface';
import { ApiPromise, ApiRx, HttpProvider, WsProvider } from '@polkadot/api';

interface ICapacityInfo {
  providerId: string;
  currentBlockNumber: number;
  nextEpochStart: number;
  remainingCapacity: bigint;
  totalCapacityIssued: bigint;
  currentEpoch: number;
}

@Injectable()
export class BlockchainService implements OnApplicationBootstrap, OnApplicationShutdown {
  public api: ApiRx;

  public apiPromise: ApiPromise;

  private readonly logger: Logger;

  private lastCapacityUsedCheck: bigint;

  public async onApplicationBootstrap() {
    const providerUrl = this.configService.frequencyUrl;
    let provider: WsProvider | HttpProvider;
    if (/^ws/.test(providerUrl.toString())) {
      provider = new WsProvider(providerUrl.toString());
    } else if (/^http/.test(providerUrl.toString())) {
      provider = new HttpProvider(providerUrl.toString());
    } else {
      this.logger.error(`Unrecognized chain URL type: ${providerUrl.toString()}`);
      throw new Error('Unrecognized chain URL type');
    }
    this.api = await firstValueFrom(ApiRx.create({ provider, ...options }));
    this.apiPromise = await ApiPromise.create({ provider, ...options });
    await Promise.all([firstValueFrom(this.api.isReady), this.apiPromise.isReady]);
    this.logger.log('Blockchain API ready.');
  }

  public async onApplicationShutdown(_signal?: string | undefined) {
    const promises: Promise<void>[] = [];
    if (this.api) {
      promises.push(this.api.disconnect());
    }

    if (this.apiPromise) {
      promises.push(this.apiPromise.disconnect());
    }
    await Promise.all(promises);
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly cacheManager: ReconnectionCacheMgrService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.configService = configService;
    this.logger = new Logger(this.constructor.name);
  }

  public getBlockHash(block: BlockNumber | AnyNumber): Promise<BlockHash> {
    return this.apiPromise.rpc.chain.getBlockHash(block);
  }

  public async getBlockNumberForHash(hash: string): Promise<number | undefined> {
    const block = await this.apiPromise.rpc.chain.getBlock(hash);
    if (block) {
      return block.block.header.number.toNumber();
    }

    this.logger.error(`No block found corresponding to hash ${hash}`);
    return undefined;
  }

  public createType(type: string, ...args: (any | undefined)[]) {
    return this.api.registry.createType(type, ...args);
  }

  public createExtrinsicCall({ pallet, extrinsic }: { pallet: string; extrinsic: string }, ...args: (any | undefined)[]): SubmittableExtrinsic<'rxjs', ISubmittableResult> {
    return this.api.tx[pallet][extrinsic](...args);
  }

  public createExtrinsic(
    { pallet, extrinsic }: { pallet: string; extrinsic: string },
    { eventPallet, event }: { eventPallet?: string; event?: string },
    keys: KeyringPair,
    ...args: (any | undefined)[]
  ): Extrinsic {
    const targetEvent = eventPallet && event ? this.api.events[eventPallet][event] : undefined;
    return new Extrinsic(this.api, this.api.tx[pallet][extrinsic](...args), keys, targetEvent, this.configService.getFrequencyTxTimeoutSeconds());
  }

  public rpc(pallet: string, rpc: string, ...args: (any | undefined)[]): Promise<any> {
    return this.apiPromise.rpc[pallet][rpc](...args);
  }

  public query(pallet: string, extrinsic: string, ...args: (any | undefined)[]): Promise<any> {
    return args ? this.apiPromise.query[pallet][extrinsic](...args) : this.apiPromise.query[pallet][extrinsic]();
  }

  public async queryAt(blockHash: BlockHash, pallet: string, extrinsic: string, ...args: (any | undefined)[]): Promise<any> {
    const newApi = await this.apiPromise.at(blockHash);
    return newApi.query[pallet][extrinsic](...args);
  }

  public async capacityInfo(providerId: string): Promise<ICapacityInfo> {
    try {
      const providerU64 = this.apiPromise.createType('u64', providerId);
      const { epochStart }: PalletCapacityEpochInfo = await this.query('capacity', 'currentEpochInfo');
      const epochBlockLength: u32 = await this.query('capacity', 'epochLength');
      const capacityDetailsOption = await this.query('capacity', 'capacityLedger', providerU64);
      const { remainingCapacity, totalCapacityIssued } = capacityDetailsOption.unwrapOr({ remainingCapacity: 0, totalCapacityIssued: 0 });
      const currentBlock: u32 = await this.query('system', 'number');
      const currentEpoch = await this.getCurrentCapacityEpoch();
      return {
        currentEpoch,
        providerId,
        currentBlockNumber: currentBlock.toPrimitive() as number,
        nextEpochStart: epochStart.add(epochBlockLength).toNumber(),
        remainingCapacity: typeof remainingCapacity === 'number' ? BigInt(remainingCapacity) : remainingCapacity.toBigInt(),
        totalCapacityIssued: typeof totalCapacityIssued === 'number' ? BigInt(totalCapacityIssued) : totalCapacityIssued.toBigInt(),
      };
    } catch (err: any) {
      this.logger.error('Error in capacityInfo: ', err?.stack);
      throw err;
    }
  }

  public async getCurrentCapacityEpoch(): Promise<number> {
    const currentEpoch: u32 = await this.query('capacity', 'currentEpoch');
    return currentEpoch.toPrimitive() as number;
  }

  public async getCurrentEpochLength(): Promise<number> {
    const epochLength: u32 = await this.query('capacity', 'epochLength');
    return typeof epochLength === 'number' ? epochLength : epochLength.toPrimitive() as number;
  }

  public async getNonce(account: Uint8Array): Promise<Index> {
    return this.rpc('system', 'accountNextIndex', account);
  }

  public async getBlock(block: BlockHash | HexString): Promise<SignedBlock> {
    return (await this.apiPromise.rpc.chain.getBlock(block)) as SignedBlock;
  }

  public async getLatestFinalizedBlockNumber(): Promise<number> {
    return (await this.apiPromise.rpc.chain.getBlock()).block.header.number.toNumber();
  }

  public async getLatestFinalizedBlockHash(): Promise<BlockHash> {
    return (await this.apiPromise.rpc.chain.getFinalizedHead()) as BlockHash;
  }

  private checkTotalCapacityLimit(capacityInfo: ICapacityInfo, totalLimit: ICapacityLimit): boolean {
    const { remainingCapacity, totalCapacityIssued } = capacityInfo;
    const totalCapacityUsed = totalCapacityIssued - remainingCapacity;
    let outOfCapacity = false;

    let limit = totalLimit.value;
    if (totalLimit.type === 'percentage') {
      limit = (totalCapacityIssued * totalLimit.value) / 100n;
    }
    outOfCapacity = totalCapacityUsed >= limit;

    if (outOfCapacity) {
      this.logger.warn(`Total capacity usage limit reached: used ${totalCapacityUsed} of ${totalCapacityIssued}`);
    }

    return outOfCapacity;
  }

  private async checkServiceCapacityLimit(capacityInfo: ICapacityInfo, serviceLimit: ICapacityLimit): Promise<boolean> {
    const { remainingCapacity, totalCapacityIssued, currentEpoch } = capacityInfo;
    let limit = serviceLimit.value;
    if (serviceLimit.type === 'percentage') {
      limit = (totalCapacityIssued * serviceLimit.value) / 100n;
    }

    const epochCapacityKey = `${ReconnectionServiceConstants.EPOCH_CAPACITY_PREFIX}${currentEpoch}`;
    const epochUsedCapacity = BigInt((await this.cacheManager.redis.get(epochCapacityKey)) ?? 0); // Fetch capacity used by the service

    const outOfCapacity = epochUsedCapacity >= limit;

    if (outOfCapacity) {
      this.logger.warn(`Capacity threshold reached: used ${epochUsedCapacity} of ${serviceLimit}`);
    } else if (this.lastCapacityUsedCheck !== epochUsedCapacity) {
      // Minimum with bigints
      const serviceRemaining = remainingCapacity > limit - epochUsedCapacity ? limit - epochUsedCapacity : remainingCapacity;
      this.logger.verbose(`Capacity usage: ${epochUsedCapacity} of ${serviceLimit} (${serviceRemaining} remaining)`);
      this.lastCapacityUsedCheck = epochUsedCapacity;
    }

    return outOfCapacity;
  }

  public async checkCapacity(): Promise<void> {
    try {
      const capacityLimit = this.configService.getCapacityLimit();
      const capacity = await this.capacityInfo(this.configService.getProviderId());

      // This doesn't really pick up on capacity exhaustion, as usage is unlikely to bring capacity to zero
      // (there will always be some dust). But it will warn in the case where a provider has been completely un-staked
      // (or they're using the wrong keypair in the config, one with no capacity, etc...)
      if (capacity.remainingCapacity <= 0n) {
        this.logger.warn(`No capacity!`);
      }

      const totalLimitExceeded = capacityLimit.totalLimit ? this.checkTotalCapacityLimit(capacity, capacityLimit.totalLimit) : false;
      const serviceLimitExceeded = await this.checkServiceCapacityLimit(capacity, capacityLimit.serviceLimit);

      const outOfCapacity = capacity.remainingCapacity <= 0n || serviceLimitExceeded || totalLimitExceeded;

      if (outOfCapacity) {
        await this.eventEmitter.emitAsync('capacity.exhausted');
      } else {
        await this.eventEmitter.emitAsync('capacity.available');
      }
    } catch (err: any) {
      this.logger.error('Caught error in checkCapacity', err?.stack);
    }
  }
}
