/*
https://docs.nestjs.com/modules
*/

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '#app/config/config.module';
import { ConfigService } from '#app/config/config.service';
import { BlockchainModule } from '#app/blockchain/blockchain.module';
import { BackoffOptions } from 'bullmq';
import { QueueConsumerService } from './queue-consumer.service';
import { ReconnectionGraphService } from './reconnection-graph.service';
import { GraphManagerModule } from '../graph/graph-state.module';
import { GraphStateManager } from '../graph/graph-state-manager';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        // Note: BullMQ doesn't honor a URL for the Redis connection, and
        // JS URL doesn't parse 'redis://' as a valid protocol.
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
        attempts: 5,
        backoff: {
          type: 'exponential',
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 5000 },
      },
    }),
    ConfigModule,
    GraphManagerModule,
    BlockchainModule,
  ],
  controllers: [],
  providers: [QueueConsumerService, ReconnectionGraphService, GraphStateManager],
  exports: [ReconnectionGraphService, BullModule],
})
export class ProcessorModule {}
