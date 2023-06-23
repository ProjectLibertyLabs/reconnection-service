/*
https://docs.nestjs.com/modules
*/

import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigModule } from '@nestjs/config';
import { ReconnectionServiceController } from './reconnection-service.controller';
import { ReconnectionConfigService } from './reconnection-config.service';
import { configModuleOptions } from './config/env.config';
import { ReconnectionGraphService } from './reconnection-graph.service';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    EventEmitterModule.forRoot({
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
  ],
  controllers: [ReconnectionServiceController],
  providers: [ReconnectionConfigService, ReconnectionGraphService],
})
export class ReconnectionServiceModule {}
