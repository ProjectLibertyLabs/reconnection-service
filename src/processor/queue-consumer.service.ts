/*
https://docs.nestjs.com/providers#services
*/

import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { IGraphUpdateJob } from '#app/interfaces/graph-update-job.interface';

@Injectable()
@Processor('graphUpdateQueue')
export class QueueConsumerService extends WorkerHost {
  private logger: Logger;

  constructor() {
    super();
    this.logger = new Logger(this.constructor.name);
  }

  // eslint-disable-next-line class-methods-use-this
  async process(job: Job<IGraphUpdateJob, any, string>) {
    this.logger.debug('Processing job: ', job.data);

    // Handle dev/debug jobs
    if (typeof job.data.debugDisposition === 'string') {
      const debugData: any = JSON.parse(job.data.debugDisposition);
      switch (debugData?.action) {
        case 'abort':
          this.logger.debug(`Forcing abort in order to generate stalled job: ${job.id}`);
          process.exit(1);

        // eslint-disable-next-line no-fallthrough
        case 'fail':
          this.logger.debug(`Failing job ${job.id}--attempt ${job.attemptsMade} of ${job.opts.attempts}`);
          throw new Error('Forcing job failure');

        case 'complete':
          if (debugData?.attempts >= 0) {
            if (job.attemptsMade < debugData.attempts) {
              throw new Error(`Job ${job.id} failing temporarily (attempty ${job.attemptsMade} of ${debugData.attempts}`);
            } else {
              this.logger.debug(`Completing job ${job.id} after ${job.attemptsMade}`);
            }
          }
          break;

        default:
          break;
      }
    }
  }
}
