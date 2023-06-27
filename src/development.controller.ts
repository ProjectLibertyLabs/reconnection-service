/*
This is a controller providing some endpoints useful for development and testing.
To use it, simply rename and remove the '.dev' extension
*/

// eslint-disable-next-line max-classes-per-file
import { Controller, Logger, Get, Post, Param, HttpException, HttpStatus, Body } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { plainToClass } from 'class-transformer';
import { GraphUpdateJobDto } from './interfaces/graph-update-job.dto';

@Controller('reconnection-service/dev')
export class DevelopmentController {
  private readonly logger: Logger;

  constructor(@InjectQueue('graphUpdateQueue') private graphUpdateQueue: Queue) {
    this.logger = new Logger(this.constructor.name);
  }

  @Post('queue')
  async enqueueJob(@Body() payload: GraphUpdateJobDto) {
    const dto = plainToClass(GraphUpdateJobDto, payload);
    const { key: jobId, data } = dto.toGraphUpdateJob();
    const options: any = {};
    if (typeof data.debugDisposition === 'object') {
      const debugData: any = data.debugDisposition;
      if (debugData?.attempts > 0) {
        options.attempts = debugData.attempts;
      }
      if (debugData?.action === 'obliterate') {
        await this.graphUpdateQueue.drain();
        await this.graphUpdateQueue.obliterate();
        await this.graphUpdateQueue.resume();
        return;
      }
    }
    console.log(`Adding job ${jobId}`);
    await this.graphUpdateQueue.add('graphUpdate', data, { jobId });
  }
}
