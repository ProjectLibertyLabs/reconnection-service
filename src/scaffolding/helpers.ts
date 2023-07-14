/* eslint-disable import/no-cycle */
/* eslint-disable no-use-before-define */
/* eslint-disable new-cap */
import { KeyringPair } from '@polkadot/keyring/types';
import { u16, u32, u64, Option, u128 } from '@polkadot/types';
import { Codec } from '@polkadot/types/types';
import { u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { mnemonicGenerate } from '@polkadot/util-crypto';
import { HandleResponse, MessageSourceId, PageHash } from '@frequency-chain/api-augment/interfaces';
import assert from 'assert';
import { firstValueFrom } from 'rxjs';
import Keyring, { encodeAddress } from '@polkadot/keyring';
import { AddKeyData, AddProviderPayload, ExtrinsicHelper, ItemizedSignaturePayload, PaginatedDeleteSignaturePayload, PaginatedUpsertSignaturePayload } from './extrinsicHelpers';
import { env } from './env';
import { createKeys as apiCreateKeys } from './apiConnection';

export interface Account {
  uri: string;
  keys: KeyringPair;
}

export const devAccounts: Account[] = [];

export type Sr25519Signature = { Sr25519: `0x${string}` };

export const TEST_EPOCH_LENGTH = 10;
export const CENTS = 1000000n;
export const DOLLARS = 100n * CENTS;
export const CHAIN_ENVIRONMENT = {
  DEVELOPMENT: 'dev',
  ROCOCO_TESTNET: 'rococo-testnet',
  ROCOCO_LOCAL: 'rococo-local',
};

// eslint-disable-next-line import/no-mutable-exports
export let EXISTENTIAL_DEPOSIT: bigint;

export async function initialize(): Promise<void> {
  await ExtrinsicHelper.initialize();
  EXISTENTIAL_DEPOSIT = ExtrinsicHelper.api.consts.balances.existentialDeposit.toBigInt();

  if (process.env.CHAIN_ENVIRONMENT === CHAIN_ENVIRONMENT.ROCOCO_TESTNET) {
    const seedPhrase = process.env.FUNDING_ACCOUNT_SEED_PHRASE;

    if (seedPhrase === undefined) {
      console.error('FUNDING_ACCOUNT_SEED_PHRASE must not be undefined when CHAIN_ENVIRONMENT is "rococo"');
      process.exit(1);
    }

    devAccounts.push({
      uri: 'RococoTestRunnerAccount',
      keys: apiCreateKeys(seedPhrase),
    });
  } else {
    ['//Alice', '//Bob', '//Charlie', '//Dave', '//Eve', '//Ferdie'].forEach((uri) =>
      devAccounts.push({
        uri,
        keys: apiCreateKeys(uri),
      }),
    );
  }
}

export function signPayloadSr25519(keys: KeyringPair, data: Codec): Sr25519Signature {
  return { Sr25519: u8aToHex(keys.sign(u8aWrapBytes(data.toU8a()))) };
}

export async function getBlockNumber(): Promise<number> {
  return (await ExtrinsicHelper.getLastBlock()).block.header.number.toNumber();
}

export async function generateDelegationPayload(payloadInputs: AddProviderPayload, expirationOffset?: number): Promise<AddProviderPayload> {
  // eslint-disable-next-line prefer-const
  let { expiration, ...payload } = payloadInputs;
  if (!expiration) {
    expiration = (await getBlockNumber()) + (expirationOffset || 5);
  }

  return {
    expiration,
    ...payload,
  };
}

export async function generateAddKeyPayload(
  payloadInputs: AddKeyData,
  // eslint-disable-next-line default-param-last
  expirationOffset: number = 100,
  blockNumber?: number,
): Promise<AddKeyData> {
  // eslint-disable-next-line prefer-const
  let { expiration, ...payload } = payloadInputs;
  if (!expiration) {
    expiration = (blockNumber || (await getBlockNumber())) + expirationOffset;
  }

  return {
    expiration,
    ...payload,
  };
}

export async function generateItemizedSignaturePayload(payloadInputs: ItemizedSignaturePayload, expirationOffset?: number): Promise<ItemizedSignaturePayload> {
  // eslint-disable-next-line prefer-const
  let { expiration, ...payload } = payloadInputs;
  if (!expiration) {
    expiration = (await ExtrinsicHelper.getLastBlock()).block.header.number.toNumber() + (expirationOffset || 5);
  }

  return {
    expiration,
    ...payload,
  };
}

export async function generatePaginatedUpsertSignaturePayload(payloadInputs: PaginatedUpsertSignaturePayload, expirationOffset?: number): Promise<PaginatedUpsertSignaturePayload> {
  // eslint-disable-next-line prefer-const
  let { expiration, ...payload } = payloadInputs;
  if (!expiration) {
    expiration = (await ExtrinsicHelper.getLastBlock()).block.header.number.toNumber() + (expirationOffset || 5);
  }

  return {
    expiration,
    ...payload,
  };
}

export async function generatePaginatedDeleteSignaturePayload(payloadInputs: PaginatedDeleteSignaturePayload, expirationOffset?: number): Promise<PaginatedDeleteSignaturePayload> {
  // eslint-disable-next-line prefer-const
  let { expiration, ...payload } = payloadInputs;
  if (!expiration) {
    expiration = (await ExtrinsicHelper.getLastBlock()).block.header.number.toNumber() + (expirationOffset || 5);
  }

  return {
    expiration,
    ...payload,
  };
}

export function createKeys(name: string = 'first pair'): KeyringPair {
  const mnemonic = mnemonicGenerate();
  console.log(`mnemonic: ${mnemonic}`);
  // create & add the pair to the keyring with the type and some additional
  // metadata specified
  const keyring = new Keyring({ type: 'sr25519' });
  const keypair = keyring.addFromUri(mnemonic, { name }, 'sr25519');
  const encodedAddress = encodeAddress(keypair.publicKey, 42);
  console.log(`${name} keys: ${Buffer.from(encodedAddress).toString()}`);
  return keypair;
}

export function getDefaultFundingSource() {
  return devAccounts[0];
}

export async function fundKeypair(source: KeyringPair, dest: KeyringPair, amount: bigint, nonce?: number): Promise<void> {
  await ExtrinsicHelper.transferFunds(source, dest, amount).signAndSend(nonce);
}

export async function createAndFundKeypair(
  // eslint-disable-next-line default-param-last
  amount: bigint = EXISTENTIAL_DEPOSIT,
  keyName?: string,
  source?: KeyringPair,
  nonce?: number,
): Promise<KeyringPair> {
  const defaultFundingSource = getDefaultFundingSource();
  const keypair = createKeys(keyName);

  // Transfer funds from source (usually pre-funded dev account) to new account
  await fundKeypair(source || defaultFundingSource.keys, keypair, amount, nonce);

  return keypair;
}

export function log(...args: any[]) {
  if (env.verbose) {
    console.log(...args);
  }
}

export async function createProviderKeysAndId(): Promise<[KeyringPair, u64]> {
  const providerKeys = await createAndFundKeypair();
  const createProviderMsaOp = ExtrinsicHelper.createMsa(providerKeys);
  let providerId = new u64(ExtrinsicHelper.api.registry, 0);
  await createProviderMsaOp.fundAndSend();
  const createProviderOp = ExtrinsicHelper.createProvider(providerKeys, 'PrivateProvider');
  const [providerEvent] = await createProviderOp.fundAndSend();
  if (providerEvent && ExtrinsicHelper.api.events.msa.ProviderCreated.is(providerEvent)) {
    providerId = providerEvent.data.providerId;
  }
  return [providerKeys, providerId];
}

export async function createDelegator(): Promise<[KeyringPair, u64]> {
  const keys = await createAndFundKeypair();
  let delegatorMsaId = new u64(ExtrinsicHelper.api.registry, 0);
  const createMsa = ExtrinsicHelper.createMsa(keys);
  const [msaCreatedEvent, _] = await createMsa.fundAndSend();

  if (msaCreatedEvent && ExtrinsicHelper.api.events.msa.MsaCreated.is(msaCreatedEvent)) {
    delegatorMsaId = msaCreatedEvent.data.msaId;
  }

  return [keys, delegatorMsaId];
}

export async function createDelegatorAndDelegation(schemaId: u16, providerId: u64, providerKeys: KeyringPair): Promise<[KeyringPair, u64]> {
  // Create a  delegator msa
  const [keys, delegatorMsaId] = await createDelegator();

  // Grant delegation to the provider
  const payload = await generateDelegationPayload({
    authorizedMsaId: providerId,
    schemaIds: [schemaId],
  });
  const addProviderData = ExtrinsicHelper.api.registry.createType('PalletMsaAddProvider', payload);

  const grantDelegationOp = ExtrinsicHelper.grantDelegation(keys, providerKeys, signPayloadSr25519(keys, addProviderData), payload);
  await grantDelegationOp.fundAndSend();

  return [keys, delegatorMsaId];
}

export async function getCurrentItemizedHash(msaId: MessageSourceId, schemaId: u16): Promise<PageHash> {
  const result = await ExtrinsicHelper.getItemizedStorage(msaId, schemaId);
  return result.content_hash;
}

export async function getCurrentPaginatedHash(msaId: MessageSourceId, schemaId: u16, pageId: number): Promise<u32> {
  const result = await ExtrinsicHelper.getPaginatedStorage(msaId, schemaId);
  const pageResponse = result.filter((page) => page.page_id.toNumber() === pageId);
  if (pageResponse.length <= 0) {
    return new u32(ExtrinsicHelper.api.registry, 0);
  }

  return pageResponse[0].content_hash;
}

export async function getHandleForMsa(msaId: MessageSourceId): Promise<Option<HandleResponse>> {
  const result = await ExtrinsicHelper.getHandleForMSA(msaId);
  return result;
}

// Creates an MSA and a provider for the given keys
// Returns the MSA Id of the provider
export async function createMsaAndProvider(keys: KeyringPair, providerName: string, amount = EXISTENTIAL_DEPOSIT): Promise<u64> {
  // Create and fund a keypair with stakeAmount
  // Use this keypair for stake operations
  const defaultFundingSource = getDefaultFundingSource();
  await fundKeypair(defaultFundingSource.keys, keys, amount);
  const createMsaOp = ExtrinsicHelper.createMsa(keys);
  const [MsaCreatedEvent] = await createMsaOp.fundAndSend();
  assert.notEqual(MsaCreatedEvent, undefined, 'createMsaAndProvider: should have returned MsaCreated event');

  const createProviderOp = ExtrinsicHelper.createProvider(keys, providerName);
  const [ProviderCreatedEvent] = await createProviderOp.fundAndSend();
  assert.notEqual(ProviderCreatedEvent, undefined, 'createMsaAndProvider: should have returned ProviderCreated event');

  if (ProviderCreatedEvent && ExtrinsicHelper.api.events.msa.ProviderCreated.is(ProviderCreatedEvent)) {
    return ProviderCreatedEvent.data.providerId;
  }
  return Promise.reject(new Error('createMsaAndProvider: ProviderCreatedEvent should be ExtrinsicHelper.api.events.msa.ProviderCreated'));
}

// Stakes the given amount of tokens from the given keys to the given provider
export async function stakeToProvider(keys: KeyringPair, providerId: u64, tokensToStake: bigint): Promise<void> {
  const stakeOp = ExtrinsicHelper.stake(keys, providerId, tokensToStake);
  await stakeOp.fundAndSend();
}

export async function getNextEpochBlock() {
  const epochInfo = await firstValueFrom(ExtrinsicHelper.api.query.capacity.currentEpochInfo());
  const actualEpochLength = await firstValueFrom(ExtrinsicHelper.api.query.capacity.epochLength());
  return actualEpochLength.toNumber() + epochInfo.epochStart.toNumber() + 1;
}

export async function setEpochLength(keys: KeyringPair, epochLength: number): Promise<void> {
  const setEpochLengthOp = ExtrinsicHelper.setEpochLength(keys, epochLength);
  await setEpochLengthOp.sudoSignAndSend();
}

export async function getOrCreateDummySchema(): Promise<u16> {
  if (process.env.CHAIN_ENVIRONMENT === CHAIN_ENVIRONMENT.ROCOCO_TESTNET) {
    const ROCOCO_DUMMY_SCHEMA_ID: u16 = new u16(ExtrinsicHelper.api.registry, 52);
    return ROCOCO_DUMMY_SCHEMA_ID;
  }
  const createDummySchema = ExtrinsicHelper.createSchema(devAccounts[0].keys, { type: 'record', name: 'Dummy on-chain schema', fields: [] }, 'AvroBinary', 'OnChain');
  const [dummySchemaEvent] = await createDummySchema.fundAndSend();
  if (dummySchemaEvent && createDummySchema.api.events.schemas.SchemaCreated.is(dummySchemaEvent)) {
    return dummySchemaEvent.data.schemaId;
  }
  return Promise.reject(new Error('failed to create a schema'));
}

export const TokenPerCapacity = 50n;

export async function getRemainingCapacity(providerId: u64): Promise<u128> {
  const capacityStaked = (await firstValueFrom(ExtrinsicHelper.api.query.capacity.capacityLedger(providerId))).unwrap();
  return capacityStaked.remainingCapacity;
}

export async function getNonce(keys: KeyringPair): Promise<number> {
  const nonce = await firstValueFrom(ExtrinsicHelper.api.call.accountNonceApi.accountNonce(keys.address));
  return nonce.toNumber();
}
