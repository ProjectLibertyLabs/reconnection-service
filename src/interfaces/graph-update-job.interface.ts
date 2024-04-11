import { MessageSourceId, ProviderId } from '@frequency-chain/api-augment/interfaces';
import { AnyNumber } from '@polkadot/types/types';

export const UpdateTransitiveGraphs = true;
export const SkipTransitiveGraphs = false;

// eslint-disable-next-line no-shadow
export enum GraphUpdateJobState {
  Unprocessed,
  Submitted,
  FailedToAwaitMonitor,
  ChainFailureRetry,
  ChainFailureNoRetry,
  MonitorFailedNoRetry,
  MonitorSuccess,
}

// Note: DSNP IDs are u64 on Frequency, but since JS 'bigint' doesn't automatically
//       serialize to JSON, we use strings here.
export interface IGraphUpdateJob {
  dsnpId: string;
  providerId: string;
  processTransitiveUpdates: boolean;
  state: GraphUpdateJobState;

  // Use for internal development/testing, can queue a job
  // and have the processor complete, fail, retry, etc, based on the value
  debugDisposition?: string;
}

export function createGraphUpdateJob(
  dsnpIdValue: MessageSourceId | AnyNumber | string,
  providerIdValue: ProviderId | AnyNumber | string,
  processTransitiveUpdates: boolean,
  state?: GraphUpdateJobState,
  debugDisposition?: string,
): { key: string; data: IGraphUpdateJob } {
  let dsnpId: string;
  let providerId: string;
  if (typeof dsnpIdValue !== 'string') {
    dsnpId = dsnpIdValue.toString();
  } else {
    dsnpId = dsnpIdValue;
  }
  if (typeof providerIdValue !== 'string') {
    providerId = providerIdValue.toString();
  } else {
    providerId = providerIdValue;
  }

  return {
    key: `${dsnpId}:${providerId}:${processTransitiveUpdates}`,
    data: {
      dsnpId,
      providerId,
      processTransitiveUpdates,
      state: state ?? GraphUpdateJobState.Unprocessed,
      debugDisposition,
    },
  };
}
