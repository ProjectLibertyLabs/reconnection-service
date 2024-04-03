/* eslint-disable no-underscore-dangle */
import { ConfigService } from '#app/config/config.service';
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ApiPromise, ApiRx, HttpProvider, WsProvider } from '@polkadot/api';
import { firstValueFrom } from 'rxjs';
import { options } from '@frequency-chain/api-augment';
import { KeyringPair } from '@polkadot/keyring/types';
import { BlockHash, BlockNumber, DispatchError, Hash, Index, SignedBlock } from '@polkadot/types/interfaces';
import { SubmittableExtrinsic } from '@polkadot/api/types';
import { AnyNumber, ISubmittableResult, RegistryError } from '@polkadot/types/types';
import { u32, Option, u128 } from '@polkadot/types';
import { PalletCapacityCapacityDetails, PalletCapacityEpochInfo } from '@polkadot/types/lookup';
import { Extrinsic } from './extrinsic';

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
    const providerU64 = this.api.createType('u64', providerId);
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

  public getBlock(block: BlockHash): Promise<SignedBlock> {
    return firstValueFrom(this.api.rpc.chain.getBlock(block));
  }

  public async getLatestFinalizedBlockNumber(): Promise<bigint> {
    return (await this.apiPromise.rpc.chain.getBlock()).block.header.number.toBigInt();
  }

  public async getLatestFinalizedBlockHash(): Promise<BlockHash> {
    return (await this.apiPromise.rpc.chain.getFinalizedHead()) as BlockHash;
  }

  public async crawlBlockListForTx(
    txHash: Hash,
    blockList: bigint[],
    successEvents: [{ pallet: string; event: string }],
  ): Promise<{ found: boolean; success: boolean; blockHash?: BlockHash; capacityWithDrawn?: string; error?: RegistryError }> {
    const txReceiptPromises: Promise<{ found: boolean; success: boolean; blockHash?: BlockHash; capacityWithDrawn?: string; error?: RegistryError }>[] = blockList.map(
      async (blockNumber) => {
        const blockHash = await this.getBlockHash(blockNumber);
        const block = await this.getBlock(blockHash);
        const txInfo = block.block.extrinsics.find((extrinsic) => extrinsic.hash.toString() === txHash.toString());

        if (!txInfo) {
          return { found: false, success: false };
        }

        this.logger.verbose(`Found tx ${txHash} in block ${blockNumber}`);
        const at = await this.api.at(blockHash.toHex());
        const eventsPromise = firstValueFrom(at.query.system.events());

        let isTxSuccess = false;
        let totalBlockCapacity: bigint = 0n;
        let txError: RegistryError | undefined;

        try {
          const events = await eventsPromise;

          events.forEach((record) => {
            const { event } = record;
            const eventName = event.section;
            const { method } = event;
            const { data } = event;
            this.logger.debug(`Received event: ${eventName} ${method} ${data}`);

            // find capacity withdrawn event
            if (eventName.search('capacity') !== -1 && method.search('Withdrawn') !== -1) {
              // allow lowercase constructor for eslint
              // eslint-disable-next-line new-cap
              const currentCapacity: u128 = new u128(this.api.registry, data[1]);
              totalBlockCapacity += currentCapacity.toBigInt();
            }

            // check custom success events
            if (successEvents.find((successEvent) => successEvent.pallet === eventName && successEvent.event === method)) {
              this.logger.debug(`Found success event ${eventName} ${method}`);
              isTxSuccess = true;
            }

            // check for system extrinsic failure
            if (eventName.search('system') !== -1 && method.search('ExtrinsicFailed') !== -1) {
              const dispatchError = data[0] as DispatchError;
              const moduleThatErrored = dispatchError.asModule;
              const moduleError = dispatchError.registry.findMetaError(moduleThatErrored);
              txError = moduleError;
              this.logger.error(`Extrinsic failed with error: ${JSON.stringify(moduleError)}`);
            }
          });
        } catch (error) {
          this.logger.error(error);
        }
        this.logger.debug(`Total capacity withdrawn in block: ${totalBlockCapacity.toString()}`);
        return { found: true, success: isTxSuccess, blockHash, capacityWithDrawn: totalBlockCapacity.toString(), error: txError };
      },
    );
    const results = await Promise.all(txReceiptPromises);
    const result = results.find((receipt) => receipt.found);
    this.logger.debug(`Found tx receipt: ${JSON.stringify(result)}`);
    return result ?? { found: false, success: false };
  }
}
