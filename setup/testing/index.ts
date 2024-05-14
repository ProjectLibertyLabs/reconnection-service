/* eslint-disable no-plusplus */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */
import '@frequency-chain/api-augment';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, mnemonicGenerate } from '@polkadot/util-crypto';
import { ExtrinsicHelper, UserBuilder, initialize } from '@amplica-labs/frequency-scenario-template';
import log from 'loglevel';
import { ProviderGraph, GraphKeyPair as ProviderGraphKeyPair } from 'reconnection-service/src/interfaces/provider-graph.interface';
import fs from 'node:fs';
import { ConnectionType, EnvironmentInterface, EnvironmentType, Graph, PrivacyType } from '@dsnp/graph-sdk';
import { HexString } from '@polkadot/util/types';
import * as ScenarioTypes from './types';
import * as ScenarioConstants from './constants';
import { getAddGraphKeyPayload, createClearGraphExtrinsics, graphKeypair } from './graph';
import { getAddProviderPayload } from './msa';
import { addExtrinsicToTrack, submitAndTrackExtrinsics } from './utils';
import { Event } from '@polkadot/types/interfaces';

let privateFollowSchemaId: number;

const keyring = new Keyring({ type: 'sr25519' });
let graph: Graph;

async function populateExtrinsics(follower: ScenarioTypes.ChainUser, provider: ScenarioTypes.ChainUser): Promise<void> {
  if (follower.msaId) {
    console.log(`Existing user ${follower.msaId.toString()} found`);
    follower.resetGraph = await createClearGraphExtrinsics(ExtrinsicHelper.apiPromise, follower.msaId);

    return;
  }
  const { payload: addProviderPayload, proof } = await getAddProviderPayload(ExtrinsicHelper.apiPromise, follower, provider);
  follower.create = () => ExtrinsicHelper.apiPromise.tx.msa.createSponsoredAccountWithDelegation(follower.keys!.publicKey, proof, addProviderPayload);

  const graphKeyPayload = await getAddGraphKeyPayload(ExtrinsicHelper.apiPromise, graph, graphKeypair, follower);
  if (graphKeyPayload) {
    const { payload: addGraphKeyPayload, proof: addGraphKeyProof } = graphKeyPayload;
    follower.addGraphKey = () => ExtrinsicHelper.apiPromise.tx.statefulStorage.applyItemActionsWithSignatureV2(follower.keys!.publicKey, addGraphKeyProof, addGraphKeyPayload);
  }
}

async function main() {
  await cryptoWaitReady();
  console.log('Connecting...');
  await initialize('ws://127.0.0.1:9944');
  log.setLevel('trace');
  const { apiPromise } = ExtrinsicHelper;

  const provider: ScenarioTypes.ChainUser = {
    keys: keyring.createFromUri(
      'credit silent bridge invite buffalo start sell cement naive arch elbow frame also innocent unaware useless cabin mechanic beach suspect thrive crawl essay taxi',
    ),
  };
  // const provider: ChainUser = { keys: keyring.createFromUri('//Alice') };
  const bobSeed = mnemonicGenerate();
  // const famousUser: ChainUser = { uri: '//Bob', keys: keyring.createFromUri('//Bob') };
  const famousUser: ScenarioTypes.ChainUser = { uri: bobSeed, keys: keyring.createFromUri(bobSeed) };
  const followers = new Map<string, ScenarioTypes.ChainUser>();

  // Create provider
  console.log('Creating provider...');
  const builder = new UserBuilder();
  const providerUser = await builder.withKeypair(provider.keys!).asProvider('Alice Provider').withFundingSource(provider.keys).build();
  provider.msaId = providerUser.msaId;
  console.log(`Created provider ${provider.msaId!.toString()}`);

  // Ensure provider is staked
  const capacity = await ExtrinsicHelper.apiPromise.query.capacity.capacityLedger(provider.msaId);
  if (capacity.isNone || capacity.unwrap().totalTokensStaked.toBigInt() < ScenarioConstants.CAPACITY_AMOUNT_TO_STAKE) {
    await ExtrinsicHelper.stake(provider.keys!, provider.msaId, ScenarioConstants.CAPACITY_AMOUNT_TO_STAKE).signAndSend();
    console.log(`Staked to provider`);
  }

  // Create all keypairs
  console.log('Creating keypairs...');
  new Array(10).fill(0).forEach((_) => {
    // const keys = keyring.createFromUri(`//Charlie//${index}`);
    // followers.set(keys.address, { uri: `//Charlie//${index}`, keys, resetGraph: [] });
    const seed = mnemonicGenerate();
    const keys = keyring.createFromUri(seed);
    followers.set(keys.address, { keys, resetGraph: [] });
  });
  const followerAddresses = [...followers.keys()];
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
  const famousMsa = await ExtrinsicHelper.apiPromise.query.msa.publicKeyToMsaId(famousUser.keys!.address);
  if (famousMsa.isSome) {
    famousUser.msaId = famousMsa.unwrap();
    console.log(`Found famous user ${famousUser.msaId.toString()}`);
  }

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

  for (const follower of followers.values()) {
    if (follower?.create) {
      addExtrinsicToTrack(follower.create());
      followersToCreate++;
    }
    if (follower?.addGraphKey) {
      addExtrinsicToTrack(follower.addGraphKey());
    }
    if (follower?.resetGraph?.length && follower.resetGraph?.length > 0) {
      follower.resetGraph.forEach((e) => addExtrinsicToTrack(e()));
      graphsToClear++;
    }
  }

  if (famousUser?.create) {
    addExtrinsicToTrack(famousUser.create());
    followersToCreate++;
  }
  if (famousUser?.addGraphKey) {
    addExtrinsicToTrack(famousUser.addGraphKey());
  }
  if (famousUser?.resetGraph?.length && famousUser.resetGraph?.length > 0) {
    famousUser.resetGraph.forEach((e) => addExtrinsicToTrack(e()));
    graphsToClear++;
  }

  console.log(`
MSAs to create: ${followersToCreate}
User graphs to clear: ${graphsToClear}
`);

  let famousUserCreatedBlockHash: HexString | undefined;

  await submitAndTrackExtrinsics(apiPromise, provider, (event: Event) => {
    if (apiPromise.events.msa.MsaCreated.is(event)) {
      const { msaId, key } = event.data;
      const address = key.toString();
      const follower = followers.get(address);
      if (follower) {
        follower.msaId = msaId;
        followers.set(address, follower);
      } else if (address === famousUser.keys!.address) {
        famousUser.msaId = msaId;
        famousUserCreatedBlockHash = event.createdAtHash?.toHex();
      } else {
        console.error('Cannot find follower ', address);
      }
    }
  });

  if (famousUserCreatedBlockHash) {
    const block = await apiPromise.rpc.chain.getBlock(famousUserCreatedBlockHash);
    console.log(`Famous user ${famousUser.msaId!.toString()} created at block ${block.block.header.number.toNumber()}`);
  }

  // Create JSON responses for each follower
  if (!fs.existsSync('webhook-specification/mock-webhook-server/responses')) {
    fs.mkdirSync('webhook-specification/mock-webhook-server/responses');
  }
  followers.forEach((follower) => {
    const response: ScenarioTypes.ProviderResponse = {
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
          publicKey: ScenarioConstants.graphPublicKey,
          privateKey: ScenarioConstants.graphPrivateKey,
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
        publicKey: ScenarioConstants.graphPublicKey,
        privateKey: ScenarioConstants.graphPrivateKey,
      } as ProviderGraphKeyPair,
    ],
  };

  const responses: ScenarioTypes.ProviderResponse[] = [];
  const allFollowers = [...followers.values()];
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
