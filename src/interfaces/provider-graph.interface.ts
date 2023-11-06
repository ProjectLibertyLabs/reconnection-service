export interface ProviderGraph {
  dsnpId: string;
  privacyType: string;
  direction: 'connectionTo' | 'connectionFrom' | 'bidirectional';
  connectionType: string;
}

// eslint-disable-next-line no-shadow
export enum KeyType {
  X25519 = 'X25519',
}
export interface GraphKeyPair {
  publicKey: string;
  privateKey: string;
  keyType: KeyType;
}
