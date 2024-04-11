import { RedisModule } from '@liaoliaots/nestjs-redis';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '#app/config/config.module';
import { ConfigService } from '#app/config/config.service';
import { ReconnectionCacheMgrService } from './reconnection-cache-mgr.service';

@Global()
@Module({
  imports: [
    RedisModule.forRootAsync(
      {
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          config: [{ url: configService.redisUrl.toString() }],
        }),
        inject: [ConfigService],
      },
      false, // isGlobal
    ),
  ],
  providers: [ReconnectionCacheMgrService],
  exports: [ReconnectionCacheMgrService],
})
export class ReconnectionCacheModule {}
