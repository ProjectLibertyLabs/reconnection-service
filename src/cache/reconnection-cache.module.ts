import { Global, Module } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { RedisModule } from '@songkeys/nestjs-redis';
import { ConfigModule } from '#app/config/config.module';
import { ConfigService } from '#app/config/config.service';
import { ReconnectionCacheMgrService } from './reconnection-cache-mgr.service';
import * as CacheUtils from './cache-utils';

@Global()
@Module({
  imports: [
    RedisModule.forRootAsync(
      {
        imports: [ConfigModule, EventEmitterModule],
        useFactory: (configService: ConfigService, eventEmitter: EventEmitter2) => ({
          config: [
            {
              url: configService.redisUrl.toString(),
              maxRetriesPerRequest: null,
              onClientCreated(client) {
                CacheUtils.redisEventsToEventEmitter(client, eventEmitter);
              },
            },
          ],
          readyLog: false,
          errorLog: false,
        }),
        inject: [ConfigService, EventEmitter2],
      },
      false, // isGlobal
    ),
  ],
  providers: [ReconnectionCacheMgrService],
  exports: [ReconnectionCacheMgrService],
})
export class ReconnectionCacheModule {}
