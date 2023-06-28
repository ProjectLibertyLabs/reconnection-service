/*
https://docs.nestjs.com/providers#services
*/

import axios, { AxiosError, AxiosInstance } from "axios";
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { options } from '@frequency-chain/api-augment';
import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api';
import { MessageSourceId, ProviderId } from '@frequency-chain/api-augment/interfaces';
import { ConfigService } from '../config/config.service';

@Injectable()
export class ReconnectionGraphService implements OnApplicationBootstrap, OnApplicationShutdown {
  private api: ApiPromise;
  private logger: Logger;

  constructor(private configService: ConfigService) {
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

    await this.getUserGraphFromProvider(dsnpUserId, providerId);

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

  async getUserGraphFromProvider(dsnpUserId: MessageSourceId, providerId: ProviderId, pageNumber?: number, pageSize?: number): Promise<any> {
    const headers = {
      'Authorization': 'Bearer <access_token>', // Replace with your actual access token if required
    };
    const baseUrl = this.configService.providerBaseUrl(providerId.toBigInt());

    const params = {}
    if (pageNumber !== undefined) {
      params['pageNumber'] = pageNumber;
    }
    if (pageSize !== undefined) {
      params['pageSize'] = pageSize;
    }

    let providerAPI: AxiosInstance = axios.create({
      baseURL: baseUrl.toString(),
      headers: headers
    });

    try {
      const response = await providerAPI.get('/api/v1.0.0/connections/');
      if (response.status != 200) {
        throw new Error(`Bad status ${response.status} (${response.statusText} from Provider web hook.)`)
      }

      //TODO Remove this code
      this.logger.log("GOT RESPONSE!");
      this.logger.log(response);

      return response.data;

    } catch (e) {
      if (e instanceof AxiosError) {
        throw new Error(JSON.stringify(e));
      } else { throw e; }
    }
  }

  // TODO define interfaces for the request / response to / from the provider webhook
  // async get_user_graph_from_provider(dsnpUserId: u64): {}
}
