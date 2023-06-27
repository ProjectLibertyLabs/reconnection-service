import { Test, TestingModule } from '@nestjs/testing';
import { GraphStateManager } from './graph-state-manager';
import { GraphManagerModule } from './graph-state.module';
import { DsnpKeys, GraphKeyPair, ImportBundle, PageData } from '@dsnp/graph-sdk';

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

  it('should initialize state and import bundle upon request', async () => {
    // Set up import data
    const dsnpUserId1 = 1;
    const dsnpUserId2 = 2;

    const pageData1: PageData = {
      pageId: 1,
      content: new Uint8Array([24, 227, 96, 97, 96, 99, 224, 96, 224, 98, 96, 0, 0]),
      contentHash: 100,
    };

    const keyPairs1: GraphKeyPair[] = [];
    const keyPairs2: GraphKeyPair[] = [];

    const dsnpKeys1: DsnpKeys = {
      dsnpUserId: dsnpUserId1.toString(),
      keysHash: 100,
      keys: [],
    };

    const dsnpKeys2: DsnpKeys = {
      dsnpUserId: dsnpUserId2.toString(),
      keysHash: 100,
      keys: [],
    };

    const importBundle1: ImportBundle = {
      dsnpUserId: dsnpUserId1.toString(),
      schemaId: 1,
      keyPairs: keyPairs1,
      dsnpKeys: dsnpKeys1,
      pages: [pageData1],
    };

    const import_result1 = await graphStateManager.importUserData(dsnpUserId1.toString(), [importBundle1]);
    expect(import_result1).toBe(true);

    // if import is successful and not state is created, it should have a state
    const graphConfig = await graphStateManager.getGraphConfig();

    expect(graphConfig).toBeDefined();
    expect(graphConfig.maxGraphPageSizeBytes).toBeDefined();
  });

  it('should return graph config', async () => {
    const config = await graphStateManager.getGraphConfig();
    expect(config).toBeDefined();
    expect(config.maxGraphPageSizeBytes).toBeDefined();
    expect(config.maxGraphPageSizeBytes).toBeGreaterThan(0);
  });

});
