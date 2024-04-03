/* eslint-disable no-plusplus */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */
import '@frequency-chain/api-augment';
import { MessageSourceId } from '@frequency-chain/api-augment/interfaces';
import { Keyring } from '@polkadot/keyring';
import { KeyringPair } from '@polkadot/keyring/types';
import { Vec } from '@polkadot/types';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import {
  AddProviderPayload,
  ExtrinsicHelper,
  UserBuilder,
  signPayloadSr25519,
  initialize,
  Sr25519Signature,
  ItemizedSignaturePayloadV2,
  EventError,
} from 'frequency-scenario-template';
import log from 'loglevel';
import { ProviderGraph, GraphKeyPair as ProviderGraphKeyPair } from 'reconnection-service/src/interfaces/provider-graph.interface';
import fs from 'node:fs';
import { SubmittableExtrinsic } from '@polkadot/api-base/types';
import { ISubmittableResult } from '@polkadot/types/types';
import { FrameSystemEventRecord } from '@polkadot/types/lookup';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { AddGraphKeyAction, AddKeyUpdate, ConnectionType, EnvironmentInterface, EnvironmentType, Graph, PrivacyType } from '@dsnp/graph-sdk';
import { HexString } from '@polkadot/util/types';

type ChainUser = {
  uri?: string;
  keys?: KeyringPair;
  msaId?: MessageSourceId;
  create?: () => SubmittableExtrinsic<'promise', ISubmittableResult>;
  addGraphKey?: () => SubmittableExtrinsic<'promise', ISubmittableResult>;
  resetGraph?: (() => SubmittableExtrinsic<'promise', ISubmittableResult>)[];
};

type ProviderResponse = {
  dsnpId: string;
  connections: {
    data: ProviderGraph[];
    pagination?: {
      pageNumber: number;
      pageSize: number;
      pageCount: number;
    };
  };
  graphKeyPairs: ProviderGraphKeyPair[];
};

let graphPublicKey: HexString = '0x0514f63edc89d414061bf451cc99b1f2b43fac920c351be60774559a31523c75';
let graphPrivateKey: HexString = '0x1c15b6d1af4716615a4eb83a2dfba3284e1c0a199603572e7b95c164f7ad90e3';
let privateFollowSchemaId: number;
const CAPACITY_AMOUNT_TO_STAKE = 1_000_000_000_000_000n;

const keyring = new Keyring({ type: 'sr25519' });
const DEFAULT_SCHEMAS = [5, 7, 8, 9, 10];
let nonce: number;
let graph: Graph;

function mapToArray<K, V>(map: Map<K, V>): [Array<K>, Array<V>] {
  return [Array.from(map.keys()), Array.from(map.values())];
}

let graphKeyAction: any;
async function getAddGraphKeyPayload(graph: Graph, user: ChainUser): Promise<{ payload: ItemizedSignaturePayloadV2; proof: Sr25519Signature }> {
  if (!graphKeyAction) {
    const actions = [
      {
        type: 'AddGraphKey',
        ownerDsnpUserId: '1',
        newPublicKey: hexToU8a(graphPublicKey),
      } as AddGraphKeyAction,
    ];
    graph.applyActions(actions);
    const keyExport = graph.exportUserGraphUpdates('1');

    const bundle = keyExport[0] as AddKeyUpdate;

    const addAction = [
      {
        Add: {
          data: u8aToHex(bundle.payload),
        },
      },
    ];
    graphKeyAction = {
      targetHash: 0,
      schemaId: 7,
      actions: addAction,
    };
  }

  const currentBlockNumber = (await ExtrinsicHelper.apiPromise.rpc.chain.getBlock()).block.header.number.toNumber();
  graphKeyAction.expiration = currentBlockNumber + ExtrinsicHelper.apiPromise.consts.msa.mortalityWindowSize.toNumber();
  const payloadBytes = ExtrinsicHelper.api.registry.createType('PalletStatefulStorageItemizedSignaturePayloadV2', graphKeyAction);
  const proof = signPayloadSr25519(user.keys!, payloadBytes);
  return { payload: { ...graphKeyAction }, proof };
}

async function getAddProviderPayload(user: ChainUser, provider: ChainUser): Promise<{ payload: AddProviderPayload; proof: Sr25519Signature }> {
  const block = await ExtrinsicHelper.apiPromise.rpc.chain.getBlock();
  const blockNumber = block.block.header.number.toNumber();
  const mortalityWindowSize = ExtrinsicHelper.apiPromise.consts.msa.mortalityWindowSize.toNumber();
  const addProvider: AddProviderPayload = {
    authorizedMsaId: provider.msaId,
    schemaIds: DEFAULT_SCHEMAS,
    expiration: blockNumber + mortalityWindowSize,
  };
  const payload = ExtrinsicHelper.apiPromise.registry.createType('PalletMsaAddProvider', addProvider);
  const proof = signPayloadSr25519(user.keys!, payload);

  return { payload: addProvider, proof };
}

async function populateExtrinsics(follower: ChainUser, provider: ChainUser): Promise<void> {
  if (follower.msaId) {
    //   const existingUser = await ExtrinsicHelper.apiPromise.query.msa.publicKeyToMsaId(follower.keys!.publicKey);
    //   if (existingUser.isSome) {
    //     follower.msaId = existingUser.unwrap();
    console.log(`Existing user ${follower.msaId.toString()} found`);
    follower.resetGraph = [];

    const pages = await ExtrinsicHelper.apiPromise.rpc.statefulStorage.getPaginatedStorage(follower.msaId, privateFollowSchemaId);
    // console.log('pages: ', pages.toHuman());
    pages.toArray().forEach((page) => {
      console.log(`Enqueuing graph page removal for user ${follower.msaId?.toString()}, page ${page.page_id}, content_hash: ${page.content_hash.toNumber()}`);
      follower.resetGraph?.push(() =>
        ExtrinsicHelper.apiPromise.tx.statefulStorage.deletePage(follower.msaId, privateFollowSchemaId, page.page_id.toNumber(), page.content_hash.toNumber()),
      );
    });

    return;
  }
  const { payload: addProviderPayload, proof } = await getAddProviderPayload(follower, provider);
  follower.create = () => ExtrinsicHelper.apiPromise.tx.msa.createSponsoredAccountWithDelegation(follower.keys!.publicKey, proof, addProviderPayload);

  const { payload: addGraphKeyPayload, proof: addGraphKeyProof } = await getAddGraphKeyPayload(graph, follower);
  follower.addGraphKey = () => ExtrinsicHelper.apiPromise.tx.statefulStorage.applyItemActionsWithSignatureV2(follower.keys!.publicKey, addGraphKeyProof, addGraphKeyPayload);
}

async function main() {
  await cryptoWaitReady();
  console.log('Connecting...');
  await initialize('ws://127.0.0.1:9944');
  log.setLevel('trace');
  const { apiPromise } = ExtrinsicHelper;

  const provider: ChainUser = { keys: keyring.addFromUri('//Alice') };
  const famousUser: ChainUser = { uri: '//Bob', keys: keyring.addFromUri('//Bob') };
  const followers = new Map<string, ChainUser>();

  // Create provider
  console.log('Creating provider...');
  const builder = new UserBuilder();
  const providerUser = await builder.withKeypair(provider.keys!).asProvider('Alice Provider').withFundingSource(provider.keys).build();
  provider.msaId = providerUser.msaId;
  console.log(`Created provider ${provider.msaId!.toString()}`);

  // Ensure provider is staked
  const capacity = await ExtrinsicHelper.apiPromise.query.capacity.capacityLedger(provider.msaId);
  if (capacity.isNone || capacity.unwrap().totalTokensStaked.toBigInt() < CAPACITY_AMOUNT_TO_STAKE) {
    await ExtrinsicHelper.stake(provider.keys!, provider.msaId, CAPACITY_AMOUNT_TO_STAKE).signAndSend();
    console.log(`Staked to provider`);
  }

  // Create all keypairs
  console.log('Creating keypairs...');
  new Array(7000).fill(0).forEach((_, index) => {
    const keys = keyring.addFromUri(`//Charlie//${index}`);
    followers.set(keys.address, { uri: `//Charlie//${index}`, keys, resetGraph: [] });
  });
  const [followerAddresses] = mapToArray(followers);
  console.log('Created keypairs');

  // Create graph keys for all users
  const graphEnvironment: EnvironmentInterface = { environmentType: EnvironmentType.Mainnet }; // use Mainnet for @dsnp/instant-seal-node-with-deployed-schemas
  graph = new Graph(graphEnvironment);
  privateFollowSchemaId = graph.getSchemaIdFromConfig(graphEnvironment, ConnectionType.Follow, PrivacyType.Private);
  console.log(`dsnp:private-follows schema ID is ${privateFollowSchemaId}`);

  // Get existing users
  const allMsas = await ExtrinsicHelper.apiPromise.query.msa.publicKeyToMsaId.multi([...followerAddresses]);
  followerAddresses.forEach((address, index) => {
    if (!allMsas[index].isNone) {
      followers.get(address)!.msaId = allMsas[index].unwrap();
    }
  });
  const famouseMsa = await ExtrinsicHelper.apiPromise.query.msa.publicKeyToMsaId(famousUser.keys!.address);
  if (famouseMsa.isSome) {
    famousUser.msaId = famouseMsa.unwrap();
  }

  interface PromiseTracker {
    resolve?: () => void;
    reject?: (reason?: any) => void;
    promise?: Promise<void>;
    numberPending: number;
  }

  const allBatchesTracker: PromiseTracker = { numberPending: 0 };

  let followersToCreate = 0;
  let graphsToClear = 0;

  // Create followers
  await Promise.all([
    ...followerAddresses.map((a) => {
      const follower = followers.get(a)!;
      return populateExtrinsics(follower, provider);
    }),
    populateExtrinsics(famousUser, provider),
  ]);
  const extrinsics: SubmittableExtrinsic<'promise', ISubmittableResult>[] = [];
  for (const follower of followers.values()) {
    if (follower?.create) {
      extrinsics.push(follower.create());
      followersToCreate++;
    }
    if (follower?.addGraphKey) {
      extrinsics.push(follower.addGraphKey());
    }
    if (follower?.resetGraph?.length && follower.resetGraph?.length > 0) {
      extrinsics.push(...follower.resetGraph.map((e) => e()));
      graphsToClear++;
    }
  }

  if (famousUser?.create) {
    extrinsics.push(famousUser.create());
    followersToCreate++;
  }
  if (famousUser?.addGraphKey) {
    extrinsics.push(famousUser.addGraphKey());
  }
  if (famousUser?.resetGraph?.length && famousUser.resetGraph?.length > 0) {
    extrinsics.push(...famousUser.resetGraph.map((e) => e()));
    graphsToClear++;
  }

  console.log(`
MSAs to create: ${followersToCreate}
User graphs to clear: ${graphsToClear}
`);

  let famousUserCreatedBlockHash: HexString | undefined;

  if (extrinsics.length !== 0) {
    console.log(`Enqueuing ${extrinsics.length} extrinsics for execution`);

    const maxBatch = apiPromise.consts.frequencyTxPayment.maximumCapacityBatchLength.toNumber();
    allBatchesTracker.promise = new Promise((resolve, reject) => {
      allBatchesTracker.resolve = resolve;
      allBatchesTracker.reject = reject;
      allBatchesTracker.numberPending = 0;
    });

    // Subscribe to events on-chain and update accounts as MSAs are created
    const unsubscribeEvents = await ExtrinsicHelper.apiPromise.query.system.events((events: Vec<FrameSystemEventRecord>) => {
      events.forEach((eventRecord) => {
        const { event } = eventRecord;
        if (ExtrinsicHelper.api.events.utility.BatchCompleted.is(event)) {
          allBatchesTracker.numberPending -= 1;
          if (allBatchesTracker.numberPending < 1) {
            allBatchesTracker.numberPending = 0;
            (allBatchesTracker?.resolve ?? (() => {}))();
          }
        } else if (ExtrinsicHelper.api.events.msa.MsaCreated.is(event)) {
          const { msaId, key } = event.data;
          const address = key.toString();
          const follower = followers.get(address);
          if (follower) {
            follower.msaId = msaId;
            followers.set(address, follower);
          } else if (address === famousUser.keys!.address) {
            famousUser.msaId = msaId;
            famousUserCreatedBlockHash = events.createdAtHash?.toHex();
          } else {
            console.error('Cannot find follower ', address);
          }
        }
      });
    });

    const unsubBlocks = await ExtrinsicHelper.apiPromise.rpc.chain.subscribeFinalizedHeads(() => {
      const count = extrinsics.length + allBatchesTracker.numberPending;
      console.log(`Extrinsincs remaining: ${count}`);
      if (count === 0) {
        unsubBlocks();
      }
    });

    nonce = (await apiPromise.query.system.account(provider.keys!.publicKey)).nonce.toNumber();

    while (extrinsics.length > 0) {
      if (allBatchesTracker.numberPending < 100) {
        const xToPost = extrinsics.splice(0, maxBatch);
        allBatchesTracker.numberPending += 1;
        // eslint-disable-next-line no-loop-func
        const unsub = await ExtrinsicHelper.apiPromise.tx.frequencyTxPayment.payWithCapacityBatchAll(xToPost).signAndSend(provider.keys!, { nonce: nonce++ }, (x) => {
          const { status } = x;
          // console.log(status.type);
          // console.dir(x.toHuman());
          //   x.events.forEach((e) => console.dir(e.event.toHuman()));
          if (x.dispatchError) {
            unsub();
            (allBatchesTracker?.reject ?? (() => {}))(new EventError(x.dispatchError));
          } else if (status.isInvalid) {
            unsub();
            console.log(x.toHuman());
            (allBatchesTracker?.reject ?? (() => {}))(new Error('Extrinsic failed: Invalid'));
          } else if (x.isFinalized) {
            unsub();
          }
        });
      } else {
        await allBatchesTracker.promise;
        allBatchesTracker.promise = new Promise((resolve, reject) => {
          allBatchesTracker.resolve = resolve;
          allBatchesTracker.reject = reject;
        });
      }
    }

    await allBatchesTracker.promise;
    unsubscribeEvents();
  }

  if (famousUserCreatedBlockHash) {
    const block = await apiPromise.rpc.chain.getBlock(famousUserCreatedBlockHash);
    console.log(`Famous user ${famousUser.msaId!.toString()} created at block ${block.block.header.number.toNumber()}`);
  }

  // Create JSON responses for each follower
  if (!fs.existsSync('webhook-specification/mock-webhook-server/responses')) {
    fs.mkdirSync('webhook-specification/mock-webhook-server/responses');
  }
  followers.forEach((follower) => {
    const response: ProviderResponse = {
      dsnpId: follower.msaId!.toString(),
      connections: {
        data: [
          {
            dsnpId: famousUser.msaId!.toString(),
            privacyType: 'Private',
            direction: 'connectionTo',
            connectionType: 'Follow',
          },
        ],
      },
      graphKeyPairs: [
        {
          keyType: 'X25519',
          publicKey: graphPublicKey,
          privateKey: graphPrivateKey,
        } as ProviderGraphKeyPair,
      ],
    };

    fs.writeFileSync(`webhook-specification/mock-webhook-server/responses/response.${follower.msaId?.toString()}.json`, JSON.stringify(response, undefined, 4));
  });

  const famousUserResponse = {
    dsnpId: famousUser.msaId!.toString(),
    graphKeyPairs: [
      {
        keyType: 'X25519',
        publicKey: graphPublicKey,
        privateKey: graphPrivateKey,
      } as ProviderGraphKeyPair,
    ],
  };

  const responses: ProviderResponse[] = [];
  const [_, allFollowers] = mapToArray(followers);
  while (allFollowers.length > 0) {
    const followerSlice = allFollowers.splice(0, Math.min(allFollowers.length, 50));
    const response = {
      ...famousUserResponse,
      connections: {
        data: followerSlice.flatMap((follower) => [
          {
            dsnpId: follower.msaId!.toString(),
            privacyType: 'Private',
            direction: 'connectionFrom',
            connectionType: 'Follow',
          } as ProviderGraph,
          {
            dsnpId: follower.msaId!.toString(),
            privacyType: 'Private',
            direction: 'connectionTo',
            connectionType: 'Follow',
          } as ProviderGraph,
        ]),
      },
    };
    responses.push(response);
  }

  responses.forEach((response, index) => {
    response.connections.pagination = {
      pageNumber: index + 1,
      pageCount: responses.length,
      pageSize: response.connections.data.length,
    };
    fs.writeFileSync(`webhook-specification/mock-webhook-server/responses/response.${famousUser.msaId!.toString()}.${index + 1}.json`, JSON.stringify(response, undefined, 4));
  });
}

main()
  .catch((e) => console.error(e))
  .finally(async () => ExtrinsicHelper.disconnect());
