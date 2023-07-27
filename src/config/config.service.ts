/*
https://docs.nestjs.com/providers#services
*/

import { ProviderId } from '@frequency-chain/api-augment/interfaces';
import { Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import { AnyNumber } from '@polkadot/types/types';

export interface ConfigEnvironmentVariables {
  REDIS_URL: URL;
  FREQUENCY_URL: URL;
  PROVIDER_ID: bigint;
  PROVIDER_BASE_URL: URL;
  PROVIDER_ACCESS_TOKEN: string;
  BLOCKCHAIN_SCAN_INTERVAL_MINUTES: number;
  QUEUE_HIGH_WATER: number;
  WEBHOOK_FAILURE_THRESHOLD: number;
  HEALTH_CHECK_SUCCESS_THRESHOLD: number;
  WEBHOOK_RETRY_INTERVAL_SECONDS: number;
  HEALTH_CHECK_RETRY_INTERVAL_SECONDS: number;
  GRAPH_ENVIRONMENT_TYPE: string;
  GRAPH_ENVIRONMENT_DEV_CONFIG: string;
  PROVIDER_ACCOUNT_SEED_PHRASE: string;
}

interface ProviderDetails {
  baseUrl: URL;
  apiToken: string;
}

/// Config service to get global app and provider-specific config values.
/// Though this is currently designed to take a single environment-injected
/// Provider config, it is designed with an API suitable for a multi-provider
/// environment which may use other backends (DB, secrets engine) to get provider
/// configuration values, so that it may be swapped out without requiring the rest
/// of the application to change.
@Injectable()
export class ConfigService {
  public providerMap: Map<string, ProviderDetails>;

  constructor(private nestConfigService: NestConfigService<ConfigEnvironmentVariables>) {
    const providerId: bigint = nestConfigService.get<bigint>('PROVIDER_ID') ?? 0n;
    const baseUrl = nestConfigService.get('PROVIDER_BASE_URL');
    const apiToken = this.nestConfigService.get('PROVIDER_ACCESS_TOKEN');

    this.providerMap = new Map<string, ProviderDetails>([
      [
        providerId.toString(),
        {
          baseUrl,
          apiToken,
        },
      ],
    ]);
  }

  public get redisUrl(): URL {
    return this.nestConfigService.get('REDIS_URL')!;
  }

  public get frequencyUrl(): URL {
    return this.nestConfigService.get('FREQUENCY_URL')!;
  }

  public providerBaseUrl(id: ProviderId | AnyNumber): URL {
    return this.providerMap.get(id.toString())?.baseUrl!;
  }

  public providerApiToken(id: ProviderId | AnyNumber): string {
    return this.providerMap.get(id.toString())?.apiToken!;
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

  public getHealthCheckRetryIntervalSeconds(): number {
    return this.nestConfigService.get<number>('HEALTH_CHECK_RETRY_INTERVAL_SECONDS')!;
  }

  public getProviderAccountSeedPhrase(): string {
    return this.nestConfigService.get<string>('PROVIDER_ACCOUNT_SEED_PHRASE')!;
  }

  public getGraphEnvironmentType(): string {
    return this.nestConfigService.get<string>('GRAPH_ENVIRONMENT_TYPE')!;
  }

  public getGraphEnvironmentConfig(): string {
    return this.nestConfigService.get<string>('GRAPH_ENVIRONMENT_DEV_CONFIG')!;
  }
}
