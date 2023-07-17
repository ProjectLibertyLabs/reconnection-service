/*
https://docs.nestjs.com/providers#services
*/

import axios, { AxiosError, AxiosInstance } from 'axios';
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { options } from '@frequency-chain/api-augment';
import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api';
import { ItemizedStoragePageResponse, ItemizedStorageResponse, MessageSourceId, PaginatedStorageResponse, ProviderId } from '@frequency-chain/api-augment/interfaces';
import { ImportBundleBuilder, Config, ConnectAction, ConnectionType, DsnpKeys, GraphKeyType, ImportBundle, KeyData, PrivacyType, Update, GraphKeyPair } from '@dsnp/graph-sdk';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SkipTransitiveGraphs, UpdateTransitiveGraphs, createGraphUpdateJob } from '#app/interfaces/graph-update-job.interface';
import { GraphKeyPair as ProviderKeyPair, KeyType, ProviderGraph } from '../interfaces/provider-graph.interface';
import { GraphStateManager } from '../graph/graph-state-manager';
import { ConfigService } from '../config/config.service';
import { ExtrinsicHelper } from '../scaffolding/extrinsicHelpers';
import { createKeys } from "../scaffolding/apiConnection";
import { SubmittableExtrinsic } from '@polkadot/api-base/types';
import { ISubmittableResult } from '@polkadot/types/types';


@Injectable()
export class ReconnectionGraphService implements OnApplicationBootstrap, OnApplicationShutdown {
  private api: ApiPromise;

  private logger: Logger;

  constructor(private configService: ConfigService, private graphStateManager: GraphStateManager, @InjectQueue('graphUpdateQueue') private graphUpdateQueue: Queue) {
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
    await ExtrinsicHelper.initialize();
  }

  async onApplicationShutdown() {
    await this.api.disconnect();
    await ExtrinsicHelper.api.disconnect();
    await ExtrinsicHelper.apiPromise.disconnect();
  }

  public get capacityBatchLimit(): number {
    return this.api.consts.frequencyTxPayment.maximumCapacityBatchLength.toNumber();
  }

  public async updateUserGraph(dsnpUserStr: string, providerStr: string, updateConnections: boolean): Promise<void> {
    this.logger.debug(`Updating graph for user ${dsnpUserStr}, provider ${providerStr}`);
    const dsnpUserId: MessageSourceId = this.api.registry.createType('MessageSourceId', dsnpUserStr);
    const providerId: ProviderId = this.api.registry.createType('ProviderId', providerStr);
    const { key: jobId_nt, data: data_nt } = createGraphUpdateJob(dsnpUserId, providerId, SkipTransitiveGraphs);
  
    let graphConnections: ProviderGraph[] = [];
    let graphKeyPairs: ProviderKeyPair[] = [];
    try {
      [graphConnections, graphKeyPairs] = await this.getUserGraphFromProvider(dsnpUserId, providerId);
    } catch (e) {
      this.logger.error(`Error getting user graph from provider: ${e}`);
      throw e;
    }
  
    try {
      // graph config and respective schema ids
      const graphSdkConfig = await this.graphStateManager.getGraphConfig();
  
      // get the user's DSNP Graph from the blockchain and form import bundles
      // import bundles are used to import the user's DSNP Graph into the graph SDK
      await this.importBundles(dsnpUserId, providerId, graphSdkConfig, graphKeyPairs, graphConnections, updateConnections);
  
      let exportedUpdates: Update[] = [];
  
      if (updateConnections) {
        // using graphConnections form Action[] and update the user's DSNP Graph
        const actions: ConnectAction[] = await this.formConnections(dsnpUserId, providerId, graphSdkConfig, graphConnections);
        try {
          await this.graphStateManager.applyActions(actions);
        } catch (e) {
          // silenty fail graphsdk handles duplicate connections
          this.logger.error(`Error applying actions: ${e}`);
        }
        exportedUpdates = await this.graphStateManager.exportGraphUpdates();
      } else {
        exportedUpdates = await this.graphStateManager.forceCalculateGraphs(dsnpUserId.toString());
      }
  
      let providerKeys = createKeys(this.configService.getProviderAccountSeedPhrase());
      let calls: SubmittableExtrinsic<"rxjs", ISubmittableResult>[] = [];
      const mapUserIdToUpdates = new Map<string, Update[]>();
      // loop over exportUpdates and collect Updates vs userId
      exportedUpdates.forEach((bundle) => {
        const ownerMsaId: MessageSourceId = this.api.registry.createType('MessageSourceId', bundle.ownerDsnpUserId);
        if (mapUserIdToUpdates.has(ownerMsaId.toString())) {
          const updates = mapUserIdToUpdates.get(ownerMsaId.toString()) || [];
          updates.push(bundle);
          mapUserIdToUpdates.set(ownerMsaId.toString(), updates);
        } else {
          mapUserIdToUpdates.set(ownerMsaId.toString(), [bundle]);
        }
      });

      for (const [userId, updates] of mapUserIdToUpdates.entries()) {
        let batch: SubmittableExtrinsic<"rxjs", ISubmittableResult>[] = [];
        let batchCount = 0;
        let promises: Promise<any>[] = [];
        updates.forEach((bundle) => {
          const ownerMsaId: MessageSourceId = this.api.registry.createType('MessageSourceId', userId);
          switch (bundle.type) {
            case 'PersistPage':
              const payload: any = Array.from(Array.prototype.slice.call(bundle.payload));
              const upsertPageCall = ExtrinsicHelper.api.tx.statefulStorage.upsertPage(
                ownerMsaId,
                bundle.schemaId,
                bundle.pageId,
                bundle.prevHash,
                payload,
              );
  
              batch.push(upsertPageCall);
              batchCount++;
  
              // If the batch size exceeds the capacityBatchLimit, send the batch to the chain
              if (batchCount === this.capacityBatchLimit) {
                const payWithCapacityBatchAllOp = ExtrinsicHelper.payWithCapacityBatchAll(providerKeys, batch);
                promises.push(payWithCapacityBatchAllOp.signAndSend());
                // Reset the batch and count for the next batch
                batch = [];
                batchCount = 0;
              }
              break;
  
            default:
              break;
          }
        });
        
        await Promise.all(promises);
        // Check for BatchCompleted event after all promises are resolved
        for (const promise of promises) {
          const [batchCompletedEvent, eventMap] = await promise;
          if (!(batchCompletedEvent && ExtrinsicHelper.api.events.utility.BatchCompleted.is(batchCompletedEvent))) {
            throw new Error('BatchCompleted event not found');
          }
        }
      
        // Send the remaining batch to the chain if it's not empty
        if (batch.length > 0) {
          const payWithCapacityBatchAllOp = ExtrinsicHelper.payWithCapacityBatchAll(providerKeys, batch);
          const [batchCompletedEvent, eventMap] = await payWithCapacityBatchAllOp.signAndSend();
          if (batchCompletedEvent && !(ExtrinsicHelper.api.events.utility.BatchCompleted.is(batchCompletedEvent))) {
            throw new Error('BatchCompleted event not found');
          }
        }
      }
  
      // On successful export to chain, re-import the user's DSNP Graph from the blockchain and form import bundles
      // import bundles are used to import the user's DSNP Graph into the graph SDK
      // check if user graph exists in the graph SDK else queue a graph update job
      const reImported = await this.importBundles(dsnpUserId, providerId, graphSdkConfig, graphKeyPairs, graphConnections, updateConnections);
      if (reImported) {
        const userGraphExists = await this.graphStateManager.graphContainsUser(dsnpUserId.toString());
        if (!userGraphExists) {
          throw new Error(`User graph does not exist for ${dsnpUserId.toString()}`);
        }
      } else {
        throw new Error(`Error re-importing bundles for ${dsnpUserId.toString()}`);       
      }
    } catch (err) {
      if (updateConnections) {
        this.graphUpdateQueue.add('graphUpdate', data_nt, { jobId: jobId_nt });
      } else {
        this.logger.error(err);
        throw err;
      }
    }
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

        const { graphKeypair }: { graphKeypair: GraphKeyPair[] } = response.data.graphKeyPairs;
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

  async importBundles(dsnpUserId: MessageSourceId, providerId: ProviderId, graphSdkConfig: Config, graphKeyPairs: ProviderKeyPair[], graphConnections: ProviderGraph[], updateConnections: boolean): Promise<boolean> {
    const importBundles = await this.formImportBundles(dsnpUserId, graphSdkConfig, graphKeyPairs);
    return this.graphStateManager.importUserData(importBundles);
  }

  async formImportBundles(dsnpUserId: MessageSourceId, graphSdkConfig: Config, graphKeyPairs: ProviderKeyPair[]): Promise<ImportBundle[]> {
    const importBundles: ImportBundle[] = [];
    const public_follow_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Public);
    const public_friendship_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Public);
    const private_follow_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Private);
    const private_friendship_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Private);

    const publicFollows: PaginatedStorageResponse[] = await this.api.rpc.statefulStorage.getPaginatedStorage(dsnpUserId, public_follow_schema_id);
    const publicFriendships: PaginatedStorageResponse[] = await this.api.rpc.statefulStorage.getPaginatedStorage(dsnpUserId, public_friendship_schema_id);
    const privateFollows: PaginatedStorageResponse[] = await this.api.rpc.statefulStorage.getPaginatedStorage(dsnpUserId, private_follow_schema_id);
    const privateFriendships: PaginatedStorageResponse[] = await this.api.rpc.statefulStorage.getPaginatedStorage(dsnpUserId, private_friendship_schema_id);

    let importBundleBuilder = new ImportBundleBuilder();
    // Only X25519 is supported for now
    // check if all keys are of type X25519
    const areKeysCorrectType = graphKeyPairs.every((keyPair) => keyPair.keyType === KeyType.X25519);
    if (!areKeysCorrectType) {
      throw new Error('Only X25519 keys are supported for now');
    }

    importBundles.push(
      ...publicFollows.map((publicFollow) =>
        importBundleBuilder
          .withDsnpUserId(dsnpUserId.toString())
          .withSchemaId(public_follow_schema_id)
          .withPageData(publicFollow.page_id.toNumber(), publicFollow.payload, publicFollow.content_hash.toNumber())
          .build()
          ));

    importBundles.push(
      ...publicFriendships.map((publicFriendship) =>
        importBundleBuilder
          .withDsnpUserId(dsnpUserId.toString())
          .withSchemaId(public_friendship_schema_id)
          .withPageData(publicFriendship.page_id.toNumber(), publicFriendship.payload, publicFriendship.content_hash.toNumber())
          .build()
          ));

    if(privateFollows.length > 0 || privateFriendships.length > 0) {
      const dsnpKeys = await this.formDsnpKeys(dsnpUserId, graphSdkConfig);
      const graphKeyPairsSdk = graphKeyPairs.map((keyPair: ProviderKeyPair): GraphKeyPair => ({
        keyType: GraphKeyType.X25519,
        publicKey: keyPair.publicKey,
        secretKey: keyPair.privateKey,
      }));

      importBundles.push(
        ...privateFollows.map((privateFollow) =>
          importBundleBuilder
            .withDsnpUserId(dsnpUserId.toString())
            .withSchemaId(private_follow_schema_id)
            .withPageData(privateFollow.page_id.toNumber(), privateFollow.payload, privateFollow.content_hash.toNumber())
            .withDsnpKeys(dsnpKeys)
            .withGraphKeyPairs(graphKeyPairsSdk)
            .build()
            ));

      importBundles.push(
        ...privateFriendships.map((privateFriendship) =>
          importBundleBuilder
            .withDsnpUserId(dsnpUserId.toString())
            .withSchemaId(private_friendship_schema_id)
            .withPageData(privateFriendship.page_id.toNumber(), privateFriendship.payload, privateFriendship.content_hash.toNumber())
            .withDsnpKeys(dsnpKeys)
            .withGraphKeyPairs(graphKeyPairsSdk)
            .build()
            ));
    }
    return importBundles;
  }

  async formConnections(dsnpUserId: MessageSourceId, providerId: MessageSourceId, graphSdkConfig: Config, graphConnections: ProviderGraph[]): Promise<ConnectAction[]> {
    const dsnpKeys = await this.formDsnpKeys(dsnpUserId, graphSdkConfig);
    const public_follow_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Public);
    const public_friendship_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Public);
    const private_follow_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Private);
    const private_friendship_schema_id = await this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Private);

    const actions: ConnectAction[] = [];
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

      switch (connection.direction) {
        case 'connectionTo': {
          const connectionAction: ConnectAction = {
            type: 'Connect',
            ownerDsnpUserId: dsnpUserId.toString(),
            connection: {
              dsnpUserId: connection.dsnpId,
              schemaId,
            },
          };

          if (dsnpKeys) {
            connectionAction.dsnpKeys = dsnpKeys;
          }
          actions.push(connectionAction);
          break;
        }
        case 'connectionFrom': {
          const { key: jobId, data } = createGraphUpdateJob(connection.dsnpId, providerId, SkipTransitiveGraphs);
          this.graphUpdateQueue.add('graphUpdate', data, { jobId });
          break;
        }
        case 'bidirectional': {
          const connectionAction: ConnectAction = {
            type: 'Connect',
            ownerDsnpUserId: dsnpUserId.toString(),
            connection: {
              dsnpUserId: connection.dsnpId,
              schemaId,
            },
          };

          if (dsnpKeys) {
            connectionAction.dsnpKeys = dsnpKeys;
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

  async formDsnpKeys(dsnpUserId: MessageSourceId, graphSdkConfig: Config): Promise<DsnpKeys> {
    const public_key_schema_id = graphSdkConfig.graphPublicKeySchemaId;
    const publicKeys: ItemizedStoragePageResponse = await this.api.rpc.statefulStorage.getItemizedStorage(dsnpUserId, public_key_schema_id);
    const dsnpKeys = {
          dsnpUserId: dsnpUserId.toString(),
          keysHash: publicKeys.content_hash.toNumber(),
          keys: publicKeys.items.map(
            (item: ItemizedStorageResponse): KeyData => ({
              index: item.index.toNumber(),
              content: item.payload.toU8a(),
            }),
          ),
      };
    return dsnpKeys;
  }
}
