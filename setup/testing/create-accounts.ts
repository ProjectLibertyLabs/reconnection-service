import { ApiPromise } from '@polkadot/api';
import * as ScenarioTypes from './types';
import { ExtrinsicHelper } from '@amplica-labs/frequency-scenario-template';
import { getAddGraphKeyPayload, graphKeypair } from './graph';
import { getAddProviderPayload, getCreateUserExtrinsic } from './msa';
import { Graph } from '@dsnp/graph-sdk';
import { addExtrinsicToTrack, api, famousUser, followers, initScenario, provider, submitAndTrackExtrinsics } from './utils';
import { Block, Event } from '@polkadot/types/interfaces';
import { GenericExtrinsic } from '@polkadot/types';
import { AnyTuple } from '@polkadot/types/types';

async function createUser(api: ApiPromise, graph: Graph, user: ScenarioTypes.ChainUser, provider: ScenarioTypes.ChainUser) {
  if (!user.msaId) {
    const { payload: addProviderPayload, proof } = await getAddProviderPayload(ExtrinsicHelper.apiPromise, user, provider);
    user.create = () => api.tx.msa.createSponsoredAccountWithDelegation(user.keys!.publicKey, proof, addProviderPayload);

    const graphKeyPayload = await getAddGraphKeyPayload(ExtrinsicHelper.apiPromise, graph, graphKeypair, user);
    if (graphKeyPayload) {
      const { payload: addGraphKeyPayload, proof: addGraphKeyProof } = graphKeyPayload;
      user.addGraphKey = () => ExtrinsicHelper.apiPromise.tx.statefulStorage.applyItemActionsWithSignatureV2(user.keys!.publicKey, addGraphKeyProof, addGraphKeyPayload);
    }
  }
}

async function main() {
  await initScenario();

  let followersToCreate = 0;

  // Create followers
  await Promise.all([
    [...followers.keys()].map((a) => {
      const follower = followers.get(a)!;
      return getCreateUserExtrinsic(api, follower, provider);
    }),
    getCreateUserExtrinsic(api, famousUser, provider),
  ]);

  for (const follower of followers.values()) {
    if (follower?.create) {
      addExtrinsicToTrack(follower.create());
      followersToCreate++;
    }
  }

  if (famousUser?.create) {
    addExtrinsicToTrack(famousUser.create());
    followersToCreate++;
  }

  console.log(`
MSAs to create: ${followersToCreate}
`);

  await submitAndTrackExtrinsics(api, provider, (block: Block, _extrinsic: GenericExtrinsic<AnyTuple>, event: Event) => {
    if (api.events.msa.MsaCreated.is(event)) {
      const { msaId, key } = event.data;
      const address = key.toString();
      const follower = followers.get(address);
      if (follower) {
        follower.msaId = msaId;
        follower.createdAtBlock = block.header.number.toNumber();
        followers.set(address, follower);
      } else if (address === famousUser.keys!.address) {
        famousUser.msaId = msaId;
        famousUser.createdAtBlock = block.header.number.toNumber();
      } else {
        console.error('Cannot find follower ', address);
      }
    }
  });

  //   console.dir(
  //     [...followers.values()].map((follower) => follower.createdAtBlock),
  //     { maxArrayLength: null },
  //   );
  const firstBlock = Math.min(...[...followers.values()].map((follower) => follower.createdAtBlock || 0));
  if (firstBlock) {
    console.log(`First user created at block ${firstBlock}`);
  }

  if (famousUser.createdAtBlock) {
    console.log(`Last (famous) user ${famousUser.msaId!.toString()} created at block ${famousUser.createdAtBlock}`);
  }
}

main()
  .catch((e) => console.error(e))
  .finally(async () => ExtrinsicHelper.disconnect());
