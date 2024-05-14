import { ApiPromise } from '@polkadot/api';
import { SubmittableExtrinsic } from '@polkadot/api-base/types';
import { GenericExtrinsic, u16 } from '@polkadot/types';
import { AnyTuple, ISubmittableResult } from '@polkadot/types/types';
import * as ScenarioTypes from './types';
import * as ScenarioConstants from './constants';
import { Block, Event, Header } from '@polkadot/types/interfaces';
import { EventError, ExtrinsicHelper, UserBuilder, initialize, keyring } from '@amplica-labs/frequency-scenario-template';
import { HexString } from '@polkadot/util/types';
import { EnvironmentInterface, EnvironmentType, Graph } from '@dsnp/graph-sdk';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import log from 'loglevel';

export let privateFollowSchemaId: u16;
export let publicGraphKeySchemaId: u16;
export let provider: ScenarioTypes.ChainUser;
export let famousUser: ScenarioTypes.ChainUser;
export const followers = new Map<string, ScenarioTypes.ChainUser>();
export let api: ApiPromise;
const graphEnvironment: EnvironmentInterface = { environmentType: EnvironmentType.TestnetPaseo };
export const graph = new Graph(graphEnvironment);

const extrinsics: SubmittableExtrinsic<'promise', ISubmittableResult>[] = [];

export async function initScenario() {
  const frequencyUrl = process.env['FREQUENCY_URL'];
  const seedPhrase = process.env['PASEO_PROVIDER_SEED_PHRASE'];
  if (!frequencyUrl) {
    throw new Error('FREQUENCY_URL not defined');
  }
  if (!seedPhrase) {
    throw new Error('PASEO_PROVIDER_SEED_PHRASE not defined');
  }

  await cryptoWaitReady();
  console.log('Connecting...');
  await initialize(frequencyUrl);
  log.setLevel('trace');
  api = ExtrinsicHelper.apiPromise;

  await initializeSchemaIds(api);

  provider = {
    keys: keyring.createFromUri(seedPhrase),
  };

  const famousUserUri = `${seedPhrase}//famous`;
  famousUser = { uri: famousUserUri, keys: keyring.createFromUri(famousUserUri) };

  // Create provider
  console.log('Resolving/creating provider...');
  const builder = new UserBuilder();
  const providerUser = await builder.withKeypair(provider.keys!).asProvider('Test Provider').withFundingSource(provider.keys).build();
  provider.msaId = providerUser.msaId;
  console.log(`Found or created provider ${provider.msaId!.toString()}`);

  // Ensure provider is staked
  const capacity = await api.query.capacity.capacityLedger(provider.msaId);
  if (capacity.isNone || capacity.unwrap().totalTokensStaked.toBigInt() < ScenarioConstants.CAPACITY_AMOUNT_TO_STAKE) {
    await ExtrinsicHelper.stake(provider.keys!, provider.msaId, ScenarioConstants.CAPACITY_AMOUNT_TO_STAKE).signAndSend();
    console.log(`Brought provider capacity stake up to ${ScenarioConstants.CAPACITY_AMOUNT_TO_STAKE}`);
  }

  // Create all keypairs
  console.log(`Creating ${ScenarioConstants.NUM_FOLLOWERS} keypairs...`);
  new Array(ScenarioConstants.NUM_FOLLOWERS).fill(0).forEach((_, index) => {
    const followerSeed = `${seedPhrase}//${index}`;
    const keys = keyring.createFromUri(followerSeed);
    followers.set(keys.address, { uri: followerSeed, keys, resetGraph: [] });
    followers.set(keys.address, { keys });
  });
  const followerAddresses = [...followers.keys()];
  console.log(`Created ${ScenarioConstants.NUM_FOLLOWERS} keypairs`);

  // Get any existing users so we don't create new ones
  const allMsas = await api.query.msa.publicKeyToMsaId.multi([...followerAddresses]);
  followerAddresses.forEach((address, index) => {
    if (!allMsas[index].isNone) {
      followers.get(address)!.msaId = allMsas[index].unwrap();
    }
  });
  const famousMsa = await api.query.msa.publicKeyToMsaId(famousUser.keys!.address);
  if (famousMsa.isSome) {
    famousUser.msaId = famousMsa.unwrap();
    console.log(`Found famous user ${famousUser.msaId.toString()}`);
  }
}

export async function initializeSchemaIds(api: ApiPromise) {
  let schemaId = (await api.query.schemas.schemaNameToIds('dsnp', 'public-key-key-agreement')).ids.pop();
  if (schemaId) {
    publicGraphKeySchemaId = schemaId;
  }

  schemaId = (await api.query.schemas.schemaNameToIds('dsnp', 'private-follows')).ids.pop();
  if (schemaId) {
    privateFollowSchemaId = schemaId;
  }

  if (!privateFollowSchemaId || !publicGraphKeySchemaId) {
    throw new Error('Unable to determine schema IDs');
  }
}

export async function getExpiration(api: ApiPromise, blocks?: number): Promise<number> {
  const currentBlockNumber = (await api.rpc.chain.getBlock()).block.header.number.toNumber();

  return currentBlockNumber + (blocks ? blocks : api.consts.msa.mortalityWindowSize.toNumber());
}

export function addExtrinsicToTrack(extrinsic: SubmittableExtrinsic<'promise', ISubmittableResult>) {
  extrinsics.push(extrinsic);
}

export async function submitAndTrackExtrinsics(
  api: ApiPromise,
  provider: ScenarioTypes.ChainUser,
  eventCallback?: (block: Block, extrinsic: GenericExtrinsic<AnyTuple>, eventRecord: Event) => void,
) {
  if (!extrinsics.length) {
    return;
  }

  console.log(`Enqueueing ${extrinsics.length} transactions for execution`);

  const maxBatch = api.consts.frequencyTxPayment.maximumCapacityBatchLength.toNumber();
  const tracker = new ScenarioTypes.PromiseTracker();

  // Log how many tracked extrinsics remain after each new block
  const unsubBlocks = await api.rpc.chain.subscribeFinalizedHeads((header: Header) => {
    api.rpc.chain.getBlock(header.hash).then((signedBlock) => {
      api.at(header.hash).then((apiAt) => {
        apiAt.query.system.events().then((allEvents) => {
          // Map events to their extrinsics & filter to only ones we're watching
          signedBlock.block.extrinsics.forEach((extrinsic, index) => {
            if (tracker.pendingExtrinsics.has(extrinsic.hash.toString() as HexString)) {
              allEvents
                .filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(index))
                .forEach((eventRecord) => {
                  const { event } = eventRecord;
                  if (eventCallback) {
                    eventCallback(signedBlock.block, extrinsic, event);
                  }

                  if (api.events.utility.BatchCompleted.is(event)) {
                    tracker.pendingExtrinsics.delete(extrinsic.hash.toString() as HexString);
                  }

                  if (api.events.utility.ItemCompleted.is(event)) {
                    tracker.pendingTxnCount -= 1;
                    if (tracker.pendingTxnCount < 1) {
                      tracker.pendingTxnCount = 0;
                      tracker.resolve();
                    }
                  }
                });
            }
          });

          const count = extrinsics.length + tracker.pendingTxnCount;
          console.log(`Transactions remaining: ${count}`);
          if (count === 0) {
            unsubBlocks();
          }
        });
      });
    });
  });

  // TODO: Nonce only works on Testnet if nobody else is executing extrinsics for this provider
  let nonce = (await api.query.system.account(provider.keys!.publicKey)).nonce.toNumber();

  while (extrinsics.length > 0) {
    if (tracker.pendingExtrinsics.size < ScenarioConstants.MAX_EXTRINSICS_TO_SUBMIT) {
      const xToPost = extrinsics.splice(0, maxBatch);
      tracker.pendingTxnCount += xToPost.length;
      const unsubTx = await api.tx.frequencyTxPayment.payWithCapacityBatchAll(xToPost).signAndSend(provider.keys!, { nonce: nonce++ }, (x) => {
        tracker.pendingExtrinsics.add(x.txHash.toString() as HexString);
        if (x.dispatchError) {
          unsubTx();
          tracker.reject(new EventError(x.dispatchError));
        } else if (x.status.isInvalid) {
          unsubTx();
          console.log(x.toHuman());
          tracker.reject(new Error('Extrinsic failed: Invalid'));
        } else if (x.isFinalized) {
          unsubTx();
        }
      });
    } else {
      await tracker.promise;
      tracker.resetPromise();
    }
  }

  await tracker.promise;
}
