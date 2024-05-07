/*
https://docs.nestjs.com/fundamentals/testing#unit-testing
*/

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BlockHash } from '@polkadot/types/interfaces';
import { BlockchainScannerService } from './blockchain-scanner.service';
import { BlockchainService } from './blockchain/blockchain.service';
import { ReconnectionCacheMgrService } from './cache/reconnection-cache-mgr.service';

const mockProcessBlock = jest.fn();

class ScannerService extends BlockchainScannerService {
  // eslint-disable-next-line
  protected processCurrentBlock(currentBlockHash: BlockHash, currentBlockNumber: number): Promise<void> {
    mockProcessBlock(currentBlockHash, currentBlockNumber);
    return Promise.resolve();
  }
}

const mockReconnectionCache = {
  provide: ReconnectionCacheMgrService,
  useValue: { redis: { get: jest.fn(), set: jest.fn() } },
};
const mockBlockchainService = {
  provide: BlockchainService,
  useValue: {
    getBlockHash: (blockNumber: number) =>
      blockNumber > 1
        ? {
            some: () => true,
            isEmpty: true,
          }
        : {
            some: () => true,
            isEmpty: false,
          },
  },
};

const setupService = async (): Promise<ScannerService> => {
  jest.resetModules();
  const moduleRef = await Test.createTestingModule({
    providers: [mockReconnectionCache, Logger, mockBlockchainService, ScannerService],
  }).compile();
  return moduleRef.get<ScannerService>(ScannerService);
};

describe('BlockchainScannerService', () => {
  let service: ScannerService;

  beforeEach(async () => {
    service = await setupService();
  });

  describe('#scan', () => {
    it('Should call processCurrentBlock', async () => {
      await service.scan();
      expect(mockProcessBlock).toHaveBeenCalledWith(expect.anything(), 1);
    });
  });
});
