import { Controller, Get, HttpException, HttpStatus, Logger, Param, Post } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BlockchainScannerService } from './blockchain-scanner.service';

type JobStatus = 'active' | 'completed' | 'failed' | 'delayed';

@Controller('reconnection-service')
export class ReconnectionServiceController {
  private readonly logger: Logger;

  constructor(private scannerService: BlockchainScannerService, @InjectQueue('graphUpdateQueue') private graphUpdateQueue: Queue) {
    this.logger = new Logger(this.constructor.name);
  }

  // eslint-disable-next-line class-methods-use-this
  @Get('health')
  health() {}

  @Get('queue')
  async queue() {
    return this.graphUpdateQueue.getJobCounts();
  }

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

      default:
        throw new HttpException('Unrecognized job status', HttpStatus.BAD_REQUEST);
    }
  }
}
