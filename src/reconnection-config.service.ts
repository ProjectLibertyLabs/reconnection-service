/*
https://docs.nestjs.com/providers#services
*/

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ConfigEnvironmentVariables {
  REDIS_URL: URL;
  FREQUENCY_URL: URL;
  PROVIDER_ID: bigint;
  PROVIDER_BASE_URL: URL;
  PROVIDER_USER_GRAPH_ENDPOINT: string;
  PROVIDER_ACCESS_TOKEN: string;
}

interface ProviderDetails {
  baseUrl: URL;
  userGraphEndpoint: string;
  apiToken: string;
}

/// Config service to get global app and provider-specific config values.
/// Though this is currently designed to take a single environment-injected
/// Provider config, it is designed with an API suitable for a multi-provider
/// environment which may use other backends (DB, secrets engine) to get provider
/// configuration values, so that it may be swapped out without requiring the rest
/// of the application to change.
@Injectable()
export class ReconnectionConfigService {
  public providerMap: Map<string, ProviderDetails>;

  constructor(
    private nestConfigService: ConfigService<ConfigEnvironmentVariables>,
  ) {
    const providerId: bigint =
      nestConfigService.get<bigint>('PROVIDER_ID') ?? 0n;
    const baseUrl = nestConfigService.get('PROVIDER_BASE_URL');
    const userGraphEndpoint = nestConfigService.get(
      'PROVIDER_USER_GRAPH_ENDPOINT',
    );
    const apiToken = this.nestConfigService.get('PROVIDER_ACCESS_TOKEN');

    this.providerMap = new Map<string, ProviderDetails>([
      [
        providerId.toString(),
        {
          baseUrl,
          userGraphEndpoint,
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

  public providerBaseUrl(id: bigint): URL {
    return this.providerMap.get(id.toString())?.baseUrl!;
  }

  public providerUserGraphEndpoint(id: bigint): string {
    return this.providerMap.get(id.toString())?.userGraphEndpoint!;
  }

  public providerApiToken(id: bigint): string {
    return this.providerMap.get(id.toString())?.apiToken!;
  }
}
