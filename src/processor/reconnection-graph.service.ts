import axios, { AxiosError, AxiosInstance } from 'axios';
import { Injectable, Logger } from '@nestjs/common';
import { ItemizedStoragePageResponse, ItemizedStorageResponse, MessageSourceId, PaginatedStorageResponse, ProviderId } from '@frequency-chain/api-augment/interfaces';
import {
  ImportBundleBuilder,
  Config,
  ConnectAction,
  Connection,
  ConnectionType,
  DsnpKeys,
  GraphKeyType,
  ImportBundle,
  KeyData,
  PrivacyType,
  Update,
  GraphKeyPair,
} from '@dsnp/graph-sdk';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SkipTransitiveGraphs, createGraphUpdateJob } from '#app/interfaces/graph-update-job.interface';
import { SubmittableExtrinsic } from '@polkadot/api-base/types';
import { AnyNumber, ISubmittableResult } from '@polkadot/types/types';
import { BlockchainService } from '#app/blockchain/blockchain.service';
import { createKeys } from '#app/blockchain/create-keys';
import { GraphKeyPair as ProviderKeyPair, KeyType, ProviderGraph } from '../interfaces/provider-graph.interface';
import { GraphStateManager } from '../graph/graph-state-manager';
import { ConfigService } from '../config/config.service';

@Injectable()
export class ReconnectionGraphService {
  private logger: Logger;

  constructor(
    private configService: ConfigService,
    private graphStateManager: GraphStateManager,
    @InjectQueue('graphUpdateQueue') private graphUpdateQueue: Queue,
    private blockchainService: BlockchainService,
  ) {
    this.logger = new Logger(ReconnectionGraphService.name);
  }

  public get capacityBatchLimit(): number {
    return this.blockchainService.api.consts.frequencyTxPayment.maximumCapacityBatchLength.toNumber();
  }

  public async updateUserGraph(dsnpUserStr: string, providerStr: string, updateConnections: boolean): Promise<void> {
    this.logger.debug(`Updating graph for user ${dsnpUserStr}, provider ${providerStr}`);
    const dsnpUserId: MessageSourceId = this.blockchainService.api.registry.createType('MessageSourceId', dsnpUserStr);
    const providerId: ProviderId = this.blockchainService.api.registry.createType('ProviderId', providerStr);
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

      // get the user's DSNP Graph from the blockchain and form import bundles
      // import bundles are used to import the user's DSNP Graph into the graph SDK
      await this.importBundles(dsnpUserId, graphKeyPairs);

      let exportedUpdates: Update[] = [];

      if (updateConnections) {
        // using graphConnections form Action[] and update the user's DSNP Graph
        const actions: ConnectAction[] = await this.formConnections(dsnpUserId, providerId, graphConnections);
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

      const providerKeys = createKeys(this.configService.getProviderAccountSeedPhrase());
      const mapUserIdToUpdates = new Map<string, Update[]>();
      /// Note: for now exporting updates for a single user
      exportedUpdates = exportedUpdates.filter((update) => update.ownerDsnpUserId === dsnpUserStr);

      // loop over exportUpdates and collect Updates vs userId
      exportedUpdates.forEach((bundle) => {
        const ownerMsaId: MessageSourceId = this.blockchainService.api.registry.createType('MessageSourceId', bundle.ownerDsnpUserId);
        if (mapUserIdToUpdates.has(ownerMsaId.toString())) {
          const updates = mapUserIdToUpdates.get(ownerMsaId.toString()) || [];
          updates.push(bundle);
          mapUserIdToUpdates.set(ownerMsaId.toString(), updates);
        } else {
          mapUserIdToUpdates.set(ownerMsaId.toString(), [bundle]);
        }
      });

      for (const [userId, updates] of mapUserIdToUpdates.entries()) {
        let batch: SubmittableExtrinsic<'rxjs', ISubmittableResult>[] = [];
        let batchCount = 0;
        const promises: Promise<any>[] = [];
        updates.forEach((bundle) => {
          const ownerMsaId: MessageSourceId = this.blockchainService.api.registry.createType('MessageSourceId', userId);
          switch (bundle.type) {
            case 'PersistPage':
              batch.push(
                this.blockchainService.createExtrinsicCall(
                  { pallet: 'statefulStorage', extrinsic: 'upsertPage' },
                  ownerMsaId,
                  bundle.schemaId,
                  bundle.pageId,
                  bundle.prevHash,
                  Array.from(Array.prototype.slice.call(bundle.payload)),
                ),
              );
              batchCount++;

              // If the batch size exceeds the capacityBatchLimit, send the batch to the chain
              if (batchCount === this.capacityBatchLimit) {
                // Reset the batch and count for the next batch
                batch = [];
                batchCount = 0;
              }
              break;

            default:
              break;
          }
        });

        if (batch.length > 0) {
          promises.push(
            this.blockchainService.createExtrinsic(
              { pallet: 'frequencyTxPayment', extrinsic: 'payWithCapacityBatchAll' }, 
              {}, providerKeys, batch).signAndSend()
          );
        }

        await Promise.all(promises);
        // Check for BatchCompleted event after all promises are resolved
        for (const promise of promises) {
          const [event, eventMap] = await promise;
          if (!event) {
            throw new Error('event not found');
          }
        }
      }

      // On successful export to chain, re-import the user's DSNP Graph from the blockchain and form import bundles
      // import bundles are used to import the user's DSNP Graph into the graph SDK
      // check if user graph exists in the graph SDK else queue a graph update job
      const reImported = await this.importBundles(dsnpUserId, graphKeyPairs);
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

  async getUserGraphFromProvider(dsnpUserId: MessageSourceId | string, providerId: ProviderId | string): Promise<any> {
    const headers = {
      Authorization: 'Bearer <access_token>', // Replace with your actual access token if required
    };
    const baseUrl = this.configService.providerBaseUrl(providerId);

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
        const response = await providerAPI.get(`/api/v1.0.0/connections/${dsnpUserId.toString()}`, { params });

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

  async importBundles(
    dsnpUserId: MessageSourceId,
    graphKeyPairs: ProviderKeyPair[],
  ): Promise<boolean> {
    const importBundles = await this.formImportBundles(dsnpUserId, graphKeyPairs);
    return this.graphStateManager.importUserData(importBundles);
  }

  async formImportBundles(dsnpUserId: MessageSourceId, graphKeyPairs: ProviderKeyPair[]): Promise<ImportBundle[]> {
    const importBundles: ImportBundle[] = [];
    const publicFollowSchemaId = this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Public);
    const publicFriendshipSchemaId = this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Public);
    const privateFollowSchemaId = this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Private);
    const privateFriendshipSchemaId = this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Private);

    const publicFollows: PaginatedStorageResponse[] = await this.blockchainService.rpc('statefulStorage', 'getPaginatedStorage', dsnpUserId, publicFollowSchemaId);
    const publicFriendships: PaginatedStorageResponse[] = await this.blockchainService.rpc('statefulStorage', 'getPaginatedStorage', dsnpUserId, publicFriendshipSchemaId);
    const privateFollows: PaginatedStorageResponse[] = await this.blockchainService.rpc('statefulStorage', 'getPaginatedStorage', dsnpUserId, privateFollowSchemaId);
    const privateFriendships: PaginatedStorageResponse[] = await this.blockchainService.rpc('statefulStorage', 'getPaginatedStorage', dsnpUserId, privateFriendshipSchemaId);

    const importBundleBuilder = new ImportBundleBuilder();
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
          .withSchemaId(publicFollowSchemaId)
          .withPageData(publicFollow.page_id.toNumber(), publicFollow.payload, publicFollow.content_hash.toNumber())
          .build(),
      ),
    );

    importBundles.push(
      ...publicFriendships.map((publicFriendship) =>
        importBundleBuilder
          .withDsnpUserId(dsnpUserId.toString())
          .withSchemaId(publicFriendshipSchemaId)
          .withPageData(publicFriendship.page_id.toNumber(), publicFriendship.payload, publicFriendship.content_hash.toNumber())
          .build(),
      ),
    );

    if (privateFollows.length > 0 || privateFriendships.length > 0) {
      const dsnpKeys = await this.formDsnpKeys(dsnpUserId);
      const graphKeyPairsSdk = graphKeyPairs.map(
        (keyPair: ProviderKeyPair): GraphKeyPair => ({
          keyType: GraphKeyType.X25519,
          publicKey: keyPair.publicKey,
          secretKey: keyPair.privateKey,
        }),
      );

      importBundles.push(
        ...privateFollows.map((privateFollow) =>
          importBundleBuilder
            .withDsnpUserId(dsnpUserId.toString())
            .withSchemaId(privateFollowSchemaId)
            .withPageData(privateFollow.page_id.toNumber(), privateFollow.payload, privateFollow.content_hash.toNumber())
            .withDsnpKeys(dsnpKeys)
            .withGraphKeyPairs(graphKeyPairsSdk)
            .build(),
        ),
      );

      importBundles.push(
        ...privateFriendships.map((privateFriendship) =>
          importBundleBuilder
            .withDsnpUserId(dsnpUserId.toString())
            .withSchemaId(privateFriendshipSchemaId)
            .withPageData(privateFriendship.page_id.toNumber(), privateFriendship.payload, privateFriendship.content_hash.toNumber())
            .withDsnpKeys(dsnpKeys)
            .withGraphKeyPairs(graphKeyPairsSdk)
            .build(),
        ),
      );
    }
    return importBundles;
  }

  async formConnections(dsnpUserId: MessageSourceId | AnyNumber, providerId: MessageSourceId | AnyNumber, graphConnections: ProviderGraph[]): Promise<ConnectAction[]> {
    const dsnpKeys = await this.formDsnpKeys(dsnpUserId);

    const actions: ConnectAction[] = [];
    graphConnections.forEach((connection) => {
      const connectionType = connection.connectionType.toLowerCase();
      const privacyType = connection.privacyType.toLowerCase();

      const schemaId = this.graphStateManager.getSchemaIdFromConfig(connectionType as ConnectionType, privacyType as PrivacyType);

      switch (connection.direction) {
        case 'connectionTo': {
          const connectionAction: ConnectAction = {
            type: 'Connect',
            ownerDsnpUserId: dsnpUserId.toString(),
            connection: {
              dsnpUserId: connection.dsnpId.toString(),
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
              dsnpUserId: connection.dsnpId.toString(),
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

  async formDsnpKeys(dsnpUserId: MessageSourceId | AnyNumber): Promise<DsnpKeys> {
    const publicKeySchemaId = this.graphStateManager.getGraphKeySchemaId();
    const publicKeys: ItemizedStoragePageResponse = await this.blockchainService.rpc('statefulStorage', 'getItemizedStorage', dsnpUserId, publicKeySchemaId);
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
