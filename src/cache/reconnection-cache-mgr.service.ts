import { ITxStatus } from '#app/interfaces/tx-status.interface';
import { InjectRedis } from '@liaoliaots/nestjs-redis';
import { Injectable, Logger } from '@nestjs/common';
import { HexString } from '@polkadot/util/types';
import { Redis } from 'ioredis';

export type TxStatusObj = Record<HexString, ITxStatus>;

function makeJobKey(jobId: string): string {
  return jobId.startsWith('pending:') ? jobId : `pending:${jobId}`;
}

@Injectable()
export class ReconnectionCacheMgrService {
  private readonly logger: Logger;

  constructor(@InjectRedis() private readonly cacheMgr: Redis) {
    this.logger = new Logger(this.constructor.name);
  }

  public get redis(): Redis {
    return this.cacheMgr;
  }

  public async upsertWatchedTxns(txStatus: ITxStatus | ITxStatus[]): Promise<void> {
    let id: string = '';
    const obj = {};
    if (Array.isArray(txStatus)) {
      txStatus.forEach((tx) => {
        if (id && id !== tx.sourceJobId) {
          throw new Error('Mismatched job IDs in tx set');
        }
        obj[tx.txHash] = JSON.stringify(tx);
        id = tx.sourceJobId;
      });
    } else {
      obj[txStatus.txHash] = JSON.stringify(txStatus);
      id = txStatus.sourceJobId;
    }
    id = makeJobKey(id);
    await this.cacheMgr.hset(id, obj);
    console.log('Attempts: ', await this.cacheMgr.hget(id, 'attempts'));
  }

  public async getAllPendingJobs(): Promise<string[]> {
    return this.cacheMgr.keys('pending:*');
  }

  public async getAllPendingTxns(): Promise<TxStatusObj> {
    const hkeys = (await this.cacheMgr.keys('pending:*')).filter((key) => key !== 'attempts');
    const txObj: TxStatusObj = {};
    // eslint-disable-next-line no-restricted-syntax
    for (const k of hkeys) {
      // eslint-disable-next-line no-await-in-loop
      const objs = await this.cacheMgr.hvals(k);
      objs.forEach((obj) => {
        const tx = JSON.parse(obj) as unknown as ITxStatus;
        if (tx.status === 'pending') {
          txObj[tx.txHash] = tx;
        }
      });
    }

    return txObj;
  }

  public async getAllTxnsForJob(jobId: string): Promise<TxStatusObj> {
    const txObj: TxStatusObj = {};
    const rawTxns = await this.cacheMgr.hvals(makeJobKey(jobId));
    rawTxns.forEach((txn) => {
      const obj = JSON.parse(txn);
      if (obj?.sourceJobId) {
        txObj[obj.txHash] = obj;
      }
    });

    return txObj;
  }

  public async clearTxnsForJob(jobId: string): Promise<void> {
    let hkeys = await this.cacheMgr.hkeys(makeJobKey(jobId));
    hkeys = hkeys.filter((k) => k !== 'attempts');
    await this.cacheMgr.hdel(makeJobKey(jobId), ...hkeys);
    console.log('Attempts: ', await this.cacheMgr.hget(makeJobKey(jobId), 'attempts'));
  }

  public async removeJob(jobId: string): Promise<void> {
    console.log('Removing job from cache');
    const id = makeJobKey(jobId);
    const hfields = await this.cacheMgr.hkeys(id);
    await this.cacheMgr.hdel(id, ...hfields);
  }

  public async getJobAttempts(jobId: string): Promise<number> {
    const attempts = await this.cacheMgr.hget(makeJobKey(jobId), 'attempts');
    return JSON.parse(attempts ?? '0');
  }

  public async incrJobAttempts(jobId: string): Promise<number> {
    return this.cacheMgr.hincrby(makeJobKey(jobId), 'attempts', 1);
  }
}
