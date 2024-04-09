import { HexString } from '@polkadot/util/types';

export interface ITxMonitorJob {
  id: string;
  txHashes: HexString[];
  lastFinalizedBlockHash: HexString;
}
