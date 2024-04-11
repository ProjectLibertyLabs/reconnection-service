import { Controller, Get, HttpException, HttpStatus, Logger, Param, Post } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ReconnectionServiceConstants } from './constants';

type JobStatus = 'active' | 'completed' | 'failed' | 'delayed' | 'waiting';

@Controller('reconnection-service')
export class ReconnectionServiceController {
  // eslint-disable-next-line no-useless-constructor, no-empty-function
  constructor(@InjectQueue(ReconnectionServiceConstants.GRAPH_UPDATE_QUEUE_NAME) private graphUpdateQueue: Queue) {}

  // eslint-disable-next-line class-methods-use-this
  @Get('health')
  health() {}

  @Get('queue')
  async queue() {
    const jobCounts = await this.graphUpdateQueue.getJobCounts();
    const isPaused = await this.graphUpdateQueue.isPaused();
    return {
      ...jobCounts,
      isPaused,
    };
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
      case 'waiting':
        return this.graphUpdateQueue.getWaiting();
      default:
        throw new HttpException('Unrecognized job status', HttpStatus.BAD_REQUEST);
    }
  }
}
