import { MessageSourceId, ProviderId } from '@frequency-chain/api-augment/interfaces';

// Note: DSNP IDs are u64 on Frequency, but since JS 'bigint' doesn't automatically
//       serialize to JSON, we use strings here.
export interface IGraphUpdateJob {
  dsnpId: string;
  providerId: string;
}

export function createGraphUpdateJob(dsnpId: MessageSourceId, providerId: ProviderId): { key: string; data: IGraphUpdateJob } {
  const dsnpStr = dsnpId.toString();
  const providerStr = providerId.toString();
  return {
    key: `${dsnpId}:${providerId}`,
    data: {
      dsnpId: dsnpStr,
      providerId: providerStr,
    },
  };
}
