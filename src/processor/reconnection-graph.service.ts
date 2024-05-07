/* eslint-disable no-await-in-loop */
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
import { ITxStatus } from '#app/interfaces/tx-status.interface';
import { ReconnectionCacheMgrService } from '#app/cache/reconnection-cache-mgr.service';
import * as ReconnectionServiceConstants from '#app/constants';
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
  private readonly logger: Logger;

  constructor(
    private readonly configService: ConfigService,
    private readonly graphStateManager: GraphStateManager,
    @InjectQueue(ReconnectionServiceConstants.GRAPH_UPDATE_QUEUE_NAME) private readonly graphUpdateQueue: Queue,
    private readonly blockchainService: BlockchainService,
    private readonly providerWebhookService: ProviderWebhookService,
    private readonly eventEmitter: EventEmitter2,
    private readonly nonceService: NonceService,
    private readonly cacheService: ReconnectionCacheMgrService,
  ) {
    this.logger = new Logger(ReconnectionGraphService.name);
  }

  public get capacityBatchLimit(): number {
    return this.blockchainService.api.consts.frequencyTxPayment.maximumCapacityBatchLength.toNumber();
  }

  public async updateUserGraph(jobId: string, dsnpUserStr: string, providerStr: string, updateConnections: boolean): Promise<boolean> {
    let doTrack = false;
    this.logger.debug(`Updating graph for user ${dsnpUserStr}, provider ${providerStr}`);
    // Acquire a graph state for the job
    const graphState = this.graphStateManager.createGraphState();
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
    this.logger.debug(`Retrieved ${graphConnections.length} connections for user ${dsnpUserId.toString()}`);

    try {
      // get the user's DSNP Graph from the blockchain and form import bundles
      // import bundles are used to import the user's DSNP Graph into the graph SDK
      await this.importBundles(graphState, dsnpUserId, graphKeyPairs);
      this.logger.debug(`Graph for user ${dsnpUserId} has ${graphState.getConnectionsForUserGraph(dsnpUserId.toString(), 9, false).length} connections after import from chain`);
      // using graphConnections form Action[] and update the user's DSNP Graph
      const actions: ConnectAction[] = await this.formConnections(graphState, dsnpUserId, providerId, updateConnections, graphConnections);
      try {
        if (actions.length === 0) {
          this.logger.debug(`No actions to apply for user ${dsnpUserId.toString()}`);
          return false;
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

      this.logger.debug(
        `Graph after applying provider connections has ${graphState.getConnectionsForUserGraph(dsnpUserId.toString(), 9, true).length} current and pending connections`,
      );
      const exportedUpdates = graphState.exportUserGraphUpdates(dsnpUserId.toString());

      const providerKeys = createKeys(this.configService.getProviderAccountSeedPhrase());
      let batch: SubmittableExtrinsic<'rxjs', ISubmittableResult>[] = [];
      // eslint-disable-next-line no-restricted-syntax
      for (const bundle of exportedUpdates) {
        switch (bundle.type) {
          case 'PersistPage':
            batch.push(
              this.blockchainService.createExtrinsicCall(
                { pallet: 'statefulStorage', extrinsic: 'upsertPage' },
                bundle.ownerDsnpUserId,
                bundle.schemaId,
                bundle.pageId,
                bundle.prevHash,
                Array.from(Array.prototype.slice.call(bundle.payload)),
              ),
            );

            if (batch.length === this.capacityBatchLimit) {
              // eslint-disable-next-line no-await-in-loop
              await this.processSingleBatch(jobId, providerKeys, batch);
              doTrack = true;
              batch = [];
            }
            break;
          default:
            break;
        }
      }

      if (batch.length > 0) {
        await this.processSingleBatch(jobId, providerKeys, batch);
        doTrack = true;
      }

      return doTrack;
    } catch (err) {
      this.logger.error(`Error updating graph for user ${dsnpUserStr}, provider ${providerStr}: ${(err as Error).stack}`);
      // In case any transaction were submitted, we don't need to track them because we're already going to fail/retry this job
      await this.cacheService.removeJob(jobId);
      throw err;
    } finally {
      graphState.freeGraphState();
    }
  }

  async getUserGraphFromProvider(dsnpUserId: MessageSourceId | string, providerId: ProviderId | string): Promise<any> {
    const providerAPI = this.providerWebhookService.providerApi;
    const pageSize = this.configService.getPageSize();
    const params = {
      pageNumber: 1,
      pageSize,
    };

    const allConnections: ProviderGraph[] = [];
    const keyPairs: GraphKeyPair[] = [];

    let hasNextPage = true;
    let webhookFailures = 0;

    while (hasNextPage) {
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
          this.logger.debug(`Fetched ${params.pageNumber} connections pages for user ${dsnpUserId.toString()} from provider ${providerId.toString()}`);
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
    let builder = importBundleBuilder.withDsnpUserId(dsnpUserId.toString());

    if (dsnpKeys?.keys?.length > 0) {
      builder = builder.withDsnpKeys(dsnpKeys);
    }
    if (graphKeyPairs?.length > 0) {
      builder = builder.withGraphKeyPairs(graphKeyPairsSdk);
    }

    // If no pages to import, import at least one empty page so that user graph will be created
    if (publicFollows.length + privateFollows.length + privateFriendships.length === 0 && (graphKeyPairs.length > 0 || dsnpKeys?.keys.length > 0)) {
      importBundles = [builder.withSchemaId(privateFollowSchemaId).build()];
    } else {
      const schemasToProcess: PaginatedStorageResponse[][] = [];
      if (publicFollows.length > 0) {
        schemasToProcess.push(publicFollows);
      }
      if (privateFollows.length > 0) {
        schemasToProcess.push(privateFollows);
      }
      if (privateFriendships.length > 0) {
        schemasToProcess.push(privateFriendships);
      }
      importBundles = [];
      schemasToProcess.forEach((pageResponses: PaginatedStorageResponse[]) => {
        builder = builder.withDsnpUserId(dsnpUserId.toString()).withSchemaId(pageResponses[0].schema_id.toNumber());
        pageResponses.forEach((pageResponse) => {
          builder = builder.withPageData(pageResponse.page_id.toNumber(), pageResponse.payload, pageResponse.content_hash.toNumber());
        });

        importBundles.push(builder.build());
      });
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
    const delegationResult: Option<Vec<SchemaGrantResponse>> = await this.blockchainService.rpc('msa', 'grantedSchemaIdsByMsaId', dsnpUserId, providerId);
    if (delegationResult.isNone) {
      this.logger.log(`User ${dsnpUserId} has no delegations to provider ${providerId}`);
      return actions;
    }
    const delegations = delegationResult.unwrap().toArray();
    // Import DSNP public graph keys for connected users in private friendship connections
    await this.importConnectionKeys(graphState, graphConnections);
    await Promise.all(
      graphConnections.map(async (connection): Promise<void> => {
        const connectionType = connection.connectionType.toLowerCase();
        const privacyType = connection.privacyType.toLowerCase();
        const schemaId = this.graphStateManager.getSchemaIdFromConfig(connectionType as ConnectionType, privacyType as PrivacyType);
        /// make sure user has delegation for schemaId
        const isDelegated = delegations.findIndex((grant) => grant.schema_id.toNumber() === schemaId) !== -1;

        if (!isDelegated) {
          this.logger.error(`No delegation for user ${dsnpUserId.toString()} for schema ${schemaId}`);
          return;
        }

        /// make sure incoming user connection is also delegated for queuing updates non-transitively
        let isDelegatedConnection = false;
        if (isTransitive && (connection.direction === 'connectionFrom' || connection.direction === 'bidirectional')) {
          const connectionDelegations = await this.blockchainService.rpc('msa', 'grantedSchemaIdsByMsaId', connection.dsnpId, providerId);
          if (connectionDelegations.isSome) {
            isDelegatedConnection =
              connectionDelegations
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
            if (isTransitive) {
              if (isDelegatedConnection) {
                const { key: jobId, data } = createGraphUpdateJob(connection.dsnpId, providerId, SkipTransitiveGraphs);
                this.graphUpdateQueue.remove(jobId);
                this.graphUpdateQueue.add(ReconnectionServiceConstants.GRAPH_UPDATE_JOB_TYPE, data, { jobId });
                this.logger.debug(`Queued transitive graph update job ${jobId}`);
              } else {
                this.logger.warn(`No delegation for user ${connection.dsnpId} for schema ${schemaId}`);
              }
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

            if (isTransitive) {
              if (isDelegatedConnection) {
                const { key: jobId, data } = createGraphUpdateJob(connection.dsnpId, providerId, SkipTransitiveGraphs);
                this.graphUpdateQueue.remove(jobId);
                this.graphUpdateQueue.add(ReconnectionServiceConstants.GRAPH_UPDATE_JOB_TYPE, data, { jobId });
              }
            } else {
              this.logger.warn(`No delegation for user ${connection.dsnpId} for schema ${schemaId}`);
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
   * @param txns The transaction to be submitted.
   * @returns The hash of the submitted transaction.
   * @throws Error if the transaction hash is undefined or if there is an error processing the batch.
   */
  async processSingleBatch(sourceJobId: string, providerKeys: KeyringPair, txns: SubmittableExtrinsic<'rxjs', ISubmittableResult>[]): Promise<void> {
    this.logger.debug(`Submitting capacity batch tx of size ${txns.length}`);
    try {
      const ext = this.blockchainService.createExtrinsic(
        { pallet: 'frequencyTxPayment', extrinsic: 'payWithCapacityBatchAll' },
        { eventPallet: 'frequencyTxPayment', event: 'CapacityPaid' },
        providerKeys,
        txns,
      );
      const [blockNumber, nonce] = await Promise.all([this.blockchainService.getLatestFinalizedBlockNumber(), this.nonceService.getNextNonce()]);

      const [txHash, _] = await ext.signAndSendNoWait(nonce);
      if (!txHash) {
        throw new Error('Tx hash is undefined');
      }

      const status: ITxStatus = {
        sourceJobId,
        txHash: txHash.toHex(),
        birth: ext.extrinsic.era.asMortalEra.birth(blockNumber),
        death: ext.extrinsic.era.asMortalEra.death(blockNumber),
        status: 'pending',
      };
      await this.cacheService.upsertWatchedTxns(status);
      this.logger.verbose(`Added tx ${txHash.toHex()} to watch list for job ${sourceJobId}`);
    } catch (error: any) {
      this.logger.error(`Error processing batch: ${error}`);
      throw error;
    }
  }
}
