/* eslint-disable @typescript-eslint/no-non-null-assertion */
/*
https://docs.nestjs.com/providers#services
*/

// Import this here so it happens first
import '@frequency-chain/api-augment';

import { ICapacityLimits } from '#app/interfaces/capacity-limit.interface';
import type { EnvironmentType } from '@projectlibertylabs/graph-sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';
import { getKeyringPairFromSecp256k1PrivateKey, getUnifiedPublicKey } from '@frequency-chain/ethereum-utils';
import { hexToU8a } from '@polkadot/util';
import { createKeys } from '#app/blockchain/create-keys';
import { KeyringPair } from '@polkadot/keyring/types';

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
  PROVIDER_ACCOUNT_SEED_PHRASE: string;
  ETHEREUM_PROVIDER_ACCOUNT_PRIVATE_KEY: string;
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
    return parseInt(this.nestConfigService.get('BLOCKCHAIN_SCAN_INTERVAL_MINUTES') ?? '1', 10);
  }

  public getQueueHighWater(): number {
    return parseInt(this.nestConfigService.get('QUEUE_HIGH_WATER') ?? '1', 10);
  }

  public getWebhookFailureThreshold(): number {
    return parseInt(this.nestConfigService.get('WEBHOOK_FAILURE_THRESHOLD') ?? '1', 10);
  }

  public getHealthCheckSuccessThreshold(): number {
    return parseInt(this.nestConfigService.get('HEALTH_CHECK_SUCCESS_THRESHOLD') ?? '1', 10);
  }

  public getWebhookRetryIntervalSeconds(): number {
    return parseInt(this.nestConfigService.get('WEBHOOK_RETRY_INTERVAL_SECONDS') ?? '1', 10);
  }

  public getHealthCheckMaxRetryIntervalSeconds(): number {
    return parseInt(this.nestConfigService.get('HEALTH_CHECK_MAX_RETRY_INTERVAL_SECONDS') ?? '1', 10);
  }

  public getHealthCheckMaxRetries(): number {
    return parseInt(this.nestConfigService.get('HEALTH_CHECK_MAX_RETRIES') ?? '1', 10);
  }

  public getProviderId(): string {
    return this.nestConfigService.get<bigint>('PROVIDER_ID')!.toString();
  }

  public getProviderAccountSeedPhrase(): string {
    return this.nestConfigService.get<string>('PROVIDER_ACCOUNT_SEED_PHRASE')!;
  }

  public getEthereumProviderAccountPrivateKey(): string {
    return this.nestConfigService.get<string>('ETHEREUM_PROVIDER_ACCOUNT_PRIVATE_KEY')!;
  }

  public getGraphEnvironmentType(): keyof EnvironmentType {
    return this.nestConfigService.get<keyof EnvironmentType>('GRAPH_ENVIRONMENT_TYPE')!;
  }

  public getCapacityLimit(): ICapacityLimits {
    return this.capacityLimit;
  }

  public getFrequencyTxTimeoutSeconds(): number {
    return parseInt(this.nestConfigService.get('FREQUENCY_TX_TIMEOUT_SECONDS') ?? '1', 10);
  }

  public getPageSize(): number {
    return parseInt(this.nestConfigService.get('CONNECTIONS_PER_PROVIDER_RESPONSE_PAGE') ?? '1', 10);
  }

  // tries to use the ethereum key first and uses the legacy account as a backup
  public getPreferredProviderKeyringPair(): KeyringPair {
    if (this.getEthereumProviderAccountPrivateKey()?.length) {
      return getKeyringPairFromSecp256k1PrivateKey(hexToU8a(this.getEthereumProviderAccountPrivateKey()));
    }
    return createKeys(this.getProviderAccountSeedPhrase());
  }

  public getPreferredProviderAccountId(): Uint8Array {
    return getUnifiedPublicKey(this.getPreferredProviderKeyringPair());
  }
}
