import { BlockHash } from '@polkadot/types/interfaces';
import { RegistryError } from '@polkadot/types/types';

export interface IGraphNotifierResult {
  found: boolean;
  success: boolean;
  blockHash?: BlockHash;
  capacityWithdrawn?: bigint;
  capacityEpoch?: number;
  error?: RegistryError;
}
