/* eslint-disable no-continue */
import { AxiosError, AxiosResponse } from 'axios';
import { Injectable, Logger } from '@nestjs/common';
import { ItemizedStoragePageResponse, MessageSourceId, PaginatedStorageResponse, ProviderId, SchemaGrantResponse } from '@frequency-chain/api-augment/interfaces';
import { ImportBundleBuilder, ConnectAction, ConnectionType, DsnpKeys, GraphKeyType, ImportBundle, KeyData, PrivacyType, GraphKeyPair, Graph } from '@dsnp/graph-sdk';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SubmittableExtrinsic } from '@polkadot/api-base/types';
import { AnyNumber, ISubmittableResult } from '@polkadot/types/types';
import { KeyringPair } from '@polkadot/keyring/types';
import { hexToU8a } from '@polkadot/util';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Option, Vec } from '@polkadot/types';
import { Hash } from '@polkadot/types/interfaces';
import { ITxMonitorJob } from '#app/interfaces/monitor.job.interface';
import { MILLISECONDS_PER_SECOND } from 'time-constants';
import { BlockchainConstants } from '#app/blockchain/blockchain-constants';
import { SkipTransitiveGraphs, createGraphUpdateJob } from '../interfaces/graph-update-job.interface';
import { BlockchainService } from '../blockchain/blockchain.service';
import { createKeys } from '../blockchain/create-keys';
import { GraphKeyPair as ProviderKeyPair, KeyType, ProviderGraph } from '../interfaces/provider-graph.interface';
import { GraphStateManager } from '../graph/graph-state-manager';
import { ConfigService } from '../config/config.service';
import { ProviderWebhookService } from './provider-webhook.service';

import * as errors from './errors';
import { NonceService } from './nonce.service';

@Injectable()
export class ReconnectionGraphService {
  private logger: Logger;

  constructor(
    private configService: ConfigService,
    private graphStateManager: GraphStateManager,
    @InjectQueue('graphUpdateQueue') private graphUpdateQueue: Queue,
    @InjectQueue('graphTxMonitorQueue') private graphTxMonitorQueue: Queue,
    private blockchainService: BlockchainService,
    private providerWebhookService: ProviderWebhookService,
    private eventEmitter: EventEmitter2,
    private nonceService: NonceService,
  ) {
    this.logger = new Logger(ReconnectionGraphService.name);
  }

  public get capacityBatchLimit(): number {
    return this.blockchainService.api.consts.frequencyTxPayment.maximumCapacityBatchLength.toNumber();
  }

  public async updateUserGraph(jobId: string, dsnpUserStr: string, providerStr: string, updateConnections: boolean): Promise<any> {
    this.logger.debug(`Updating graph for user ${dsnpUserStr}, provider ${providerStr}`);
    // Acquire a graph state for the job
    const graphState = this.graphStateManager.createGraphState();
    const lastFinalizedBlockHash = await this.blockchainService.getLatestFinalizedBlockHash();
    const currentCapacityEpoch = await this.blockchainService.getCurrentCapacityEpoch();
    const dsnpUserId: MessageSourceId = this.blockchainService.api.registry.createType('MessageSourceId', dsnpUserStr);
    const providerId: ProviderId = this.blockchainService.api.registry.createType('ProviderId', providerStr);

    let graphConnections: ProviderGraph[] = [];
    let graphKeyPairs: ProviderKeyPair[] = [];
    try {
      [graphConnections, graphKeyPairs] = await this.getUserGraphFromProvider(dsnpUserId, providerId);
    } catch (e) {
      this.logger.error(`Error getting user graph from provider: ${e}`);
      throw e;
    }

    try {
      // get the user's DSNP Graph from the blockchain and form import bundles
      // import bundles are used to import the user's DSNP Graph into the graph SDK
      await this.importBundles(graphState, dsnpUserId, graphKeyPairs);
      // using graphConnections form Action[] and update the user's DSNP Graph
      const actions: ConnectAction[] = await this.formConnections(graphState, dsnpUserId, providerId, updateConnections, graphConnections);
      try {
        if (actions.length === 0) {
          this.logger.debug(`No actions to apply for user ${dsnpUserId.toString()}`);
          return {};
        }
        graphState.applyActions(actions, { ignoreExistingConnections: true });
      } catch (e: any) {
        const errMessage = e instanceof Error ? e.message : '';
        if (errMessage.includes('already exists')) {
          this.logger.warn(`Error applying actions: ${e}`);
        } else {
          throw new errors.ApplyActionsError(`Error applying actions: ${e}`);
        }
      }

      const exportedUpdates = graphState.exportUserGraphUpdates(dsnpUserId.toString());

      const providerKeys = createKeys(this.configService.getProviderAccountSeedPhrase());
      const blockDelay = BlockchainConstants.SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND;
      let statefulStorageTxHash: Hash;
      let txMonitorJob: ITxMonitorJob;
      let tx: SubmittableExtrinsic<'rxjs', ISubmittableResult>;
      // eslint-disable-next-line no-restricted-syntax
      for (const bundle of exportedUpdates) {
        switch (bundle.type) {
          case 'PersistPage':
            tx = this.blockchainService.createExtrinsicCall(
              { pallet: 'statefulStorage', extrinsic: 'upsertPage' },
              bundle.ownerDsnpUserId,
              bundle.schemaId,
              bundle.pageId,
              bundle.prevHash,
              Array.from(Array.prototype.slice.call(bundle.payload)),
            );
            // eslint-disable-next-line no-await-in-loop
            statefulStorageTxHash = await this.processSingleBatch(providerKeys, tx);
            txMonitorJob = {
              id: jobId,
              txHash: statefulStorageTxHash,
              epoch: currentCapacityEpoch.toString(),
              lastFinalizedBlockHash,
            };
            this.logger.debug(`Adding job to graph change notify queue: ${txMonitorJob.id}`);
            this.graphTxMonitorQueue.add(`Graph Change Notify Job - ${txMonitorJob.id}`, txMonitorJob, {
              delay: blockDelay,
            });
            break;
          default:
            break;
        }
      }
      return {};
    } catch (err) {
      this.logger.error(`Error updating graph for user ${dsnpUserStr}, provider ${providerStr}: ${(err as Error).stack}`);
      throw err;
    } finally {
      graphState.freeGraphState();
    }
  }

  async getUserGraphFromProvider(dsnpUserId: MessageSourceId | string, providerId: ProviderId | string): Promise<any> {
    const providerAPI = this.providerWebhookService.providerApi;

    const params = {
      pageNumber: 1,
      pageSize: 100, // TODO: Determine correct value for production
    };

    const allConnections: ProviderGraph[] = [];
    const keyPairs: GraphKeyPair[] = [];

    let hasNextPage = true;
    let webhookFailures: number = 0;

    while (hasNextPage) {
      this.logger.debug(`Fetching connections page ${params.pageNumber} for user ${dsnpUserId.toString()} from provider ${providerId.toString()}`);

      let response: AxiosResponse<any, any>;
      try {
        // eslint-disable-next-line no-await-in-loop
        response = await providerAPI.get(`/connections/${dsnpUserId.toString()}`, { params });

        // Reset webhook failures to 0 on a success. We don't go into waiting for recovery unless
        // a sequential number failures occur equaling webhookFailureThreshold.
        webhookFailures = 0;

        if (!response.data || !response.data.connections) {
          throw new errors.GetUserGraphError(`Invalid response from provider: No connections found for ${dsnpUserId.toString()}`);
        }

        if (response.data.dsnpId !== dsnpUserId.toString()) {
          throw new errors.GetUserGraphError(`DSNP ID mismatch in response for ${dsnpUserId.toString()}`);
        }

        const { data }: { data: ProviderGraph[] } = response.data.connections;
        allConnections.push(...data);
        const { graphKeyPairs }: { graphKeyPairs: GraphKeyPair[] } = response.data;
        if (graphKeyPairs) {
          keyPairs.push(...graphKeyPairs);
        }

        const { pagination } = response.data.connections;
        if (pagination && pagination.pageCount && pagination.pageCount > params.pageNumber) {
          // Increment the page number to fetch the next page
          params.pageNumber += 1;
        } else {
          // No more pages available, exit the loop
          hasNextPage = false;
        }
      } catch (error: any) {
        let newError = error;
        if (error instanceof AxiosError) {
          webhookFailures += 1;
          if (error.response) {
            newError = new errors.GetUserGraphError(`Bad response from provider webhook: ${error.response.status} ${error.response.statusText}`);
          } else if (error.request) {
            newError = new errors.GetUserGraphError('No response from provider webhook');
          } else {
            newError = new errors.GetUserGraphError(`Unknown error calling provider webhook: ${error?.message}`);
          }

          if (webhookFailures >= this.configService.getWebhookFailureThreshold()) {
            // eslint-disable-next-line no-await-in-loop
            await this.eventEmitter.emitAsync('webhook.gone');
          } else {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => {
              setTimeout(r, this.configService.getWebhookRetryIntervalSeconds());
            });
            continue;
          }
        }
        throw newError;
      }
    }

    return [allConnections, keyPairs];
  }

  async importBundles(graphState: Graph, dsnpUserId: MessageSourceId, graphKeyPairs: ProviderKeyPair[]): Promise<boolean> {
    const importBundles = await this.formImportBundles(dsnpUserId, graphKeyPairs);
    return graphState.importUserData(importBundles);
  }

  async formImportBundles(dsnpUserId: MessageSourceId, graphKeyPairs: ProviderKeyPair[]): Promise<ImportBundle[]> {
    const publicFollowSchemaId = this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Public);
    const privateFollowSchemaId = this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Private);
    const privateFriendshipSchemaId = this.graphStateManager.getSchemaIdFromConfig(ConnectionType.Friendship, PrivacyType.Private);

    const publicFollows: PaginatedStorageResponse[] = await this.blockchainService.rpc('statefulStorage', 'getPaginatedStorage', dsnpUserId, publicFollowSchemaId);
    const privateFollows: PaginatedStorageResponse[] = await this.blockchainService.rpc('statefulStorage', 'getPaginatedStorage', dsnpUserId, privateFollowSchemaId);
    const privateFriendships: PaginatedStorageResponse[] = await this.blockchainService.rpc('statefulStorage', 'getPaginatedStorage', dsnpUserId, privateFriendshipSchemaId);
    const dsnpKeys = await this.formDsnpKeys(dsnpUserId);
    const graphKeyPairsSdk = graphKeyPairs.map(
      (keyPair: ProviderKeyPair): GraphKeyPair => ({
        keyType: GraphKeyType.X25519,
        publicKey: hexToU8a(keyPair.publicKey),
        secretKey: hexToU8a(keyPair.privateKey),
      }),
    );
    const importBundleBuilder = new ImportBundleBuilder();
    // Only X25519 is supported for now
    // check if all keys are of type X25519
    const areKeysCorrectType = graphKeyPairs.every((keyPair) => keyPair.keyType === KeyType.X25519);
    if (!areKeysCorrectType) {
      throw new errors.GetUserGraphError('Only X25519 keys are supported for now');
    }

    let importBundles: ImportBundle[];

    // If no pages to import, import at least one empty page so that user graph will be created
    if (publicFollows.length + privateFollows.length + privateFriendships.length === 0 && (graphKeyPairs.length > 0 || dsnpKeys?.keys.length > 0)) {
      let builder = importBundleBuilder.withDsnpUserId(dsnpUserId.toString()).withSchemaId(privateFollowSchemaId);

      if (dsnpKeys?.keys?.length > 0) {
        builder = builder.withDsnpKeys(dsnpKeys);
      }
      if (graphKeyPairs?.length > 0) {
        builder = builder.withGraphKeyPairs(graphKeyPairsSdk);
      }

      importBundles = [builder.build()];
    } else {
      importBundles = [publicFollows, privateFollows, privateFriendships].flatMap((pageResponses: PaginatedStorageResponse[]) =>
        pageResponses.map((pageResponse) => {
          let builder = importBundleBuilder
            .withDsnpUserId(pageResponse.msa_id.toString())
            .withSchemaId(pageResponse.schema_id.toNumber())
            .withPageData(pageResponse.page_id.toNumber(), pageResponse.payload, pageResponse.content_hash.toNumber());

          if (dsnpKeys?.keys?.length > 0) {
            builder = builder.withDsnpKeys(dsnpKeys);
          }
          if (graphKeyPairs?.length > 0) {
            builder = builder.withGraphKeyPairs(graphKeyPairsSdk);
          }

          return builder.build();
        }),
      );
    }

    return importBundles;
  }

  private async importConnectionKeys(graphState: Graph, graphConnections: ProviderGraph[]): Promise<void> {
    const keyPromises = graphConnections
      .filter(
        ({ direction, privacyType, connectionType }) =>
          ['connectionTo', 'bidirectional'].some((dir) => dir === direction) && privacyType === 'Private' && connectionType === 'Friendship',
      )
      .map(({ dsnpId }) => this.formDsnpKeys(dsnpId));
    const keys = await Promise.all(keyPromises);

    const bundles = keys.map((dsnpKeys) => new ImportBundleBuilder().withDsnpUserId(dsnpKeys.dsnpUserId).withDsnpKeys(dsnpKeys).build());

    graphState.importUserData(bundles);
  }

  async formConnections(
    graphState: Graph,
    dsnpUserId: MessageSourceId | AnyNumber,
    providerId: MessageSourceId | AnyNumber,
    isTransitive: boolean,
    graphConnections: ProviderGraph[],
  ): Promise<ConnectAction[]> {
    const dsnpKeys: DsnpKeys = await this.formDsnpKeys(dsnpUserId);
    const actions: ConnectAction[] = [];
    // this.logger.debug(`Graph connections for user ${dsnpUserId.toString()}: ${JSON.stringify(graphConnections)}`);
    // Import DSNP public graph keys for connected users in private friendship connections
    await this.importConnectionKeys(graphState, graphConnections);
    await Promise.all(
      graphConnections.map(async (connection): Promise<void> => {
        const connectionType = connection.connectionType.toLowerCase();
        const privacyType = connection.privacyType.toLowerCase();
        const schemaId = this.graphStateManager.getSchemaIdFromConfig(connectionType as ConnectionType, privacyType as PrivacyType);
        /// make sure user has delegation for schemaId
        let delegations: Option<Vec<SchemaGrantResponse>> = await this.blockchainService.rpc('msa', 'grantedSchemaIdsByMsaId', dsnpUserId, providerId);
        let isDelegated = false;
        if (delegations.isSome) {
          isDelegated =
            delegations
              .unwrap()
              .toArray()
              .findIndex((grant) => grant.schema_id.toNumber() === schemaId) !== -1;
        }

        if (!isDelegated) {
          return;
        }

        /// make sure incoming user connection is also delegated for queuing updates non-transitively
        let isDelegatedConnection = false;
        if (isTransitive && (connection.direction === 'connectionFrom' || connection.direction === 'bidirectional')) {
          delegations = await this.blockchainService.rpc('msa', 'grantedSchemaIdsByMsaId', connection.dsnpId, providerId);
          if (delegations.isSome) {
            isDelegatedConnection =
              delegations
                .unwrap()
                .toArray()
                .findIndex((grant) => grant.schema_id.toNumber() === schemaId) !== -1;
          }
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

            if (dsnpKeys?.keys?.length > 0) {
              connectionAction.dsnpKeys = dsnpKeys;
            }

            actions.push(connectionAction);
            break;
          }
          case 'connectionFrom': {
            if (isDelegatedConnection) {
              const { key: jobId, data } = createGraphUpdateJob(connection.dsnpId, providerId, SkipTransitiveGraphs);
              this.graphUpdateQueue.remove(jobId);
              this.graphUpdateQueue.add(`graphUpdate:${data.dsnpId}`, data, { jobId });
            }
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

            if (dsnpKeys && dsnpKeys.keys.length > 0) {
              connectionAction.dsnpKeys = dsnpKeys;
            }

            actions.push(connectionAction);

            if (isDelegatedConnection) {
              const { key: jobId, data } = createGraphUpdateJob(connection.dsnpId, providerId, SkipTransitiveGraphs);
              this.graphUpdateQueue.remove(jobId);
              this.graphUpdateQueue.add(`graphUpdate:${data.dsnpId}`, data, { jobId });
            }
            break;
          }
          default:
            throw new Error(`Unrecognized connection direction: ${connection.direction}`);
        }
      }),
    );

    return actions;
  }

  async formDsnpKeys(dsnpUserId: MessageSourceId | AnyNumber): Promise<DsnpKeys> {
    const publicKeySchemaId = this.graphStateManager.getGraphKeySchemaId();
    const publicKeys: ItemizedStoragePageResponse = await this.blockchainService.rpc('statefulStorage', 'getItemizedStorage', dsnpUserId, publicKeySchemaId);
    const keyData: KeyData[] = publicKeys.items.toArray().map((publicKey) => ({
      index: publicKey.index.toNumber(),
      content: hexToU8a(publicKey.payload.toHex()),
    }));
    const dsnpKeys: DsnpKeys = {
      dsnpUserId: dsnpUserId.toString(),
      keysHash: publicKeys.content_hash.toNumber(),
      keys: keyData,
    };
    return dsnpKeys;
  }

  /**
   * Processes a single batch by submitting a transaction to the blockchain.
   *
   * @param providerKeys The key pair used for signing the transaction.
   * @param tx The transaction to be submitted.
   * @returns The hash of the submitted transaction.
   * @throws Error if the transaction hash is undefined or if there is an error processing the batch.
   */
  async processSingleBatch(providerKeys: KeyringPair, tx: SubmittableExtrinsic<'rxjs', ISubmittableResult>): Promise<Hash> {
    this.logger.debug(`Submitting tx of size ${tx.length}, nonce:${tx.nonce}, method: ${tx.method.section}.${tx.method.method}`);
    try {
      const ext = this.blockchainService.createExtrinsic(
        { pallet: 'frequencyTxPayment', extrinsic: 'payWithCapacity' },
        { eventPallet: 'frequencyTxPayment', event: 'CapacityPaid' },
        providerKeys,
        tx,
      );
      const nonce = await this.nonceService.getNextNonce();
      this.logger.debug(`Capacity Wrapped Extrinsic: ${ext}, nonce:${nonce}`);
      const [txHash, _] = await ext.signAndSendNoWait(nonce);
      if (!txHash) {
        throw new Error('Tx hash is undefined');
      }
      this.logger.debug(`Tx hash: ${txHash}`);
      return txHash;
    } catch (error: any) {
      this.logger.error(`Error processing batch: ${error}`);
      throw error;
    }
  }
}
