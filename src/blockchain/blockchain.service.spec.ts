import { describe, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { ConfigService as NestConfigService } from '@nestjs/config';
import { ReconnectionCacheMgrService } from '../cache/reconnection-cache-mgr.service';
import { ICapacityLimit } from '../interfaces/capacity-limit.interface';
import { ConfigService } from '../config/config.service';
import { BlockchainService } from './blockchain.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';

const mockReconnectionCache = {
  provide: ReconnectionCacheMgrService,
  useValue: { redis: { get: jest.fn(), set: jest.fn() } },
};

const capacityInfo = {
  totalCapacityIssued: 10000000000n,
};

const servicePercentageLimit: ICapacityLimit = {
  type: 'percentage',
  value: 30n,
};

const serviceAmountLimit: ICapacityLimit = {
  type: 'amount',
  value: 3000000000n,
};

const totalPercentageLimit: ICapacityLimit = {
  type: 'percentage',
  value: 90n,
};

const totalAmountLimit: ICapacityLimit = {
  type: 'amount',
  value: 9000000000n,
};

describe('BlockchainScannerService', () => {
  let service: BlockchainService;
  let configService: ConfigService;
  let eventEmitter: EventEmitter2;
  let cacheService: ReconnectionCacheMgrService;
  let logger: Logger;

  let emitterSpy: any;
  let warnSpy: any;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [NestConfigService, EventEmitter2, ConfigService, BlockchainService, mockReconnectionCache],
    }).compile();

    service = moduleRef.get<BlockchainService>(BlockchainService);
    logger = (service as unknown as any).logger;
    configService = moduleRef.get<ConfigService>(ConfigService);
    eventEmitter = moduleRef.get<EventEmitter2>(EventEmitter2);
    cacheService = moduleRef.get<ReconnectionCacheMgrService>(ReconnectionCacheMgrService);

    emitterSpy = jest.spyOn(eventEmitter, 'emitAsync');
    warnSpy = jest.spyOn(logger, 'warn');
  });

  describe('capacity tests', () => {
    afterEach(() => {
      jest.clearAllMocks();
    });

    it('capacity under all limits emits refilled event', async () => {
      jest.spyOn(service, 'capacityInfo').mockResolvedValueOnce({ ...capacityInfo, remainingCapacity: capacityInfo.totalCapacityIssued } as any);
      jest.spyOn(configService, 'getCapacityLimit').mockReturnValueOnce({ serviceLimit: servicePercentageLimit });
      jest.spyOn(cacheService.redis, 'get').mockResolvedValueOnce('0');

      await service.checkCapacity();
      expect(emitterSpy).toHaveBeenLastCalledWith('capacity.refilled');
    });

    it('exceeding service percentage limit emits exhausted event', async () => {
      jest
        .spyOn(service, 'capacityInfo')
        .mockResolvedValueOnce({ ...capacityInfo, remainingCapacity: (capacityInfo.totalCapacityIssued * servicePercentageLimit.value) / 100n } as any);
      jest.spyOn(configService, 'getCapacityLimit').mockReturnValueOnce({ serviceLimit: servicePercentageLimit });
      jest.spyOn(cacheService.redis, 'get').mockResolvedValueOnce(((capacityInfo.totalCapacityIssued * servicePercentageLimit.value) / 100n).toString());
      await service.checkCapacity();
      expect(emitterSpy).toHaveBeenCalledWith('capacity.exhausted');
      expect(warnSpy).toHaveBeenLastCalledWith(expect.stringMatching(/^Capacity threshold reached.*/));
    });

    it('exceeding service amount limit emits exhausted event', async () => {
      jest.spyOn(service, 'capacityInfo').mockResolvedValueOnce({ ...capacityInfo, remainingCapacity: serviceAmountLimit.value } as any);
      jest.spyOn(configService, 'getCapacityLimit').mockReturnValueOnce({ serviceLimit: serviceAmountLimit });
      jest.spyOn(cacheService.redis, 'get').mockResolvedValueOnce(serviceAmountLimit.value.toString());
      await service.checkCapacity();
      expect(emitterSpy).toHaveBeenCalledWith('capacity.exhausted');
      expect(warnSpy).toHaveBeenLastCalledWith(expect.stringMatching(/^Capacity threshold reached.*/));
    });

    it('exceeding total percentage limit emits exhausted event', async () => {
      jest.spyOn(service, 'capacityInfo').mockResolvedValueOnce({
        ...capacityInfo,
        remainingCapacity: capacityInfo.totalCapacityIssued - (capacityInfo.totalCapacityIssued * totalPercentageLimit.value) / 100n,
      } as any);
      jest.spyOn(configService, 'getCapacityLimit').mockReturnValueOnce({ serviceLimit: servicePercentageLimit, totalLimit: totalPercentageLimit });
      jest.spyOn(cacheService.redis, 'get').mockResolvedValueOnce('0');
      await service.checkCapacity();
      expect(emitterSpy).toHaveBeenCalledWith('capacity.exhausted');
      expect(warnSpy).toHaveBeenLastCalledWith(expect.stringMatching(/^Total capacity usage limit reached/));
    });

    it('exceeding total amount limit emits exhausted event', async () => {
      jest.spyOn(service, 'capacityInfo').mockResolvedValueOnce({ ...capacityInfo, remainingCapacity: capacityInfo.totalCapacityIssued - totalAmountLimit.value } as any);
      jest.spyOn(configService, 'getCapacityLimit').mockReturnValueOnce({ serviceLimit: serviceAmountLimit, totalLimit: totalAmountLimit });
      jest.spyOn(cacheService.redis, 'get').mockResolvedValueOnce('0');
      await service.checkCapacity();
      expect(emitterSpy).toHaveBeenCalledWith('capacity.exhausted');
      expect(warnSpy).toHaveBeenLastCalledWith(expect.stringMatching(/^Total capacity usage limit reached/));
    });
  });
});
