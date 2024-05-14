import '@frequency-chain/api-augment';
import { AddGraphKeyAction, AddKeyUpdate, DsnpKeys, Graph, GraphKeyPair, GraphKeyType, ImportBundleBuilder, KeyData } from '@dsnp/graph-sdk';
import { ApiPromise } from '@polkadot/api';
import { AnyNumber, ISubmittableResult } from '@polkadot/types/types';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import * as ScenarioTypes from './types';
import { HexString } from '@polkadot/util/types';
import { ItemizedSignaturePayload, Sr25519Signature, signPayloadSr25519 } from '@amplica-labs/frequency-scenario-template';
import { getExpiration, privateFollowSchemaId, publicGraphKeySchemaId } from './utils';
import { ItemizedStoragePageResponse, PageHash } from '@frequency-chain/api-augment/interfaces';
import { SubmittableExtrinsic } from '@polkadot/api-base/types';

export const graphPublicKey: HexString = '0x0514f63edc89d414061bf451cc99b1f2b43fac920c351be60774559a31523c75';
export const graphPrivateKey: HexString = '0x1c15b6d1af4716615a4eb83a2dfba3284e1c0a199603572e7b95c164f7ad90e3';
export const graphKeypair: GraphKeyPair = {
  keyType: GraphKeyType.X25519,
  publicKey: hexToU8a(graphPublicKey),
  secretKey: hexToU8a(graphPrivateKey),
};

export function createGraphKeyPair(): GraphKeyPair {
  return Graph.generateKeyPair(GraphKeyType.X25519);
}

async function isGraphKeyCurrent(api: ApiPromise, graph: Graph, keypair: GraphKeyPair, msaId: AnyNumber): Promise<[boolean, PageHash]> {
  const itemizedResponse: ItemizedStoragePageResponse = await api.rpc.statefulStorage.getItemizedStorage(msaId, publicGraphKeySchemaId);
  const keyData: KeyData[] = itemizedResponse.items.toArray().map((publicKey) => ({
    index: publicKey.index.toNumber(),
    content: hexToU8a(publicKey.payload.toHex()),
  }));
  const dsnpKeys: DsnpKeys = {
    dsnpUserId: msaId.toString(),
    keysHash: itemizedResponse.content_hash.toNumber(),
    keys: keyData,
  };

  const bundle = new ImportBundleBuilder().withDsnpUserId(msaId.toString()).withDsnpKeys(dsnpKeys).build();
  graph.importUserData([bundle]);

  const keys = graph.getPublicKeys(msaId.toString());
  const latestKey = u8aToHex(keys.pop()?.key);
  if (latestKey === u8aToHex(keypair.publicKey)) {
    return [true, itemizedResponse.content_hash];
  }

  return [false, itemizedResponse.content_hash];
}

export async function getAddGraphKeyPayload(
  api: ApiPromise,
  graph: Graph,
  keypair: GraphKeyPair,
  user: ScenarioTypes.ChainUser,
): Promise<{ payload: ItemizedSignaturePayload; proof: Sr25519Signature } | null> {
  const [keyIsCurrent, targetHash] = await isGraphKeyCurrent(api, graph, keypair, user.msaId!);
  if (keyIsCurrent) {
    return null;
  }

  const actions = [
    {
      type: 'AddGraphKey',
      ownerDsnpUserId: user.msaId?.toString(),
      newPublicKey: hexToU8a(graphPublicKey),
    } as AddGraphKeyAction,
  ];

  graph.applyActions(actions);
  const keyExport = graph.exportUserGraphUpdates(user.msaId!.toString());

  if (keyExport.length > 0) {
    const bundle = keyExport[0] as AddKeyUpdate;

    const addAction = [
      {
        Add: {
          data: u8aToHex(bundle.payload),
        },
      },
    ];

    const graphKeyAction = {
      targetHash: targetHash,
      schemaId: publicGraphKeySchemaId,
      actions: addAction,
      expiration: await getExpiration(api),
    };

    const payloadBytes = api.registry.createType('PalletStatefulStorageItemizedSignaturePayloadV2', graphKeyAction);
    const proof = signPayloadSr25519(user.keys!, payloadBytes);

    return { payload: { ...graphKeyAction }, proof };
  }

  return null;
}

export async function createAddGraphKeyExtrinsic(api: ApiPromise, graph: Graph, keypair: GraphKeyPair, user: ScenarioTypes.ChainUser): Promise<void> {
  const [keyIsCurrent] = await isGraphKeyCurrent(api, graph, keypair, user.msaId!);
  if (!keyIsCurrent) {
    const result = await getAddGraphKeyPayload(api, graph, keypair, user);
    if (result) {
      const { payload, proof } = result;
      user.addGraphKey = () => api.tx.statefulStorage.applyItemActionsWithSignatureV2(user.keys!.publicKey, proof, payload);
    }
  }
}

export async function createClearGraphExtrinsics(api: ApiPromise, user: ScenarioTypes.ChainUser) {
  const clearGraphExtrinsics: (() => SubmittableExtrinsic<'promise', ISubmittableResult>)[] = [];

  const pages = await api.rpc.statefulStorage.getPaginatedStorage(user.msaId!, privateFollowSchemaId);
  pages.toArray().forEach((page) => {
    clearGraphExtrinsics.push(() => api.tx.statefulStorage.deletePage(user.msaId!, privateFollowSchemaId, page.page_id, page.content_hash));
  });

  if (clearGraphExtrinsics.length > 0) {
    user.resetGraph = clearGraphExtrinsics;
  }
}
