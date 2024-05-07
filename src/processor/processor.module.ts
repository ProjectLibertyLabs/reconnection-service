/*
https://docs.nestjs.com/modules
*/

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '#app/config/config.module';
import { BlockchainModule } from '#app/blockchain/blockchain.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import * as ReconnectionServiceConstants from '#app/constants';
import { ReconnectionCacheMgrService } from '#app/cache/reconnection-cache-mgr.service';
import { GraphUpdateQueueConsumerService } from './graph-update-queue-consumer.service';
import { GraphUpdateCompletionMonitorService } from './graph-update-completion-monitor.service';
import { ReconnectionGraphService } from './reconnection-graph.service';
import { GraphManagerModule } from '../graph/graph-state.module';
import { GraphStateManager } from '../graph/graph-state-manager';
import { ProviderWebhookService } from './provider-webhook.service';
import { NonceService } from './nonce.service';
import { TxMonitorQueueConsumerService } from './tx-monitor-queue-consumer.service';

@Module({
  imports: [
    EventEmitterModule,
    BullModule.forRootAsync({
      useFactory: (redis: ReconnectionCacheMgrService) => ({
        enableReadyCheck: true,
        connection: redis.redis,
      }),
      inject: [ReconnectionCacheMgrService],
    }),
    BullModule.registerQueue({
      name: ReconnectionServiceConstants.GRAPH_UPDATE_QUEUE_NAME,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
    BullModule.registerQueue({
      name: ReconnectionServiceConstants.TX_MONITOR_QUEUE_NAME,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
        },
        removeOnComplete: true,
        removeOnFail: true,
      },
    }),
    // Bullboard UI
    BullBoardModule.forRoot({
      route: '/queues',
      adapter: ExpressAdapter,
    }),
    BullBoardModule.forFeature({
      name: ReconnectionServiceConstants.GRAPH_UPDATE_QUEUE_NAME,
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: ReconnectionServiceConstants.TX_MONITOR_QUEUE_NAME,
      adapter: BullMQAdapter,
    }),
    ConfigModule,
    GraphManagerModule,
    BlockchainModule,
  ],
  controllers: [],
  providers: [
    GraphUpdateQueueConsumerService,
    TxMonitorQueueConsumerService,
    GraphUpdateCompletionMonitorService,
    ReconnectionGraphService,
    GraphStateManager,
    ProviderWebhookService,
    NonceService,
  ],
  exports: [ReconnectionGraphService, BullModule],
})
export class ProcessorModule {}
