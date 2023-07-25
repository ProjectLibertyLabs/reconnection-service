import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { MockWebhookModule } from './mock-webhook.module';

async function bootstrap() {
  const app = await NestFactory.create(MockWebhookModule, {
    logger: process.env.DEBUG ? ['error', 'warn', 'log', 'debug'] : ['error', 'warn', 'log'],
  });

  try {
    app.enableShutdownHooks();
    app.useGlobalPipes(new ValidationPipe());
    await app.listen(process.env.WEBHOOK_PORT ?? 3001);
  } catch (e) {
    await app.close();
  }
}

bootstrap();
