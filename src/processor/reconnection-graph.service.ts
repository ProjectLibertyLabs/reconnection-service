/*
https://docs.nestjs.com/providers#services
*/

import axios, { AxiosError, AxiosInstance } from "axios";
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { options } from '@frequency-chain/api-augment';
import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api';
import { MessageSourceId, ProviderId } from '@frequency-chain/api-augment/interfaces';
import { ConfigService } from '../config/config.service';
import { GraphStateManager } from '../graph/graph-state-manager';
import { GraphKeyPair, ProviderGraph } from '../interfaces/provider-graph.interface';
import { ConnectionType, PrivacyType } from '@dsnp/graph-sdk';

@Injectable()
export class ReconnectionGraphService implements OnApplicationBootstrap, OnApplicationShutdown {
  private api: ApiPromise;
  private logger: Logger;

  constructor(private configService: ConfigService, private graphStateManager: GraphStateManager) {
    this.logger = new Logger(ReconnectionGraphService.name);
  }

  async onApplicationBootstrap() {
    const chainUrl = this.configService.frequencyUrl;
    let chainProvider: any;
    if (/^ws/.test(chainUrl.toString())) {
      chainProvider = new WsProvider(chainUrl.toString());
    } else if (/^http/.test(chainUrl.toString())) {
      chainProvider = new HttpProvider(chainUrl.toString());
    } else {
      this.logger.error(`Unrecognized chain URL type: ${chainUrl.toString()}`);
      throw new Error('Unrecognized chain URL type');
    }
    this.api = await ApiPromise.create({ provider: chainProvider, ...options });
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

    // TODO set state based on the response from getUserGraphFromProvider
    const [graphConnections, graphKeyPair] = await this.getUserGraphFromProvider(dsnpUserId, providerId);
    this.logger.log("graphConnections", graphConnections);
    this.logger.log("graphKeyPair", graphKeyPair);

    // graph config and respective schema ids
    const graphSdkConfig  = await this.graphStateManager.getGraphConfig();
    const public_follow_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Public);
    const public_friendship_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Public);
    const private_follow_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Private);
    const private_friendship_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Private);
    
    // TODO
    // https://github.com/AmplicaLabs/reconnection-service/issues/21
    // Calling out to the blockchain to obtain the user's DSNP Graph
    // Import the DSNP Graph into GraphSDK
    // https://github.com/AmplicaLabs/reconnection-service/issues/22
    // Adding missing connections to the user's DSNP Graph using GraphSDK API
    // Export DSNP Graph changes and send to blockchain
    // Re-import DSNP Graph from chain & verify
    //     (if updating connections as well, do the same for connections--but do not transitively update connections - of - connections)
  }

  async getUserGraphFromProvider(dsnpUserId: MessageSourceId, providerId: ProviderId): Promise<any> {
    const headers = {
      'Authorization': 'Bearer <access_token>', // Replace with your actual access token if required
    };
    const baseUrl = this.configService.providerBaseUrl(providerId.toBigInt());

    const params = {
      pageNumber: 1,
      pageSize: 10, // This likely should be increased for production values
    };

    let providerAPI: AxiosInstance = axios.create({
      baseURL: baseUrl.toString(),
      headers: headers
    });

    let allConnections: ProviderGraph[] = [];
    let keyPair = {};
    try {
      let hasNextPage = true;
      while (hasNextPage) {
        const response = await providerAPI.get('/api/v1.0.0/connections/', { params });

        if (response.status != 200) {
          throw new Error(`Bad status ${response.status} (${response.statusText} from Provider web hook.)`)
        }

        const { data }: { data: ProviderGraph[] } = response.data.connections;
        allConnections.push(...data);

        const { graphKeypair }: { graphKeypair: GraphKeyPair } = response.data;
        if (graphKeypair) {
          keyPair = graphKeypair;
        }


        const { pagination } = response.data.connections;
        if (pagination && pagination.pageCount && pagination.pageCount > params.pageNumber) {
          // Increment the page number to fetch the next page
          params.pageNumber++;
        } else {
          // No more pages available, exit the loop
          hasNextPage = false;
        }
      }

      return [allConnections, keyPair];

    } catch (e) {
      if (e instanceof AxiosError) {
        throw new Error(JSON.stringify(e));
      } else {
        throw e;
      }
    }
  }
}
