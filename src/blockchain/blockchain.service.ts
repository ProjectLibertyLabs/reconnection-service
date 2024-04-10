/* eslint-disable no-underscore-dangle */
import { ConfigService } from '#app/config/config.service';
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ApiPromise, ApiRx, HttpProvider, WsProvider } from '@polkadot/api';
import { firstValueFrom } from 'rxjs';
import { options } from '@frequency-chain/api-augment';
import { KeyringPair } from '@polkadot/keyring/types';
import { BlockHash, BlockNumber, DispatchError, Hash, Index, SignedBlock } from '@polkadot/types/interfaces';
import { SubmittableExtrinsic } from '@polkadot/api/types';
import { AnyNumber, Codec, ISubmittableResult, RegistryError } from '@polkadot/types/types';
import { u32, Option, u128 } from '@polkadot/types';
import { PalletCapacityCapacityDetails, PalletCapacityEpochInfo } from '@polkadot/types/lookup';
import { IsEvent } from '@polkadot/types/metadata/decorate/types';
import { HexString } from '@polkadot/util/types';
import { Extrinsic } from './extrinsic';
import { IGraphNotifierResult } from '../interfaces/graph-notifier-result.interface';

@Injectable()
export class BlockchainService implements OnApplicationBootstrap, OnApplicationShutdown {
  public api: ApiRx;

  public apiPromise: ApiPromise;

  private configService: ConfigService;

  private logger: Logger;

  public async onApplicationBootstrap() {
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
    this.api = await firstValueFrom(ApiRx.create({ provider, ...options }));
    this.apiPromise = await ApiPromise.create({ provider, ...options });
    await Promise.all([firstValueFrom(this.api.isReady), this.apiPromise.isReady]);
    this.logger.log('Blockchain API ready.');
  }

  public async onApplicationShutdown(signal?: string | undefined) {
    const promises: Promise<any>[] = [];
    if (this.api) {
      promises.push(this.api.disconnect());
    }

    if (this.apiPromise) {
      promises.push(this.apiPromise.disconnect());
    }
    await Promise.all(promises);
  }

  constructor(configService: ConfigService) {
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

  public async capacityInfo(providerId: string): Promise<{
    providerId: string;
    currentBlockNumber: number;
    nextEpochStart: number;
    remainingCapacity: bigint;
    totalCapacityIssued: bigint;
    currentEpoch: bigint;
  }> {
    try {
      const providerU64 = this.apiPromise.createType('u64', providerId);
      const { epochStart }: PalletCapacityEpochInfo = await this.query('capacity', 'currentEpochInfo');
      const epochBlockLength: u32 = await this.query('capacity', 'epochLength');
      const capacityDetailsOption: Option<PalletCapacityCapacityDetails> = await this.query('capacity', 'capacityLedger', providerU64);
      const { remainingCapacity, totalCapacityIssued } = capacityDetailsOption.unwrapOr({ remainingCapacity: 0, totalCapacityIssued: 0 });
      const currentBlock: u32 = await this.query('system', 'number');
      const currentEpoch = await this.getCurrentCapacityEpoch();
      return {
        currentEpoch,
        providerId,
        currentBlockNumber: currentBlock.toNumber(),
        nextEpochStart: epochStart.add(epochBlockLength).toNumber(),
        remainingCapacity: typeof remainingCapacity === 'number' ? BigInt(remainingCapacity) : remainingCapacity.toBigInt(),
        totalCapacityIssued: typeof totalCapacityIssued === 'number' ? BigInt(totalCapacityIssued) : totalCapacityIssued.toBigInt(),
      };
    } catch (err: any) {
      this.logger.error('Error in capacityInfo: ', err?.stack);
      throw err;
    }
  }

  public async getCurrentCapacityEpoch(): Promise<bigint> {
    const currentEpoch: u32 = await this.query('capacity', 'currentEpoch');
    return typeof currentEpoch === 'number' ? BigInt(currentEpoch) : currentEpoch.toBigInt();
  }

  public async getCurrentEpochLength(): Promise<number> {
    const epochLength: u32 = await this.query('capacity', 'epochLength');
    return typeof epochLength === 'number' ? epochLength : epochLength.toNumber();
  }

  public async getNonce(account: Uint8Array): Promise<Index> {
    return this.rpc('system', 'accountNextIndex', account);
  }

  public async getBlock(block: BlockHash | HexString): Promise<SignedBlock> {
    return (await this.apiPromise.rpc.chain.getBlock(block)) as SignedBlock;
  }

  public async getLatestFinalizedBlockNumber(): Promise<bigint> {
    return (await this.apiPromise.rpc.chain.getBlock()).block.header.number.toBigInt();
  }

  public async getLatestFinalizedBlockHash(): Promise<BlockHash> {
    return (await this.apiPromise.rpc.chain.getFinalizedHead()) as BlockHash;
  }

  public async checkBlockForTxns<C extends Codec[] = Codec[], N = unknown>(
    txHashes: HexString[],
    blockList: bigint[],
    successEvents: [IsEvent<C, N>],
  ): Promise<IGraphNotifierResult> {
    let rollupResult: IGraphNotifierResult = { found: false, success: false };
    const txReceiptPromises: Promise<IGraphNotifierResult>[] = blockList.map(async (blockNumber) => {
      const result: IGraphNotifierResult = { found: false, success: false };
      const blockHash = await this.getBlockHash(blockNumber);
      const block = await this.getBlock(blockHash);
      const extrinsicIndices: number[] = [];
      block.block.extrinsics.forEach((extrinsic, index) => {
        if (txHashes.some((txHash) => extrinsic.hash.toHex() === txHash)) {
          extrinsicIndices.push(index);
        }
      });

      if (extrinsicIndices.length === 0) {
        return result;
      }

      this.logger.verbose(`Found tx ${txHashes} in block ${blockNumber}`);
      const at = await this.apiPromise.at(blockHash.toHex());
      const eventsPromise = at.query.system.events();

      result.blockHash = blockHash;
      result.found = true;
      result.capacityWithdrawn = 0n;
      try {
        // Filter to make sure we only process events for this transaction
        const allEvents = await eventsPromise;
        this.logger.debug('ALL EVENTS:');
        const events = allEvents.filter(({ phase }) => phase.isApplyExtrinsic && extrinsicIndices.some((index) => phase.asApplyExtrinsic.eq(index)));
        this.logger.debug(`Found ${events.length} filtered events`);
        events.forEach((e) => this.logger.debug(e.toHuman()));
        result.capacityEpoch = (await at.query.capacity.currentEpoch()).toNumber();

        const capacityAmounts: bigint[] = events
          .filter(({ event }) => this.api.events.capacity.CapacityWithdrawn.is(event))
          .map(({ event }) => (event as unknown as any).data.amount.toBigInt());
        const successes = events.filter(({ event }) => successEvents.some((successEvent) => successEvent.is(event))) ?? [];
        const firstFailure = events.find(({ event }) => this.api.events.system.ExtrinsicFailed.is(event));

        // Get total capacity withdrawn
        result.capacityWithdrawn = capacityAmounts.reduce((prev, current) => prev + current, 0n);

        if (firstFailure && this.api.events.system.ExtrinsicFailed.is(firstFailure.event)) {
          const { asModule: moduleThatErrored, registry } = firstFailure.event.data.dispatchError;
          const moduleError = registry.findMetaError(moduleThatErrored);
          result.error = moduleError;
          this.logger.error(`Extrinsic failed with error: ${JSON.stringify(moduleError)}`);
        } else if (successes.length === extrinsicIndices.length) {
          result.success = true;
        }
      } catch (error) {
        this.logger.error(error);
      }
      this.logger.debug(`Total capacity withdrawn for this extrinsic: ${result.capacityWithdrawn.toString()}`);
      return result;
    });
    const results = await Promise.all(txReceiptPromises);
    this.logger.debug('Results: ', results);
    const errorResult = results.find((r) => !!r.error);
    const successes = results.filter((r) => r.success);

    if (errorResult) {
      rollupResult = errorResult;
    } else if (successes.length > 0) {
      const capacityEpoch = Math.max(...successes.map((s) => s.capacityEpoch ?? 0));
      const { found, success } = successes[0];
      const capacityWithdrawn = successes.reduce((prev, curr) => {
        if (curr.capacityEpoch === capacityEpoch) {
          return prev + (curr.capacityWithdrawn ?? 0n);
        }
        return prev;
      }, 0n);

      rollupResult = {
        found,
        success,
        capacityEpoch,
        capacityWithdrawn,
      };
    }

    return rollupResult;
  }
}
