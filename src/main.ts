import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ReconnectionServiceModule } from './reconnection-service.module';

const logger = new Logger('main');

async function bootstrap() {
  const app = await NestFactory.create(ReconnectionServiceModule, {
    logger: process.env.DEBUG
      ? ['error', 'warn', 'log', 'debug']
      : ['error', 'warn', 'log'],
  });

  try {
    app.enableShutdownHooks();
    app.useGlobalPipes(new ValidationPipe());
    await app.listen(3000);
  } catch (e) {
    logger.error(e);
    await app.close();
  }
}

bootstrap().catch((e) => {
  logger.error(e);
});
