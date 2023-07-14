/* eslint-disable import/no-extraneous-dependencies */
/*
https://docs.nestjs.com/fundamentals/testing#unit-testing
*/

import { Test } from '@nestjs/testing';
import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import { ConfigModule, ConfigService as NestConfigService } from '@nestjs/config';
import { ConfigService } from './config.service';
import { configModuleOptions } from './env.config';

const setupConfigService = async (envObj: any): Promise<ConfigService> => {
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
    providers: [ConfigService],
  }).compile();

  await ConfigModule.envVariablesLoaded;

  return moduleRef.get<ConfigService>(ConfigService);
};

describe('ReconnectionConfigService', () => {
  const REDIS_URL = 'redis://localhost:6389';
  const FREQUENCY_URL = 'ws://localhost:9933';
  const PROVIDER_ID = 1;
  const PROVIDER_BASE_URL = 'https://some-provider';
  const PROVIDER_USER_GRAPH_ENDPOINT = 'user-graph';
  const PROVIDER_ACCESS_TOKEN = 'some-token';
  const BLOCKCHAIN_SCAN_INTERVAL_MINUTES = 60;
  const QUEUE_HIGH_WATER = 1000;
  const PROVIDER_ACCOUNT_SEED_PHRASE = '';
  const GRAPH_ENVIRONMENT_TYPE = 'Mainnet';
  const GRAPH_ENVIRONMENT_CONFIG = '{}';

  const ALL_ENV = {
    REDIS_URL,
    FREQUENCY_URL,
    PROVIDER_ID,
    PROVIDER_BASE_URL,
    PROVIDER_USER_GRAPH_ENDPOINT,
    PROVIDER_ACCESS_TOKEN,
    BLOCKCHAIN_SCAN_INTERVAL_MINUTES,
    QUEUE_HIGH_WATER,
    PROVIDER_ACCOUNT_SEED_PHRASE,
    GRAPH_ENVIRONMENT_TYPE,
    GRAPH_ENVIRONMENT_CONFIG,
  };

  describe('invalid environment', () => {
    it('missing redis url should fail', async () => {
      const { REDIS_URL: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ ...env })).rejects.toBeDefined();
    });

    it('invalid redis url should fail', async () => {
      const { REDIS_URL: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ REDIS_URL: 'invalid url', ...env })).rejects.toBeDefined();
    });

    it('missing frequency url should fail', async () => {
      const { FREQUENCY_URL: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ ...env })).rejects.toBeDefined();
    });

    it('invalid frequency url should fail', async () => {
      const { FREQUENCY_URL: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ FREQUENCY_URL: 'invalid url', ...env })).rejects.toBeDefined();
    });

    it('missing provider base url should fail', async () => {
      const { PROVIDER_BASE_URL: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ ...env })).rejects.toBeDefined();
    });

    it('invalid provider base url should fail', async () => {
      const { PROVIDER_BASE_URL: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ PROVIDER_BASE_URL: 'invalid url', ...env })).rejects.toBeDefined();
    });

    it('missing provider user graph endpoint should fail', async () => {
      const { PROVIDER_USER_GRAPH_ENDPOINT: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ ...env })).rejects.toBeDefined();
    });

    it('empty provider user graph endpoint should fail', async () => {
      const { PROVIDER_USER_GRAPH_ENDPOINT: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ PROVIDER_USER_GRAPH_ENDPOINT: '', ...env })).rejects.toBeDefined();
    });

    it('missing provider access token should fail', async () => {
      const { PROVIDER_ACCESS_TOKEN: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ ...env })).rejects.toBeDefined();
    });

    it('empty provider access token should fail', async () => {
      const { PROVIDER_ACCESS_TOKEN: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ PROVIDER_ACCESS_TOKEN: '', ...env })).rejects.toBeDefined();
    });

    it('invalid scan interval should fail', async () => {
      const { BLOCKCHAIN_SCAN_INTERVAL_MINUTES: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ BLOCKCHAIN_SCAN_INTERVAL_MINUTES: -1, ...env })).rejects.toBeDefined();
      await expect(setupConfigService({ BLOCKCHAIN_SCAN_INTERVAL_MINUTES: 0, ...env })).rejects.toBeDefined();
      await expect(setupConfigService({ BLOCKCHAIN_SCAN_INTERVAL_MINUTES: 'foo', ...env })).rejects.toBeDefined();
    });

    it('invalid queue high water should fail', async () => {
      const { QUEUE_HIGH_WATER: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ QUEUE_HIGH_WATER: -1, ...env })).rejects.toBeDefined();
      await expect(setupConfigService({ QUEUE_HIGH_WATER: 99, ...env })).rejects.toBeDefined();
      await expect(setupConfigService({ QUEUE_HIGH_WATER: 'foo', ...env })).rejects.toBeDefined();
    });

    it('invalid provider account seed phrase should fail', async () => {
      const { PROVIDER_ACCOUNT_SEED_PHRASE: dummy, ...env } = ALL_ENV;
      await expect(setupConfigService({ PROVIDER_ACCOUNT_SEED_PHRASE: '', ...env })).rejects.toBeDefined();
    });
  });

  describe('valid environment', () => {
    let reconnectionConfigService: ConfigService;
    beforeAll(async () => {
      reconnectionConfigService = await setupConfigService(ALL_ENV);
    });

    it('should be defined', () => {
      expect(reconnectionConfigService).toBeDefined();
    });

    it('should get redis url', () => {
      expect(reconnectionConfigService.redisUrl?.toString()).toStrictEqual(REDIS_URL);
    });

    it('should get frequency url', () => {
      expect(reconnectionConfigService.frequencyUrl?.toString()).toStrictEqual(FREQUENCY_URL);
    });

    it('should get provider base url', () => {
      expect(reconnectionConfigService.providerBaseUrl(BigInt(PROVIDER_ID))?.toString()).toStrictEqual(PROVIDER_BASE_URL);
    });

    it('should get provider user graph endpoint', () => {
      expect(reconnectionConfigService.providerUserGraphEndpoint(BigInt(PROVIDER_ID))?.toString()).toStrictEqual(PROVIDER_USER_GRAPH_ENDPOINT);
    });

    it('should get provider api token', () => {
      expect(reconnectionConfigService.providerApiToken(BigInt(PROVIDER_ID))?.toString()).toStrictEqual(PROVIDER_ACCESS_TOKEN);
    });
  });
});
