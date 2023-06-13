/*
https://docs.nestjs.com/controllers#controllers
*/

import { Controller, Get, Logger } from '@nestjs/common';

@Controller('reconnection-service')
export class ReconnectionServiceController {
  private readonly logger: Logger;

  constructor() {
    this.logger = new Logger(this.constructor.name);
  }

  // eslint-disable-next-line class-methods-use-this
  @Get('health')
  health() {
  }
}
