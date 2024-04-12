import { HexString } from '@polkadot/util/types';

export interface ITxStatus {
  sourceJobId: string;
  txHash: HexString;
  birth: number;
  death: number;
  status: 'success' | 'failed' | 'expired' | 'pending';
  error?: string;
}
