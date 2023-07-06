export interface ProviderGraph {
    dsnpId: string;
    privacyType: string;
    direction: string;
    connectionType: string;
}

export interface GraphKeyPair {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
}
