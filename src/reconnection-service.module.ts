import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from '@liaoliaots/nestjs-redis';
import { ReconnectionServiceController } from './reconnection-service.controller';
import { ConfigService } from './config/config.service';
import { ConfigModule } from './config/config.module';
import { ProcessorModule } from './processor/processor.module';
import { DevelopmentController } from './development.controller';
import { BlockchainModule } from './blockchain/blockchain.module';
import { GraphUpdateScannerService } from './graph-update-scanner.service';

@Module({
  imports: [
    BullModule,
    ConfigModule,
    RedisModule.forRootAsync(
      {
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          config: [{ url: configService.redisUrl.toString() }],
        }),
        inject: [ConfigService],
      },
      true, // isGlobal
    ),
    EventEmitterModule.forRoot({
      // Use this instance throughout the application
      global: true,
      // set this to `true` to use wildcards
      wildcard: false,
      // the delimiter used to segment namespaces
      delimiter: '.',
      // set this to `true` if you want to emit the newListener event
      newListener: false,
      // set this to `true` if you want to emit the removeListener event
      removeListener: false,
      // the maximum amount of listeners that can be assigned to an event
      maxListeners: 10,
      // show event name in memory leak message when more than maximum amount of listeners is assigned
      verboseMemoryLeak: false,
      // disable throwing uncaughtException if an error event is emitted and it has no listeners
      ignoreErrors: false,
    }),
    ScheduleModule.forRoot(),
    ProcessorModule,
    BlockchainModule,
  ],
  providers: [ConfigService, GraphUpdateScannerService],
  controllers: process.env?.ENABLE_DEV_CONTROLLER === 'true' ? [DevelopmentController, ReconnectionServiceController] : [ReconnectionServiceController],
  exports: [],
})
export class ReconnectionServiceModule {}
