import { ApiPromise } from '@polkadot/api';
import * as ScenarioConstants from './constants';
import * as ScenarioTypes from './types';
import { AddProviderPayload, Sr25519Signature, signPayloadSr25519 } from '@amplica-labs/frequency-scenario-template';
import { getExpiration } from './utils';

export async function getAddProviderPayload(
  api: ApiPromise,
  user: ScenarioTypes.ChainUser,
  provider: ScenarioTypes.ChainUser,
): Promise<{ payload: AddProviderPayload; proof: Sr25519Signature }> {
  const addProvider: AddProviderPayload = {
    authorizedMsaId: provider.msaId,
    schemaIds: ScenarioConstants.DEFAULT_SCHEMAS,
    expiration: await getExpiration(api),
  };
  const payload = api.registry.createType('PalletMsaAddProvider', addProvider);
  const proof = signPayloadSr25519(user.keys!, payload);

  return { payload: addProvider, proof };
}

export async function getCreateUserExtrinsic(api: ApiPromise, user: ScenarioTypes.ChainUser, provider: ScenarioTypes.ChainUser): Promise<void> {
  if (user?.msaId) {
    return;
  }

  const { payload, proof } = await getAddProviderPayload(api, user, provider);
  user.create = () => api.tx.msa.createSponsoredAccountWithDelegation(user.keys!.publicKey, proof, payload);
}

export async function resolveUsers(api: ApiPromise) {}
