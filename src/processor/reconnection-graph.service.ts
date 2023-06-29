/*
https://docs.nestjs.com/providers#services
*/

import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { options } from '@frequency-chain/api-augment';
import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api';
import { MessageSourceId, ProviderId } from '@frequency-chain/api-augment/interfaces';
import { ConfigService } from '../config/config.service';
import { GraphStateManager } from '../graph/graph-state-manager';

@Injectable()
export class ReconnectionGraphService implements OnApplicationBootstrap, OnApplicationShutdown {
  private api: ApiPromise;

  private logger: Logger;

  constructor(private configService: ConfigService, private graphStateManager: GraphStateManager) {
    this.logger = new Logger(ReconnectionGraphService.name);
  }

  async onApplicationBootstrap() {
    const chainUrl = this.configService.frequencyUrl;
    let provider: any;
    if (/^ws/.test(chainUrl.toString())) {
      provider = new WsProvider(chainUrl.toString());
    } else if (/^http/.test(chainUrl.toString())) {
      provider = new HttpProvider(chainUrl.toString());
    } else {
      this.logger.error(`Unrecognized chain URL type: ${chainUrl.toString()}`);
      throw new Error('Unrecognized chain URL type');
    }
    this.api = await ApiPromise.create({ provider, ...options });
    await this.api.isReady;
    this.logger.log('Blockchain API ready.');
  }

  async onApplicationShutdown() {
    await this.api.disconnect();
  }

  public async updateUserGraph(dsnpUserStr: string, providerStr: string, updateConnections: boolean): Promise<void> {
    this.logger.debug(`Updating graph for user ${dsnpUserStr}, provider ${providerStr}`);
    const dsnpUserId: MessageSourceId = this.api.registry.createType('MessageSourceId', dsnpUserStr);
    const providerId: ProviderId = this.api.registry.createType('ProviderId', providerStr);
    // TODO
    // https://github.com/AmplicaLabs/reconnection-service/issues/20
    // Calling out to the provider to obtain a user's Provider graph
    // https://github.com/AmplicaLabs/reconnection-service/issues/21
    // Calling out to the blockchain to obtain the user's DSNP Graph
    // Import the DSNP Graph into GraphSDK
    // https://github.com/AmplicaLabs/reconnection-service/issues/22
    // Adding missing connections to the user's DSNP Graph using GraphSDK API
    // Export DSNP Graph changes and send to blockchain
    // Re-import DSNP Graph from chain & verify
    //     (if updating connections as well, do the same for connections--but do not transitively update connections - of - connections)
  }

  // TODO define interfaces for the request / response to / from the provider webhook
  // async get_user_graph_from_provider(dsnpUserId: u64): {}
}
