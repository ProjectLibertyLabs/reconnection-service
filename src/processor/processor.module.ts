/*
https://docs.nestjs.com/modules
*/

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '#app/config/config.module';
import { QueueConsumerService } from './queue-consumer.service';
import { ReconnectionGraphService } from './reconnection-graph.service';

@Module({
  imports: [BullModule, ConfigModule],
  controllers: [],
  providers: [QueueConsumerService, ReconnectionGraphService],
})
export class ProcessorModule {}
