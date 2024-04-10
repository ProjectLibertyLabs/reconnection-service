import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { BlockHash } from '@polkadot/types/interfaces';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SchedulerRegistry } from '@nestjs/schedule';
import { MILLISECONDS_PER_SECOND, SECONDS_PER_MINUTE } from 'time-constants';
import { ConfigService } from './config/config.service';
import { UpdateTransitiveGraphs, createGraphUpdateJob } from './interfaces/graph-update-job.interface';
import { BlockchainService } from './blockchain/blockchain.service';
import { BlockchainScannerService } from './blockchain-scanner.service';
import { ReconnectionCacheMgrService } from './cache/reconnection-cache-mgr.service';

@Injectable()
export class GraphUpdateScannerService extends BlockchainScannerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly QUEUE_HIGH_WATER_MARK: number;

  async onApplicationBootstrap() {
    // Set up recurring interval
    const interval = setInterval(() => this.scan(), this.configService.getBlockchainScanIntervalMinutes() * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND);
    this.schedulerRegistry.addInterval('blockchainScan', interval);

    // Kick off initial scan
    const initialTimeout = setTimeout(() => this.scan(), 0);
    this.schedulerRegistry.addTimeout('initialScan', initialTimeout);
  }

  async onApplicationShutdown(signal?: string | undefined) {
    if (this.schedulerRegistry.doesExist('timeout', 'initialScan')) {
      this.schedulerRegistry.deleteTimeout('initialScan');
    }

    if (this.schedulerRegistry.doesExist('interval', 'blockchainScan')) {
      this.schedulerRegistry.deleteInterval('blockchainScan');
    }

    super.onApplicationShutdown(signal);
  }

  constructor(
    cacheManager: ReconnectionCacheMgrService,
    @InjectQueue('graphUpdateQueue') private graphUpdateQueue: Queue,
    private readonly configService: ConfigService,
    private schedulerRegistry: SchedulerRegistry,
    blockchainService: BlockchainService,
  ) {
    super(cacheManager, blockchainService, new Logger(GraphUpdateScannerService.name));
    this.QUEUE_HIGH_WATER_MARK = Number(this.configService.getQueueHighWater());
  }

  protected async checkInitialScanParameters(): Promise<boolean> {
    const queueSize = await this.graphUpdateQueue.count();
    if (queueSize > 0) {
      this.logger.log('Deferring next blockchain scan until queue is empty');
      return false;
    }

    return true;
  }

  protected async checkScanParameters(): Promise<boolean> {
    const queueSize = await this.graphUpdateQueue.count();
    if (queueSize >= this.QUEUE_HIGH_WATER_MARK) {
      this.logger.log('Queue soft limit reached; pausing scan until next iteration');
      return false;
    }

    return true;
  }

  protected async processCurrentBlock(currentBlockHash: BlockHash, currentBlockNumber: number): Promise<void> {
    const events = (await this.blockchainService.queryAt(currentBlockHash, 'system', 'events')).toArray();

    const filteredEvents = events.filter(
      ({ event }) => this.blockchainService.api.events.msa.DelegationGranted.is(event) && event.data.providerId.eq(this.configService.getProviderId()),
    );

    if (filteredEvents.length > 0) {
      this.logger.debug(`Found ${filteredEvents.length} delegations at block #${currentBlockNumber}`);
    }
    const jobs = filteredEvents.map(async ({ event }) => {
      const { key: jobId, data } = createGraphUpdateJob(event.data.delegatorId, event.data.providerId, UpdateTransitiveGraphs);
      const job = await this.graphUpdateQueue.getJob(jobId);
      if (job && ((await job.isCompleted()) || (await job.isFailed()))) {
        await job.retry();
      } else {
        await this.graphUpdateQueue.add(`graphUpdate:${data.dsnpId}`, data, { jobId });
      }
    });

    // eslint-disable-next-line no-await-in-loop
    await Promise.all(jobs);
  }
}
