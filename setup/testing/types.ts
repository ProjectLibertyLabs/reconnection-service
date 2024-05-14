import '@frequency-chain/api-augment';
import { MessageSourceId } from '@frequency-chain/api-augment/interfaces';
import { KeyringPair } from '@polkadot/keyring/types';
import { SubmittableExtrinsic } from '@polkadot/api-base/types';
import { ISubmittableResult } from '@polkadot/types/types';
import { ProviderGraph, GraphKeyPair as ProviderGraphKeyPair } from 'reconnection-service/src/interfaces/provider-graph.interface';
import { HexString } from '@polkadot/util/types';

export interface ChainUser {
  uri?: string;
  keys?: KeyringPair;
  msaId?: MessageSourceId;
  createdAtBlock?: number;
  create?: () => SubmittableExtrinsic<'promise', ISubmittableResult>;
  addGraphKey?: () => SubmittableExtrinsic<'promise', ISubmittableResult>;
  resetGraph?: (() => SubmittableExtrinsic<'promise', ISubmittableResult>)[];
}

export interface ProviderResponse {
  dsnpId: string;
  connections: {
    data: ProviderGraph[];
    pagination?: {
      pageNumber: number;
      pageSize: number;
      pageCount: number;
    };
  };
  graphKeyPairs: ProviderGraphKeyPair[];
}

export class PromiseTracker {
  resolve: () => void;
  reject: (reason?: any) => void;
  promise: Promise<void>;
  pendingTxnCount = 0;
  pendingExtrinsics = new Set<HexString>();

  constructor() {
    this.resetPromise();
  }

  resetPromise() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}
