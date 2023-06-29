require('dotenv').config({ path: '.env.test' });

import { Test, TestingModule } from '@nestjs/testing';
import { GraphStateManager } from './graph-state-manager';
import { Action, ConnectAction, Connection, DsnpKeys, EnvironmentType, GraphKeyPair, ImportBundle, PageData } from '@dsnp/graph-sdk';
import { ConfigService } from '../config/config.service';
import { configModuleOptions } from '../config/env.config';
import { ConfigModule } from '@nestjs/config';
import { GraphManagerModule } from './graph-state.module';

type ProcessEnv = {
  REDIS_URL: string;
  FREQUENCY_URL: string;
  PROVIDER_ID: string;
  PROVIDER_BASE_URL: string;
  PROVIDER_USER_GRAPH_ENDPOINT: string;
  PROVIDER_ACCESS_TOKEN: string;
  BLOCKCHAIN_SCAN_INTERVAL_MINUTES: string;
  QUEUE_HIGH_WATER: string;
  GRAPH_ENVIRONMENT_TYPE: string;
  GRAPH_ENVIRONMENT_CONFIG: string;
};

describe('GraphStateManager', () => {
  const REDIS_URL = 'redis://localhost:6389';
  const FREQUENCY_URL = 'ws://localhost:9933';
  const PROVIDER_ID = '1';
  const PROVIDER_BASE_URL = 'https://some-provider';
  const PROVIDER_USER_GRAPH_ENDPOINT = 'user-graph';
  const PROVIDER_ACCESS_TOKEN = 'some-token';
  const BLOCKCHAIN_SCAN_INTERVAL_MINUTES = '60';
  const QUEUE_HIGH_WATER = '1000';
  const GRAPH_ENVIRONMENT_TYPE = 'Mainnet';
  const GRAPH_ENVIRONMENT_CONFIG = '{}';

  const ALL_ENV = {
    REDIS_URL,
    FREQUENCY_URL,
    PROVIDER_ID,
    PROVIDER_BASE_URL,
    PROVIDER_USER_GRAPH_ENDPOINT,
    PROVIDER_ACCESS_TOKEN,
    BLOCKCHAIN_SCAN_INTERVAL_MINUTES,
    QUEUE_HIGH_WATER,
    GRAPH_ENVIRONMENT_TYPE,
    GRAPH_ENVIRONMENT_CONFIG,
  };
  let graphStateManager: GraphStateManager;
  
  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        GraphManagerModule,
        ConfigModule.forRoot({
          ...configModuleOptions,
          isGlobal: true,
        }),
      ],
      providers: [GraphStateManager, ConfigService],
    }).compile();
  
    graphStateManager = module.get<GraphStateManager>(GraphStateManager);
  });
  
  it('should be defined', () => {
    expect(graphStateManager).toBeDefined();
  });

  it('should return graph config', async () => {
    const graphConfig = await graphStateManager.getGraphConfig();
    expect(graphConfig).toBeDefined();
    expect(graphConfig.sdkMaxUsersGraphSize).toBeDefined();
    expect(graphConfig.sdkMaxUsersGraphSize).toBeGreaterThan(0);
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

    const exportUpdates = await graphStateManager.exportGraphUpdates();
    expect(exportUpdates).toBeDefined();
    expect(exportUpdates.length).toBe(0);
  });

  it('should apply actions and export graph updates', async () => {
    // Set up actions
    const actions = [] as Action[];
    const action_1 = {
        type: "Connect",
        ownerDsnpUserId: "1",
        connection: {
            dsnpUserId: "2",
            schemaId: 1,
        } as Connection,
        dsnpKeys: {
          dsnpUserId: "2",
          keysHash: 100,
          keys: [],
        } as DsnpKeys,
    } as ConnectAction;

    actions.push(action_1);

    let applyActionsResult = await graphStateManager.applyActions(actions);
    expect(applyActionsResult).toBe(true);

    const exportUpdates = await graphStateManager.exportGraphUpdates();
    expect(exportUpdates).toBeDefined();
    expect(exportUpdates.length).toBe(1);
  });
});
