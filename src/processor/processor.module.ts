/*
https://docs.nestjs.com/modules
*/

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueConsumerService } from './queue-consumer.service';

@Module({
  imports: [BullModule],
  controllers: [],
  providers: [QueueConsumerService],
})
export class ProcessorModule {}
