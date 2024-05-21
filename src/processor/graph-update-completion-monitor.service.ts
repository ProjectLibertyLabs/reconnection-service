import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { MILLISECONDS_PER_SECOND } from 'time-constants';
import { BlockchainService } from '#app/blockchain/blockchain.service';
import * as BlockchainConstants from '#app/blockchain/blockchain-constants';
import { BlockchainScannerService } from '#app/blockchain-scanner.service';
import { SchedulerRegistry } from '@nestjs/schedule';
import { BlockHash, Event } from '@polkadot/types/interfaces';
import { HexString } from '@polkadot/util/types';
import { ReconnectionCacheMgrService } from '#app/cache/reconnection-cache-mgr.service';
import { ITxStatus } from '#app/interfaces/tx-status.interface';
import * as ReconnectionServiceConstants from '#app/constants';

@Injectable()
export class GraphUpdateCompletionMonitorService extends BlockchainScannerService implements OnApplicationBootstrap, OnApplicationShutdown {
  async onApplicationBootstrap() {
    //const pendingTxns = await this.cacheManager.getAllPendingTxns();
    // If no transactions pending, skip to end of chain at startup
    // if (Object.keys(pendingTxns).length === 0) {
    //   const blockNumber = await this.blockchainService.getLatestFinalizedBlockNumber();
    //   await this.setLastSeenBlockNumber(blockNumber);
    // }
    this.schedulerRegistry.addInterval(
      `${this.constructor.name}:blockchainScan`,
      setInterval(() => this.scan(), BlockchainConstants.SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND),
    );

    await super.onApplicationBootstrap();
  }

  async onApplicationShutdown(signal?: string | undefined) {
    if (this.schedulerRegistry.doesExist('interval', `${this.constructor.name}:blockchainScan`)) {
      this.schedulerRegistry.deleteInterval(`${this.constructor.name}:blockchainScan`);
    }

    super.onApplicationShutdown(signal);
  }

  constructor(
    cacheManager: ReconnectionCacheMgrService,
    private readonly schedulerRegistry: SchedulerRegistry,
    blockchainService: BlockchainService,
    private readonly cacheService: ReconnectionCacheMgrService,
  ) {
    super(cacheManager, blockchainService, new Logger(GraphUpdateCompletionMonitorService.name));
  }

  private getTxStatus(txStatus: ITxStatus, hasSuccess: boolean, failureEvent: Event | undefined): ITxStatus {
    const newStatus = { ...txStatus };
    if (failureEvent && this.blockchainService.apiPromise.events.system.ExtrinsicFailed.is(failureEvent)) {
      if (hasSuccess) {
        this.logger.warn(`Events for tx ${newStatus.txHash} include both success and failure ???`);
      }
      const { asModule: moduleThatErrored, registry } = failureEvent.data.dispatchError;
      const moduleError = registry.findMetaError(moduleThatErrored);
      newStatus.error = moduleError.method;
      newStatus.status = 'failed';
    } else if (hasSuccess) {
      newStatus.status = 'success';
    } else {
      this.logger.error(`Tx hash ${newStatus.txHash} found in block, but neither success nor failure`);
      // No change in status
    }

    return newStatus;
  }

  async processCurrentBlock(currentBlockHash: BlockHash, currentBlockNumber: number): Promise<void> {
    // Get set of tx hashes to monitor from cache
    let pendingTxns = await this.cacheService.getAllPendingTxns();

    const block = await this.blockchainService.getBlock(currentBlockHash);
    const extrinsicIndices: [HexString, number][] = [];
    block.block.extrinsics.forEach((extrinsic, index) => {
      if (Object.keys(pendingTxns).some((txHash) => txHash === extrinsic.hash.toHex())) {
        extrinsicIndices.push([extrinsic.hash.toHex(), index]);
      }
    });

    if (extrinsicIndices.length > 0) {
      const at = await this.blockchainService.apiPromise.at(currentBlockHash);
      const epoch = (await at.query.capacity.currentEpoch()).toNumber();
      const events = (await at.query.system.events()).filter(({ phase }) => phase.isApplyExtrinsic && extrinsicIndices.some((index) => phase.asApplyExtrinsic.eq(index)));

      const totalCapacityWithdrawn: bigint = events
        .filter(({ event }) => at.events.capacity.CapacityWithdrawn.is(event))
        .reduce((sum, { event }) => (event as unknown as any).data.amount.toBigInt() + sum, 0n);

      // eslint-disable-next-line no-restricted-syntax
      for (const [txHash, txIndex] of extrinsicIndices) {
        const extrinsicEvents = events.filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(txIndex));
        const hasSuccess = extrinsicEvents.some(({ event }) => at.events.utility.BatchCompleted.is(event));
        const failureEvent = extrinsicEvents.find(({ event }) => at.events.system.ExtrinsicFailed.is(event))?.event;

        // eslint-disable-next-line no-await-in-loop
        await this.cacheService.upsertWatchedTxns(this.getTxStatus(pendingTxns[txHash], hasSuccess, failureEvent));
      }

      await this.setEpochCapacity(epoch, totalCapacityWithdrawn);
    }

    // Now check all pending transactions for expiration as of this block
    pendingTxns = await this.cacheService.getAllPendingTxns();
    // eslint-disable-next-line no-restricted-syntax
    for (const txStatus of Object.values(pendingTxns)) {
      if (txStatus.death <= currentBlockNumber) {
        txStatus.status = 'expired';
        this.logger.verbose(`Tx ${txStatus.txHash} expired (birth: ${txStatus.birth}, death: ${txStatus.death}, currentBlock: ${currentBlockNumber})`);
        // eslint-disable-next-line no-await-in-loop
        await this.cacheService.upsertWatchedTxns(txStatus);
      }
    }
    await this.blockchainService.checkCapacity();
  }

  private async setEpochCapacity(epoch: number, capacityWithdrawn: bigint): Promise<void> {
    const epochCapacityKey = `${ReconnectionServiceConstants.EPOCH_CAPACITY_PREFIX}${epoch}`;

    try {
      const savedCapacity = await this.cacheManager.redis.get(epochCapacityKey);
      const epochCapacity = BigInt(savedCapacity ?? 0);
      const newEpochCapacity = epochCapacity + capacityWithdrawn;

      const epochDurationBlocks = await this.blockchainService.getCurrentEpochLength();
      const epochDuration = epochDurationBlocks * BlockchainConstants.SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND;
      await this.cacheManager.redis.setex(epochCapacityKey, epochDuration, newEpochCapacity.toString());
    } catch (error) {
      this.logger.error(`Error setting epoch capacity: ${error}`);
    }
  }
}
