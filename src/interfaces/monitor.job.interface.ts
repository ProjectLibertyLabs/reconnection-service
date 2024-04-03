import { BlockHash, Hash } from '@polkadot/types/interfaces';

export interface ITxMonitorJob {
  id: string;
  txHash: Hash;
  epoch: string;
  lastFinalizedBlockHash: BlockHash;
}
