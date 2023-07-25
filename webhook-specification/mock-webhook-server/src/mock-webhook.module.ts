/*
https://docs.nestjs.com/modules
*/

import { Module } from '@nestjs/common';
import { MockWebhookController } from './mock-webhook.controller';

@Module({
  imports: [],
  controllers: [MockWebhookController],
  providers: [],
})
export class MockWebhookModule {}
