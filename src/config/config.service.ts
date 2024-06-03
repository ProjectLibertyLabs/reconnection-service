/* eslint-disable @typescript-eslint/no-non-null-assertion */
/*
https://docs.nestjs.com/providers#services
*/

// Import this here so it happens first
import '@frequency-chain/api-augment';

import { ICapacityLimits } from '#app/interfaces/capacity-limit.interface';
import type { EnvironmentType } from '@dsnp/graph-sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';

export interface ConfigEnvironmentVariables {
  API_PORT: number;
  REDIS_URL: URL;
  FREQUENCY_URL: URL;
  PROVIDER_ID: string;
  PROVIDER_BASE_URL: URL;
  PROVIDER_ACCESS_TOKEN: string;
  BLOCKCHAIN_SCAN_INTERVAL_MINUTES: number;
  QUEUE_HIGH_WATER: number;
  WEBHOOK_FAILURE_THRESHOLD: number;
  HEALTH_CHECK_SUCCESS_THRESHOLD: number;
  WEBHOOK_RETRY_INTERVAL_SECONDS: number;
  HEALTH_CHECK_MAX_RETRY_INTERVAL_SECONDS: number;
  HEALTH_CHECK_MAX_RETRIES: number;
  GRAPH_ENVIRONMENT_TYPE: keyof EnvironmentType;
  GRAPH_ENVIRONMENT_DEV_CONFIG: string;
  PROVIDER_ACCOUNT_SEED_PHRASE: string;
  CAPACITY_LIMIT: ICapacityLimits;
  FREQUENCY_TX_TIMEOUT_SECONDS: number;
  CONNECTIONS_PER_PROVIDER_RESPONSE_PAGE: number;
}

/// Config service to get global app and provider-specific config values.
@Injectable()
export class ConfigService {
  private capacityLimit: ICapacityLimits;

  constructor(private nestConfigService: NestConfigService<ConfigEnvironmentVariables>) {
    const obj = JSON.parse(nestConfigService.get('CAPACITY_LIMIT') ?? '{}', (key, value) => {
      if (key === 'value') {
        return BigInt(value);
      }

      return value;
    });

    if (obj?.type) {
      this.capacityLimit = {
        serviceLimit: obj,
      };
    } else {
      this.capacityLimit = obj;
    }
  }

  public get apiPort(): number {
    return this.nestConfigService.get<number>('API_PORT')!;
  }

  public get redisUrl(): URL {
    return this.nestConfigService.get('REDIS_URL')!;
  }

  public get frequencyUrl(): URL {
    return this.nestConfigService.get('FREQUENCY_URL')!;
  }

  public get providerBaseUrl(): URL {
    return this.nestConfigService.get<URL>('PROVIDER_BASE_URL')!;
  }

  public get providerApiToken(): string | undefined {
    return this.nestConfigService.get<string>('PROVIDER_ACCESS_TOKEN');
  }

  public getBlockchainScanIntervalMinutes(): number {
    return this.nestConfigService.get<number>('BLOCKCHAIN_SCAN_INTERVAL_MINUTES') ?? 1;
  }

  public getQueueHighWater(): number {
    return this.nestConfigService.get<number>('QUEUE_HIGH_WATER')!;
  }

  public getWebhookFailureThreshold(): number {
    return this.nestConfigService.get<number>('WEBHOOK_FAILURE_THRESHOLD')!;
  }

  public getHealthCheckSuccessThreshold(): number {
    return this.nestConfigService.get<number>('HEALTH_CHECK_SUCCESS_THRESHOLD')!;
  }

  public getWebhookRetryIntervalSeconds(): number {
    return this.nestConfigService.get<number>('WEBHOOK_RETRY_INTERVAL_SECONDS')!;
  }

  public getHealthCheckMaxRetryIntervalSeconds(): number {
    return this.nestConfigService.get<number>('HEALTH_CHECK_MAX_RETRY_INTERVAL_SECONDS')!;
  }

  public getHealthCheckMaxRetries(): number {
    return this.nestConfigService.get<number>('HEALTH_CHECK_MAX_RETRIES')!;
  }

  public getProviderId(): string {
    return this.nestConfigService.get<bigint>('PROVIDER_ID')!.toString();
  }

  public getProviderAccountSeedPhrase(): string {
    return this.nestConfigService.get<string>('PROVIDER_ACCOUNT_SEED_PHRASE')!;
  }

  public getGraphEnvironmentType(): keyof EnvironmentType {
    return this.nestConfigService.get<keyof EnvironmentType>('GRAPH_ENVIRONMENT_TYPE')!;
  }

  public getGraphEnvironmentConfig(): string {
    return this.nestConfigService.get<string>('GRAPH_ENVIRONMENT_DEV_CONFIG')!;
  }

  public getCapacityLimit(): ICapacityLimits {
    return this.capacityLimit;
  }

  public getFrequencyTxTimeoutSeconds(): number {
    return this.nestConfigService.get<number>('FREQUENCY_TX_TIMEOUT_SECONDS')!;
  }

  public getPageSize(): number {
    return this.nestConfigService.get<number>('CONNECTIONS_PER_PROVIDER_RESPONSE_PAGE')!;
  }
}
