import { RedisModule } from '@liaoliaots/nestjs-redis';
import { Module } from '@nestjs/common';
import { ReconnectionCacheMgrService } from './reconnection-cache-mgr.service';

@Module({
  imports: [RedisModule],
  providers: [ReconnectionCacheMgrService],
  exports: [ReconnectionCacheMgrService],
})
export class ReconnectionCacheModule {}
