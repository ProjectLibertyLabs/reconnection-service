/* eslint-disable import/no-extraneous-dependencies */
/*
https://docs.nestjs.com/fundamentals/testing#unit-testing
*/

import { Test } from '@nestjs/testing';
import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  ConfigEnvironmentVariables,
  ReconnectionConfigService,
} from './reconnection-config.service';
import { configModuleOptions } from './config/env.config';

const setupConfigService = async (
  envObj: any,
): Promise<ReconnectionConfigService> => {
  jest.resetModules();
  process.env = {
    ...envObj,
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ...configModuleOptions,
        load: [() => process.env],
      }),
    ],
    controllers: [],
    providers: [ReconnectionConfigService],
  }).compile();

  await ConfigModule.envVariablesLoaded;

  return moduleRef.get<ReconnectionConfigService>(ReconnectionConfigService);
};

describe('ReconnectionConfigService', () => {
  const REDIS_URL = 'redis://localhost:6389';
  const FREQUENCY_URL = 'ws://localhost:9933';
  const PROVIDER_ID = 1;
  const PROVIDER_BASE_URL = 'https://some-provider';
  const PROVIDER_USER_GRAPH_ENDPOINT = 'user-graph';
  const PROVIDER_ACCESS_TOKEN = 'some-token';

  const ALL_ENV = {
    REDIS_URL,
    FREQUENCY_URL,
    PROVIDER_ID,
    PROVIDER_BASE_URL,
    PROVIDER_USER_GRAPH_ENDPOINT,
    PROVIDER_ACCESS_TOKEN,
  };

  describe('invalid environment', () => {
    it('missing redis url should fail', async () => {
      const { REDIS_URL: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ ...env })).rejects.toBeDefined();
    });

    it('invalid redis url should fail', async () => {
      const { REDIS_URL: dummy, ...env } = ALL_ENV;
      await expect(
        setupConfigService({ REDIS_URL: 'invalid url', ...env }),
      ).rejects.toBeDefined();
    });

    it('missing frequency url should fail', async () => {
      const { FREQUENCY_URL: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ ...env })).rejects.toBeDefined();
    });

    it('invalid frequency url should fail', async () => {
      const { FREQUENCY_URL: dummy, ...env } = ALL_ENV;
      await expect(
        setupConfigService({ FREQUENCY_URL: 'invalid url', ...env }),
      ).rejects.toBeDefined();
    });

    it('missing provider base url should fail', async () => {
      const { PROVIDER_BASE_URL: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ ...env })).rejects.toBeDefined();
    });

    it('invalid provider base url should fail', async () => {
      const { PROVIDER_BASE_URL: dummy, ...env } = ALL_ENV;
      await expect(
        setupConfigService({ PROVIDER_BASE_URL: 'invalid url', ...env }),
      ).rejects.toBeDefined();
    });

    it('missing provider user graph endpoint should fail', async () => {
      const { PROVIDER_USER_GRAPH_ENDPOINT: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ ...env })).rejects.toBeDefined();
    });

    it('empty provider user graph endpoint should fail', async () => {
      const { PROVIDER_USER_GRAPH_ENDPOINT: dummy, ...env } = ALL_ENV;
      await expect(
        setupConfigService({ PROVIDER_USER_GRAPH_ENDPOINT: '', ...env }),
      ).rejects.toBeDefined();
    });

    it('missing provider access token should fail', async () => {
      const { PROVIDER_ACCESS_TOKEN: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ ...env })).rejects.toBeDefined();
    });

    it('empty provider access token should fail', async () => {
      const { PROVIDER_ACCESS_TOKEN: dummy, ...env } = ALL_ENV;
      await expect(
        setupConfigService({ PROVIDER_ACCESS_TOKEN: '', ...env }),
      ).rejects.toBeDefined();
    });
  });

  describe('valid environment', () => {
    let reconnectionConfigService: ReconnectionConfigService;
    beforeAll(async () => {
      reconnectionConfigService = await setupConfigService(ALL_ENV);
    });

    it('should be defined', () => {
      expect(reconnectionConfigService).toBeDefined();
    });

    it('should get redis url', () => {
      expect(reconnectionConfigService.redisUrl?.toString()).toStrictEqual(
        REDIS_URL,
      );
    });

    it('should get frequency url', () => {
      expect(reconnectionConfigService.frequencyUrl?.toString()).toStrictEqual(
        FREQUENCY_URL,
      );
    });

    it('should get provider base url', () => {
      expect(
        reconnectionConfigService
          .providerBaseUrl(BigInt(PROVIDER_ID))
          ?.toString(),
      ).toStrictEqual(PROVIDER_BASE_URL);
    });

    it('should get provider user graph endpoint', () => {
      expect(
        reconnectionConfigService
          .providerUserGraphEndpoint(BigInt(PROVIDER_ID))
          ?.toString(),
      ).toStrictEqual(PROVIDER_USER_GRAPH_ENDPOINT);
    });

    it('should get provider api token', () => {
      expect(
        reconnectionConfigService
          .providerApiToken(BigInt(PROVIDER_ID))
          ?.toString(),
      ).toStrictEqual(PROVIDER_ACCESS_TOKEN);
    });
  });
});
