import { Injectable, OnModuleInit } from '@nestjs/common';
import { RedisService } from '@liaoliaots/nestjs-redis';

@Injectable()
export class RedisHealthCheckService implements OnModuleInit {
  constructor(private readonly redisService: RedisService) {}

  async onModuleInit() {
    try {
      await this.redisService.getClient().ping();
    } catch (err){
        throw new Error(`Failed to connect to Redis: ${err}`);
    }
  }
}
