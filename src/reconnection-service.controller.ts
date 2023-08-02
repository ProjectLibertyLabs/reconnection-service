import { Controller, Get, HttpException, HttpStatus, Logger, Param, Post, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BlockchainScannerService, LAST_SEEN_BLOCK_NUMBER_KEY } from './blockchain-scanner.service';
import { ApiKeyGuard } from './apiKey.guard';
import { InjectRedis } from '@liaoliaots/nestjs-redis';
import Redis from 'ioredis';

type JobStatus = 'active' | 'completed' | 'waiting' | 'failed' | 'delayed';

@Controller('reconnection-service')
export class ReconnectionServiceController {
  private readonly logger: Logger;

  constructor(
    private scannerService: BlockchainScannerService, 
    @InjectQueue('graphUpdateQueue') private graphUpdateQueue: Queue,
    @InjectRedis() private cacheManager: Redis
  ) {
    this.logger = new Logger(this.constructor.name);
  }

  // eslint-disable-next-line class-methods-use-this
  @Get('health')
  health() {}

  @Get('queue')
  async queue() {
    return this.graphUpdateQueue.getJobCounts();
  }

  @UseGuards(ApiKeyGuard)
  @Get('queue/:jobstatus')
  async getQueueByStatus(@Param('jobstatus') jobstatus: JobStatus) {
    switch (jobstatus) {
      case 'active':
        return this.graphUpdateQueue.getActive();

      case 'completed':
        return this.graphUpdateQueue.getCompleted();

      case 'delayed':
        return this.graphUpdateQueue.getDelayed();

      case 'failed':
        return this.graphUpdateQueue.getFailed();

      case 'waiting':
        return this.graphUpdateQueue.getWaiting();

      default:
        throw new HttpException('Unrecognized job status', HttpStatus.BAD_REQUEST);
    }
  }

  @UseGuards(ApiKeyGuard)
  @Post('queue/resume')
  async resumeQueue() {
    await this.graphUpdateQueue.resume();
  }

  @UseGuards(ApiKeyGuard)
  @Post('queue/pause')
  async pauseQueue() {
    await this.graphUpdateQueue.pause();
  }

  @UseGuards(ApiKeyGuard)
  @Post('scan/:blockNumber')
  async scanChainFromBlock(@Param('blockNumber') blockNumber: string) {
    const block = BigInt(blockNumber) - 1n;
    await this.cacheManager.set(LAST_SEEN_BLOCK_NUMBER_KEY, block.toString());
    this.scannerService.scan();
  }

  @UseGuards(ApiKeyGuard)
  @Post('scan')
  async scanChain() {
    this.scannerService.scan();
  }
}
