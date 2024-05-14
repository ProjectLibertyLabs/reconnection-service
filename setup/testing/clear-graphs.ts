import { ExtrinsicHelper } from '@amplica-labs/frequency-scenario-template';
import { createAddGraphKeyExtrinsic, createClearGraphExtrinsics, graphKeypair } from './graph';
import { addExtrinsicToTrack, api, famousUser, followers, graph, initScenario, provider, submitAndTrackExtrinsics } from './utils';
import { ProviderGraph, GraphKeyPair as ProviderGraphKeyPair } from 'reconnection-service/src/interfaces/provider-graph.interface';
import fs from 'node:fs';
import * as ScenarioTypes from './types';
import * as ScenarioConstants from './constants';

async function main() {
  await initScenario();

  const followersToProcess = [...followers.values()].filter((follower) => follower?.msaId);
  if (famousUser?.msaId) {
    followersToProcess.push(famousUser);
  }

  // Create graph extrinsics
  await Promise.all(
    followersToProcess.map(async (follower) => {
      await createAddGraphKeyExtrinsic(api, graph, graphKeypair, follower);
      await createClearGraphExtrinsics(api, follower);
    }),
  );
  let graphKeysToUpdate = 0;
  let graphsToClear = 0;

  for (const follower of followers.values()) {
    if (follower?.addGraphKey) {
      addExtrinsicToTrack(follower.addGraphKey());
      graphKeysToUpdate++;
    }

    if (follower?.resetGraph) {
      follower.resetGraph.forEach((e) => addExtrinsicToTrack(e()));
      graphsToClear++;
    }
  }

  if (famousUser?.addGraphKey) {
    addExtrinsicToTrack(famousUser.addGraphKey());
    graphKeysToUpdate++;
  }

  if (famousUser?.resetGraph) {
    famousUser.resetGraph.forEach((e) => addExtrinsicToTrack(e()));
    graphsToClear++;
  }

  console.log(`
Users requiring public graph key update: ${graphKeysToUpdate}
Users requiring graph reset: ${graphsToClear}
`);

  await submitAndTrackExtrinsics(api, provider);

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
