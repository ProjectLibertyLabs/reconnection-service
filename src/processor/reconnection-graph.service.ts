import axios, { AxiosError, AxiosInstance } from 'axios';
import { Injectable, Logger } from '@nestjs/common';
import { ItemizedStoragePageResponse, ItemizedStorageResponse, MessageSourceId, PaginatedStorageResponse, ProviderId } from '@frequency-chain/api-augment/interfaces';
import { ImportBundleBuilder, ConnectAction, ConnectionType, DsnpKeys, GraphKeyType, ImportBundle, KeyData, PrivacyType, Update } from '@dsnp/graph-sdk';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SkipTransitiveGraphs, createGraphUpdateJob } from '#app/interfaces/graph-update-job.interface';
import { SubmittableExtrinsic } from '@polkadot/api-base/types';
import { AnyNumber, ISubmittableResult } from '@polkadot/types/types';
import { BlockchainService } from '#app/blockchain/blockchain.service';
import { createKeys } from '#app/blockchain/create-keys';
import { GraphKeyPair, KeyType, ProviderGraph } from '../interfaces/provider-graph.interface';
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

  public async updateUserGraph(dsnpUserId: string, providerId: string, updateConnections: boolean): Promise<void> {
    this.logger.debug(`Updating graph for user ${dsnpUserId}, provider ${providerId}`);
    const [graphConnections, graphKeyPairs] = await this.getUserGraphFromProvider(dsnpUserId, providerId);
    // graph config and respective schema ids
    const graphSdkConfig = await this.graphStateManager.getGraphConfig();

    // get the user's DSNP Graph from the blockchain and form import bundles
    const importBundles = await this.formImportBundles(dsnpUserId, graphKeyPairs);
    await this.graphStateManager.importUserData(importBundles);

    let exportedUpdates: Update[] = [];

    if (updateConnections) {
      // using graphConnections form Action[] and update the user's DSNP Graph
      const actions: ConnectAction[] = await this.formConnections(dsnpUserId, providerId, graphConnections);
      await this.graphStateManager.applyActions(actions);
      exportedUpdates = await this.graphStateManager.exportGraphUpdates();
    } else {
      exportedUpdates = await this.graphStateManager.forceCalculateGraphs(dsnpUserId.toString());
    }

    const providerKeys = createKeys(this.configService.getProviderAccountSeedPhrase());
    const calls: SubmittableExtrinsic<'rxjs', ISubmittableResult>[] = [];

    exportedUpdates.forEach((bundle) => {
      const ownerMsaId: MessageSourceId = this.blockchainService.api.createType('MessageSourceId', bundle.ownerDsnpUserId);
      switch (bundle.type) {
        case 'PersistPage':
          calls.push(
            this.blockchainService.createExtrinsicCall(
              { pallet: 'statefulStorage', extrinsic: 'upsertPage' },
              ownerMsaId,
              bundle.schemaId,
              bundle.pageId,
              bundle.prevHash,
              Array.from(Array.prototype.slice.call(bundle.payload)),
            ),
          );
          break;

        default:
          break;
      }
    });

    const [event, eventMap] = await this.blockchainService
      .createExtrinsic({ pallet: 'frequencyTxPayment', extrinsic: 'payWithCapacityBatchAll' }, {}, providerKeys, calls)
      .signAndSend();

    // TODO
    // Re-import DSNP Graph from chain & verify
    //     (if updating connections as well, do the same for connections--but do not transitively update connections - of - connections)
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

  async formImportBundles(dsnpUserId: MessageSourceId | AnyNumber, graphKeyPair: GraphKeyPair[]): Promise<ImportBundle[]> {
    const importBundles: ImportBundle[] = [];
    const publicFollowSchemaId = this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Public);
    const publicFriendshipSchemaId = this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Public);
    const privateFollowSchemaId = this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Private);
    const privateFriendshipSchemaId = this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Private);

    const publicFollows: PaginatedStorageResponse[] = await this.blockchainService.rpc('statefulStorage', 'getPaginatedStorage', dsnpUserId, publicFollowSchemaId);
    const publicFriendships: PaginatedStorageResponse[] = await this.blockchainService.rpc('statefulStorage', 'getPaginatedStorage', dsnpUserId, publicFriendshipSchemaId);
    const privateFollows: PaginatedStorageResponse[] = await this.blockchainService.rpc('statefulStorage', 'getPaginatedStorage', dsnpUserId, privateFollowSchemaId);
    const privateFriendships: PaginatedStorageResponse[] = await this.blockchainService.rpc('statefulStorage', 'getPaginatedStorage', dsnpUserId, privateFriendshipSchemaId);

    const dsnpKeys = await this.formDsnpKeys(dsnpUserId);

    const importBundleBuilder = new ImportBundleBuilder();
    // Only X25519 is supported for now
    // check if all keys are of type X25519
    const areKeysCorrectType = graphKeyPair.every((keyPair) => keyPair.keyType === KeyType.X25519);
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
      ...publicFriendships.map((publicFriendship) => {
        importBundleBuilder
          .withDsnpUserId(dsnpUserId.toString())
          .withSchemaId(publicFriendshipSchemaId)
          .withPageData(publicFriendship.page_id.toNumber(), publicFriendship.payload, publicFriendship.content_hash.toNumber());

        if (dsnpKeys) {
          importBundleBuilder.withDsnpKeys(dsnpKeys);
        }
        return importBundleBuilder.build();
      }),
    );

    importBundles.push(
      ...privateFollows.map((privateFollow) => {
        importBundleBuilder
          .withDsnpUserId(dsnpUserId.toString())
          .withSchemaId(privateFollowSchemaId)
          .withPageData(privateFollow.page_id.toNumber(), privateFollow.payload, privateFollow.content_hash.toNumber());

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
      }),
    );

    importBundles.push(
      ...privateFriendships.map((privateFriendship) => {
        importBundleBuilder
          .withDsnpUserId(dsnpUserId.toString())
          .withSchemaId(privateFriendshipSchemaId)
          .withPageData(privateFriendship.page_id.toNumber(), privateFriendship.payload, privateFriendship.content_hash.toNumber());

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
      }),
    );

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

  async formDsnpKeys(dsnpUserId: MessageSourceId | AnyNumber): Promise<DsnpKeys | undefined> {
    const publicKeySchemaId = this.graphStateManager.getGraphKeySchemaId();
    const publicKeys: ItemizedStoragePageResponse = await this.blockchainService.rpc('statefulStorage', 'getItemizedStorage', dsnpUserId, publicKeySchemaId);

    let dsnpKeys: DsnpKeys | undefined;
    if (publicKeys.items.length > 0) {
      dsnpKeys = {
        dsnpUserId: dsnpUserId.toString(),
        keysHash: publicKeys.content_hash.toNumber(),
        keys: publicKeys.items.map(
          (item: ItemizedStorageResponse): KeyData => ({
            index: item.index.toNumber(),
            content: item.payload.toU8a(),
          }),
        ),
      };
    } else {
      dsnpKeys = undefined;
    }

    return dsnpKeys;
  }
}
