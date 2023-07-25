/* eslint-disable class-methods-use-this */
/*
https://docs.nestjs.com/controllers#controllers
*/

import { Controller, Get, HttpStatus, Logger, Param, Post } from '@nestjs/common';
import fs from 'fs';

@Controller()
export class MockWebhookController {
  private logger: Logger;

  private healthResponse: HttpStatus = HttpStatus.OK;

  constructor() {
    this.logger = new Logger(this.constructor.name);
  }

  @Get('/api/v1.0.0/health')
  public health() {
    return this.healthResponse;
  }

  @Post('/api/v1.0.0/health/toggleResponse')
  public toggleHealth() {
    this.healthResponse = this.healthResponse === HttpStatus.OK ? HttpStatus.GONE : HttpStatus.OK;
  }

  @Get('/api/v1.0.0/connections/:dsnpId')
  public getConnections(@Param('dsnpId') dsnpId: string) {
    let filename: string = '';
    if (fs.existsSync(`./responses/response.${dsnpId}.json`)) {
      filename = `./responses/response.${dsnpId}.json`;
    } else if (fs.existsSync('./responses/response.default.json')) {
      filename = './responses/response.default.json';
    }

    if (filename) {
      const content = fs.readFileSync(filename);
      const obj = JSON.parse(content.toString());
      return obj;
    }

    return HttpStatus.NO_CONTENT;
  }
}
