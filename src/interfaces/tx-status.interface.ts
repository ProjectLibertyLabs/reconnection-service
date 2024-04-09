import { HexString } from '@polkadot/util/types';

export interface ITxStatus {
  sourceJobId: string;
  txHash: HexString;
  birth: number;
  death: number;
  status: 'success' | 'failed' | 'expired' | 'pending';
  error?: string;
}

export type TxHashMap = Record<HexString, ITxStatus>;

export type JobTxList = Record<string, HexString[]>;
