/*
This is a controller providing some endpoints useful for development and testing.
To use it, simply rename and remove the '.dev' extension
*/

// eslint-disable-next-line max-classes-per-file
import { Controller, Logger, Post, Body, Param, Query } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { plainToClass } from 'class-transformer';
import { GraphUpdateJobDto } from './interfaces/graph-update-job.dto';
import { IGraphUpdateJob } from './interfaces/graph-update-job.interface';
import { ReconnectionGraphService } from './processor/reconnection-graph.service';
@Controller('reconnection-service/dev')
export class DevelopmentController {
  private readonly logger: Logger;

  constructor(
    @InjectQueue('graphUpdateQueue') private graphUpdateQueue: Queue,
    private graphService: ReconnectionGraphService
  ) {
    this.logger = new Logger(this.constructor.name);

    this.graphUpdateQueue.on('paused', () => this.logger.debug('Queue is paused'));
    this.graphUpdateQueue.on('resumed', () => this.logger.debug('Queue has resumed'));
    this.graphUpdateQueue.on('error', (err) => this.logger.error(`Queue encountered an error: ${err}`));
    this.graphUpdateQueue.on('waiting', (job) =>
      this.logger.debug(`Queued job ${job.id}:
    ${JSON.stringify(job.data)}`),
    );
  }

  @Post('queue')
  async enqueueJob(@Body() payload: GraphUpdateJobDto) {
    const dto = plainToClass(GraphUpdateJobDto, payload);
    const { key: jobId, data } = dto.toGraphUpdateJob();
    let options: any = { jobId };
    if (typeof data.debugDisposition === 'object') {
      const debugData: any = data.debugDisposition;
      const { action, ...debugOptions } = debugData;
      options = { ...options, ...debugOptions };
      switch (action) {
        case 'obliterate':
          await this.graphUpdateQueue.drain();
          await this.graphUpdateQueue.obliterate();
          await this.graphUpdateQueue.resume();
          return;

        case 'remove':
          await this.graphUpdateQueue.remove(jobId);
          return;

        case 'pause':
          await this.graphUpdateQueue.pause();
          return;

        case 'resume':
          await this.graphUpdateQueue.resume();
          return;

        case 'retry':
          {
            const job = await this.graphUpdateQueue.getJob(jobId);
            if (job) {
              await job.update(data);
              await job.retry();
            } else {
              this.logger.error(`Unable to retrieve job ${jobId} for retry`);
            }
          }
          return;

        default:
          break;
      }
    }
    await this.graphUpdateQueue.add('graphUpdate', data, options);
  }

  @Post('update/graph')
  updateGraph(
    @Body() payload: GraphUpdateJobDto,
  ) {
    this.graphService.updateUserGraph(payload.dsnpId, payload.providerId, true);
  }
}
