/*
https://docs.nestjs.com/providers#services
*/

import axios, { AxiosError, AxiosInstance } from 'axios';
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { options } from '@frequency-chain/api-augment';
import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api';
import { ItemizedStoragePageResponse, ItemizedStorageResponse, MessageSourceId, PaginatedStorageResponse, ProviderId } from '@frequency-chain/api-augment/interfaces';
import { ConfigService } from '../config/config.service';
import { GraphStateManager } from '../graph/graph-state-manager';
import { GraphKeyPair, KeyType, ProviderGraph } from '../interfaces/provider-graph.interface';
import { ImportBundleBuilder, Config, ConnectAction, Connection, ConnectionType, DsnpKeys, GraphKeyType, ImportBundle, KeyData, PrivacyType, Update } from '@dsnp/graph-sdk';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SkipTransitiveGraphs, createGraphUpdateJob } from '#app/interfaces/graph-update-job.interface';
import { ExtrinsicHelper } from '../scaffolding/extrinsicHelpers';

@Injectable()
export class ReconnectionGraphService implements OnApplicationBootstrap, OnApplicationShutdown {
  private api: ApiPromise;

  private logger: Logger;

  constructor(
    private configService: ConfigService,
    private graphStateManager: GraphStateManager,
    @InjectQueue('graphUpdateQueue') private graphUpdateQueue: Queue,
    ) {
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

    const [graphConnections, graphKeyPairs] = await this.getUserGraphFromProvider(dsnpUserId, providerId);
    // graph config and respective schema ids
    const graphSdkConfig  = await this.graphStateManager.getGraphConfig();

    // get the user's DSNP Graph from the blockchain and form import bundles
    const importBundles = await this.formImportBundles(dsnpUserId, graphSdkConfig, graphKeyPairs);
    await this.graphStateManager.importUserData(importBundles);

    let exportedUpdates: Update[] = [];

    if (updateConnections) {
      // using graphConnections form Action[] and update the user's DSNP Graph
      const actions: ConnectAction[] = await this.formConnections(dsnpUserId, providerId, graphSdkConfig, graphConnections);
      await this.graphStateManager.applyActions(actions);
      exportedUpdates = await this.graphStateManager.exportGraphUpdates();
    }else {
      exportedUpdates = await this.graphStateManager.forceCalculateGraphs(dsnpUserId.toString());
    }

    exportedUpdates.forEach(async (bundle) => {
      let op: any;
      switch (bundle.type) {
        case 'PersistPage':
          // Send exported updates to the chain
          // op = ExtrinsicHelper.upsertPage(alice.keypair, schemaId, alice.msaId, bundle.ownerDsnpUserId, bundle.payload, bundle.prevHash);
          // await ExtrinsicHelper.api.tx.frequencyTxPayment.payWithCapacityBatchAll(calls)
          break;

        default:
          break;
      }
    });
    // TODO
    // Re-import DSNP Graph from chain & verify
    //     (if updating connections as well, do the same for connections--but do not transitively update connections - of - connections)
  }

  async getUserGraphFromProvider(dsnpUserId: MessageSourceId, providerId: ProviderId): Promise<any> {
    const headers = {
      Authorization: 'Bearer <access_token>', // Replace with your actual access token if required
    };
    const baseUrl = this.configService.providerBaseUrl(providerId.toBigInt());

    const params = {
      pageNumber: 1,
      pageSize: 10, // This likely should be increased for production values
    };

    const providerAPI: AxiosInstance = axios.create({
      baseURL: baseUrl.toString(),
      headers,
    });

    const allConnections: ProviderGraph[] = [];
    const keyPairs: GraphKeyPair[] = [];
    try {
      let hasNextPage = true;
      while (hasNextPage) {
        // eslint-disable-next-line no-await-in-loop
        const response = await providerAPI.get('/api/v1.0.0/connections/', { params });

        if (response.status !== 200) {
          throw new Error(`Bad status ${response.status} (${response.statusText} from Provider web hook.)`);
        }

        const { data }: { data: ProviderGraph[] } = response.data.connections;
        allConnections.push(...data);

        const { graphKeypair }: { graphKeypair: GraphKeyPair[] } = response.data.keyPairs;
        if (graphKeypair) {
          keyPairs.push(...graphKeypair);
        }

        const { pagination } = response.data.connections;
        if (pagination && pagination.pageCount && pagination.pageCount > params.pageNumber) {
          // Increment the page number to fetch the next page
          params.pageNumber += 1;
        } else {
          // No more pages available, exit the loop
          hasNextPage = false;
        }
      }

      return [allConnections, keyPairs];
    } catch (e) {
      if (e instanceof AxiosError) {
        throw new Error(JSON.stringify(e));
      } else {
        throw e;
      }
    }
  }

  async formImportBundles(dsnpUserId: MessageSourceId, graphSdkConfig: Config, graphKeyPair: GraphKeyPair[]): Promise<ImportBundle[]> {
    const importBundles: ImportBundle[] = [];
    const public_follow_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Public);
    const public_friendship_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Public);
    const private_follow_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Private);
    const private_friendship_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Private);

    const publicFollows: PaginatedStorageResponse[] = await this.api.rpc.statefulStorage.getPaginatedStorage(dsnpUserId, public_follow_schema_id);
    const publicFriendships: PaginatedStorageResponse[] = await this.api.rpc.statefulStorage.getPaginatedStorage(dsnpUserId, public_friendship_schema_id);
    const privateFollows: PaginatedStorageResponse[] = await this.api.rpc.statefulStorage.getPaginatedStorage(dsnpUserId, private_follow_schema_id);
    const privateFriendships: PaginatedStorageResponse[] = await this.api.rpc.statefulStorage.getPaginatedStorage(dsnpUserId, private_friendship_schema_id);

    const dsnpKeys = await this.formDsnpKeys(dsnpUserId, graphSdkConfig);

    const importBundleBuilder = new ImportBundleBuilder();
    // Only X25519 is supported for now
    // check if all keys are of type X25519
    const areKeysCorrectType = graphKeyPair.every((keyPair) => keyPair.keyType === KeyType.X25519);
    if (!areKeysCorrectType) {
      throw new Error('Only X25519 keys are supported for now');
    }

    importBundles.push(
      ...publicFollows.map((publicFollow) => {
          importBundleBuilder
            .withDsnpUserId(dsnpUserId.toString())
            .withSchemaId(public_follow_schema_id)
            .withPageData(publicFollow.page_id.toNumber(), publicFollow.payload, publicFollow.content_hash.toNumber())
          if (dsnpKeys) {
            importBundleBuilder.withDsnpKeys(dsnpKeys);
          }
          return importBundleBuilder.build();
      }));

    importBundles.push(
      ...publicFriendships.map((publicFriendship) => {
        importBundleBuilder
          .withDsnpUserId(dsnpUserId.toString())
          .withSchemaId(public_friendship_schema_id)
          .withPageData(publicFriendship.page_id.toNumber(), publicFriendship.payload, publicFriendship.content_hash.toNumber())

        if (dsnpKeys) {
          importBundleBuilder.withDsnpKeys(dsnpKeys);
        }
        return importBundleBuilder.build();
      }));

    importBundles.push(
      ...privateFollows.map((privateFollow) => {
        importBundleBuilder
          .withDsnpUserId(dsnpUserId.toString())
          .withSchemaId(private_follow_schema_id)
          .withPageData(privateFollow.page_id.toNumber(), privateFollow.payload, privateFollow.content_hash.toNumber())
          
          if (dsnpKeys) {
            importBundleBuilder.withDsnpKeys(dsnpKeys);
          }

          if (graphKeyPair.length > 0) {
            // write each key to the graph
            graphKeyPair.forEach((keyPair) => {
              importBundleBuilder.withGraphKeyPair(GraphKeyType.X25519, keyPair.publicKey, keyPair.privateKey);
            });
          }
          return importBundleBuilder.build();
        }));

    importBundles.push(
      ...privateFriendships.map((privateFriendship) => {
        importBundleBuilder
          .withDsnpUserId(dsnpUserId.toString())
          .withSchemaId(private_friendship_schema_id)
          .withPageData(privateFriendship.page_id.toNumber(), privateFriendship.payload, privateFriendship.content_hash.toNumber())

        if (dsnpKeys) {
          importBundleBuilder.withDsnpKeys(dsnpKeys);
        }

        if (graphKeyPair.length > 0) {
          // write each key to the graph
          graphKeyPair.forEach((keyPair) => {
            importBundleBuilder.withGraphKeyPair(GraphKeyType.X25519, keyPair.publicKey, keyPair.privateKey);
          });
        }

        return importBundleBuilder.build();
      }));

    return importBundles;
  }


  async formConnections(dsnpUserId: MessageSourceId, providerId: MessageSourceId, graphSdkConfig: Config, graphConnections: ProviderGraph[]): Promise<ConnectAction[]> {
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
        case 'connectionTo': {
          let connectionAction: ConnectAction = {
            type: "Connect",
            ownerDsnpUserId: dsnpUserId.toString(),
            connection: {
              dsnpUserId: connection.dsnpId,
              schemaId,
            },
          };

          if (dsnpKeys) {
            connectionAction['dsnpKeys'] = dsnpKeys;
          }
          actions.push(connectionAction);
          break;
        }
        case 'connectionFrom':{
          const { key: jobId, data } = createGraphUpdateJob(connection.dsnpId, providerId, SkipTransitiveGraphs);
          this.graphUpdateQueue.add('graphUpdate', data, { jobId });
          break;
        }
        case 'bidirectional':{
          let connectionAction: ConnectAction = {
            type: "Connect",
            ownerDsnpUserId: dsnpUserId.toString(),
            connection: {
              dsnpUserId: connection.dsnpId,
              schemaId,
            },
          };

          if (dsnpKeys) {
            connectionAction['dsnpKeys'] = dsnpKeys;
          }
          actions.push(connectionAction);
          const { key: jobId, data } = createGraphUpdateJob(connection.dsnpId, providerId, SkipTransitiveGraphs);
          this.graphUpdateQueue.add('graphUpdate', data, { jobId });
          break;
        }
        default:
          throw new Error(`Unrecognized connection direction: ${connection.direction}`);
      }
    });
    return actions;
  }

  async formDsnpKeys(dsnpUserId: MessageSourceId, graphSdkConfig: Config): Promise<DsnpKeys | undefined> {
    const public_key_schema_id = graphSdkConfig.graphPublicKeySchemaId;
    let publicKeys: ItemizedStoragePageResponse = await this.api.rpc.statefulStorage.getItemizedStorage(dsnpUserId, public_key_schema_id);

    let dsnpKeys: DsnpKeys | undefined;
    if (publicKeys.items.length > 0) {
      dsnpKeys = {
        dsnpUserId: dsnpUserId.toString(),
        keysHash: publicKeys.content_hash.toNumber(),
        keys: publicKeys.items.map((item: ItemizedStorageResponse): KeyData => ({
          index: item.index.toNumber(),
          content: item.payload.toU8a(),
        })),
      };
    } else {
      dsnpKeys = undefined;
    }

    return dsnpKeys;
  }
}
