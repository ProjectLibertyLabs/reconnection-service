export interface ProviderGraph {
    dsnpId: string;
    privacyType: string;
    direction: string;
    connectionType: string;
}

export enum KeyType {
    X25519 = 'X25519',
}
export interface GraphKeyPair {
    publicKey: string;
    privateKey: string;
    keyType: KeyType;
}
