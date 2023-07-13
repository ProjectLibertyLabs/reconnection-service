import { options } from '@frequency-chain/api-augment';
import { ApiRx, WsProvider, ApiPromise, Keyring } from '@polkadot/api';
import { firstValueFrom } from 'rxjs';
import { KeyringPair } from '@polkadot/keyring/types';
import { env } from './env';

// eslint-disable-next-line import/no-mutable-exports
export let keyring: Keyring;

export async function connect(providerUrl?: string | string[] | undefined): Promise<ApiRx> {
  const provider = new WsProvider(providerUrl || env.providerUrl);
  const apiObservable = ApiRx.create({ provider, ...options });
  return firstValueFrom(apiObservable);
}

export async function connectPromise(providerUrl?: string | string[] | undefined): Promise<ApiPromise> {
  const provider = new WsProvider(providerUrl || env.providerUrl);
  const api = await ApiPromise.create({ provider, ...options });
  await api.isReady;
  return api;
}

export function createKeys(uri: string): KeyringPair {
  if (!keyring) {
    keyring = new Keyring({ type: 'sr25519' });
  }

  const keys = keyring.addFromUri(uri);

  return keys;
}
