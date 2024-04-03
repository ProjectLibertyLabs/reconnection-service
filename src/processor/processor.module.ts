/*
https://docs.nestjs.com/modules
*/

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '#app/config/config.module';
import { ConfigService } from '#app/config/config.service';
import { BlockchainModule } from '#app/blockchain/blockchain.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { QueueConsumerService } from './queue-consumer.service';
import { GraphNotifierService } from './graph.monitor.processor.service';
import { ReconnectionGraphService } from './reconnection-graph.service';
import { GraphManagerModule } from '../graph/graph-state.module';
import { GraphStateManager } from '../graph/graph-state-manager';
import { ProviderWebhookService } from './provider-webhook.service';
import { NonceService } from './nonce.service';

@Module({
  imports: [
    EventEmitterModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        // Note: BullMQ doesn't honor a URL for the Redis connection, and
        // JS URL doesn't parse 'redis://' as a valid protocol, so we fool
        // it by changing the URL to use 'http://' in order to parse out
        // the host, port, username, password, etc.
        // We could pass REDIS_HOST, REDIS_PORT, etc, in the environment, but
        // trying to keep the # of environment variables from proliferating
        const url = new URL(configService.redisUrl.toString().replace(/^redis[s]*/, 'http'));
        const { hostname, port, username, password, pathname } = url;
        return {
          connection: {
            host: hostname || undefined,
            port: port ? Number(port) : undefined,
            username: username || undefined,
            password: password || undefined,
            db: pathname?.length > 1 ? Number(pathname.slice(1)) : undefined,
          },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue({
      name: 'graphUpdateQueue',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
        },
        removeOnComplete: false,
        removeOnFail: false,
      },
    }),
    BullModule.registerQueue({
      name: 'graphTxMonitorQueue',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
    // Bullboard UI
    BullBoardModule.forRoot({
      route: '/queues',
      adapter: ExpressAdapter,
    }),
    BullBoardModule.forFeature({
      name: 'graphUpdateQueue',
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: 'graphTxMonitorQueue',
      adapter: BullMQAdapter,
    }),
    ConfigModule,
    GraphManagerModule,
    BlockchainModule,
  ],
  controllers: [],
  providers: [QueueConsumerService, GraphNotifierService, ReconnectionGraphService, GraphStateManager, ProviderWebhookService, NonceService],
  exports: [ReconnectionGraphService, BullModule],
})
export class ProcessorModule {}
