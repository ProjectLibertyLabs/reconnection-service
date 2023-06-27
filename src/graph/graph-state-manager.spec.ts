import { Test, TestingModule } from '@nestjs/testing';
import { GraphStateManager } from './graph-state-manager';
import { GraphManagerModule } from './graph-state.module';

describe('GraphStateManager', () => {
  let graphStateManager: GraphStateManager;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [GraphManagerModule],
    }).compile();

    graphStateManager = module.get<GraphStateManager>(GraphStateManager);
  });

  it('should be defined', () => {
    expect(graphStateManager).toBeDefined();
  });
});
