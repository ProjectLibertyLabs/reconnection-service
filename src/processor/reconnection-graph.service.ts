/*
https://docs.nestjs.com/providers#services
*/

import axios, { AxiosError, AxiosInstance } from "axios";
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { options } from '@frequency-chain/api-augment';
import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api';
import { ItemizedStoragePageResponse, ItemizedStorageResponse, MessageSourceId, PaginatedStorageResponse, ProviderId } from '@frequency-chain/api-augment/interfaces';
import { ConfigService } from '../config/config.service';
import { GraphStateManager } from '../graph/graph-state-manager';
import { GraphKeyPair, ProviderGraph } from '../interfaces/provider-graph.interface';
import { Action, Config, ConnectAction, Connection, ConnectionType, DsnpKeys, GraphKeyType, ImportBundle, KeyData, PrivacyType, Update } from '@dsnp/graph-sdk';
import { ImportBundleBuilder } from "#app/graph/import-bundle-builder";

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
    
    // get the user's DSNP Graph from the blockchain and form import bundles
    const importBundles = await this.formImportBundles(dsnpUserId, graphSdkConfig, graphKeyPair);
    await this.graphStateManager.importUserData(importBundles).then((results) => {
      throw new Error(JSON.stringify("importUserData results: " + results));
    });

    // using graphConnections form Action[] and update the user's DSNP Graph
    const actions: ConnectAction[] = await this.formConnections(dsnpUserId, graphSdkConfig, graphConnections);
    await this.graphStateManager.applyActions(actions).then((results) => {
      throw new Error(JSON.stringify("applyActions results: " + results));
    });

    const exportedUpdates: Update[] = await this.graphStateManager.exportGraphUpdates();
    
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

  async formImportBundles(dsnpUserId: MessageSourceId, graphSdkConfig: Config, graphKeyPair: GraphKeyPair): Promise<ImportBundle[]> {
    let importBundles: ImportBundle[] = [];
    const public_follow_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Public);
    const public_friendship_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Public);
    const private_follow_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Private);
    const private_friendship_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Private);

    const publicFollows: PaginatedStorageResponse[] = await this.api.rpc.statefulStorage.getPaginatedStorage(public_follow_schema_id, dsnpUserId);
    const publicFriendships: PaginatedStorageResponse[] = await this.api.rpc.statefulStorage.getPaginatedStorage(public_friendship_schema_id, dsnpUserId);
    const privateFollows: PaginatedStorageResponse[] = await this.api.rpc.statefulStorage.getPaginatedStorage(private_follow_schema_id, dsnpUserId);
    const privateFriendships: PaginatedStorageResponse[] = await this.api.rpc.statefulStorage.getPaginatedStorage(private_friendship_schema_id, dsnpUserId);

    const dsnpKeys = await this.formDsnpKeys(dsnpUserId, graphSdkConfig);

    importBundles.push(...publicFollows.map((publicFollow) => {
      return ImportBundleBuilder.setDsnpUserId(dsnpUserId.toString())
        .setSchemaId(public_follow_schema_id)
        .setDsnpKeys(dsnpKeys)
        .setDsnpUserId(dsnpUserId.toString())
        .addPageData(publicFollow.page_id.toNumber(), publicFollow.payload, publicFollow.content_hash.toNumber())
        .addGraphKeyPair(GraphKeyType.X25519, graphKeyPair.publicKey, graphKeyPair.privateKey)
        .build();
    }));

    importBundles.push(...publicFriendships.map((publicFriendship) => {
      return ImportBundleBuilder.setDsnpUserId(dsnpUserId.toString())
        .setSchemaId(public_friendship_schema_id)
        .setDsnpKeys(dsnpKeys)
        .setDsnpUserId(dsnpUserId.toString())
        .addPageData(publicFriendship.page_id.toNumber(), publicFriendship.payload, publicFriendship.content_hash.toNumber())
        .addGraphKeyPair(GraphKeyType.X25519, graphKeyPair.publicKey, graphKeyPair.privateKey)
        .build();
    }));

    importBundles.push(...privateFollows.map((privateFollow) => {
      return ImportBundleBuilder.setDsnpUserId(dsnpUserId.toString())
        .setSchemaId(private_follow_schema_id)
        .setDsnpKeys(dsnpKeys)
        .setDsnpUserId(dsnpUserId.toString())
        .addPageData(privateFollow.page_id.toNumber(), privateFollow.payload, privateFollow.content_hash.toNumber())
        .addGraphKeyPair(GraphKeyType.X25519, graphKeyPair.publicKey, graphKeyPair.privateKey)
        .build();
    }));

    importBundles.push(...privateFriendships.map((privateFriendship) => {
      return ImportBundleBuilder.setDsnpUserId(dsnpUserId.toString())
        .setSchemaId(private_friendship_schema_id)
        .setDsnpKeys(dsnpKeys)
        .setDsnpUserId(dsnpUserId.toString())
        .addPageData(privateFriendship.page_id.toNumber(), privateFriendship.payload, privateFriendship.content_hash.toNumber())
        .addGraphKeyPair(GraphKeyType.X25519, graphKeyPair.publicKey, graphKeyPair.privateKey)
        .build();
    }));
    
    return importBundles;
  }

  async formConnections(dsnpUserId: MessageSourceId, graphSdkConfig: Config, graphConnections: ProviderGraph[]): Promise<ConnectAction[]> {
    const dsnpKeys = await this.formDsnpKeys(dsnpUserId, graphSdkConfig);
    const public_follow_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Public);
    const public_friendship_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Public);
    const private_follow_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Private);
    const private_friendship_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Private);

    let actions: ConnectAction[] = [];
    graphConnections.forEach((connection) => {
      let schemaId: number;
      const connectionType = connection.connectionType.toLowerCase();
      const privacyType = connection.privacyType.toLowerCase();
      
      switch (connectionType) {
        case 'follow':
          schemaId = privacyType === 'public' ? public_follow_schema_id : private_follow_schema_id;
          break;
        case 'friendship':
          schemaId = privacyType === 'public' ? public_friendship_schema_id : private_friendship_schema_id;
          break;
        default:
          throw new Error(`Unrecognized connection type: ${connectionType}`);
      }

      switch(connection.direction) {
        case 'connectionTo':
          actions.push({
            ownerDsnpUserId: dsnpUserId.toString(),
            dsnpKeys: dsnpKeys,
            connection: {
              dsnpUserId: connection.dsnpId,
              schemaId,
            } as Connection,
          } as ConnectAction);
        case 'connectionFrom':{
          // queue an event to update the other user's graph
          // TODO
        }
        case 'bidirectional':{
          actions.push({
            ownerDsnpUserId: dsnpUserId.toString(),
            dsnpKeys: dsnpKeys,
            connection: {
              dsnpUserId: connection.dsnpId,
              schemaId,
            } as Connection,
          } as ConnectAction);
          
          // queue an event to update the other user's graph
          // TODO
        }
        default:
          throw new Error(`Unrecognized connection direction: ${connection.direction}`);
      }
    });
    return actions;
  }

  async formDsnpKeys(dsnpUserId: MessageSourceId, graphSdkConfig: Config): Promise<DsnpKeys> {
    const public_key_schema_id = graphSdkConfig.graphPublicKeySchemaId;
    let publicKeys: ItemizedStoragePageResponse = await this.api.rpc.statefulStorage.getItemizedStorage(public_key_schema_id, dsnpUserId);
    
    const dsnpKeys: DsnpKeys = {
      dsnpUserId: dsnpUserId.toString(),
      keysHash: publicKeys.content_hash.toNumber(),
      keys: publicKeys.items.map((item: ItemizedStorageResponse) => {
        return {
          index: item.index.toNumber(),
          content: item.payload.toU8a(),
        } as KeyData;
      }),
    };

    return dsnpKeys;
  }
}
