import dotenv from 'dotenv';
dotenv.config({ path: 'env.template', override: true });
import { describe, beforeAll, it, expect } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { Action, ConnectAction, Connection, ConnectionType, DsnpKeys, GraphKeyPair, GraphKeyType, ImportBundle, KeyData, PageData, PrivacyType } from '@projectlibertylabs/graph-sdk';
import { ConfigModule } from '@nestjs/config';
import { GraphStateManager } from './graph-state-manager';
import { ConfigService } from '../config/config.service';
import { GraphManagerModule } from './graph-state.module';

describe('GraphStateManager', () => {
  let graphStateManager: GraphStateManager;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        GraphManagerModule,
        ConfigModule.forRoot({
          isGlobal: true,
        }),
      ],
      providers: [GraphStateManager, ConfigService],
    }).compile();

    graphStateManager = module.get<GraphStateManager>(GraphStateManager);
    graphStateManager.onApplicationBootstrap();
  });

  it('should be defined', () => {
    expect(graphStateManager).toBeDefined();
    const graphState = graphStateManager.createGraphState();
    expect(graphState).toBeDefined();
    graphState.freeGraphState();
  });

  it('should return graph config', async () => {
    const graphState = graphStateManager.createGraphState();
    const graphConfig = graphStateManager.getGraphConfig(graphState);
    expect(graphConfig).toBeDefined();
    graphState.freeGraphState();
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

    const schemaId = graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Private);

    const importBundle1: ImportBundle = {
      dsnpUserId: dsnpUserId1.toString(),
      schemaId,
      keyPairs: keyPairs1,
      dsnpKeys: dsnpKeys1,
      pages: [pageData1],
    };

    const graphState = graphStateManager.createGraphState();
    const importResult1 = graphState.importUserData([importBundle1]);
    expect(importResult1).toBe(true);

    // if import is successful and not state is created, it should have a state
    const graphConfig = graphStateManager.getGraphConfig(graphState);

    expect(graphConfig).toBeDefined();
    expect(graphConfig.maxGraphPageSizeBytes).toBeDefined();

    const exportUpdates = graphState.exportUpdates();
    expect(exportUpdates).toBeDefined();
    expect(exportUpdates.length).toBe(0);
    graphState.freeGraphState();
  });

  it('should apply actions and export graph updates', async () => {
    const schemaId = graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Public);

    // Set up actions
    const actions: Action[] = [
      {
        type: 'Connect',
        ownerDsnpUserId: '10',
        connection: {
          dsnpUserId: '4',
          schemaId,
        } as Connection,
        dsnpKeys: {
          dsnpUserId: '4',
          keysHash: 100,
          keys: [],
        } as DsnpKeys,
      } as ConnectAction,
    ];

    const graphState = graphStateManager.createGraphState();
    const applyActionsResult = graphState.applyActions(actions, { ignoreExistingConnections: true });
    expect(applyActionsResult).toBe(true);

    const exportUpdates = graphState.exportUpdates();
    expect(exportUpdates).toBeDefined();
    expect(exportUpdates.length).toBe(1);
    graphState.freeGraphState();
  });

  it('getConnectionsWithoutKeys with empty connections should return empty array', async () => {
    const graphState = graphStateManager.createGraphState();
    const connections = graphState.getConnectionsWithoutKeys();
    expect(connections).toBeDefined();
    expect(connections.length).toBe(0);
  });

  it('getPublicKeys with empty connections should return empty array', async () => {
    const graphState = graphStateManager.createGraphState();
    const publicKeys = graphState.getPublicKeys('1');
    expect(publicKeys).toBeDefined();
    expect(publicKeys.length).toBe(0);
  });

  it('Read and deserialize published graph keys', async () => {
    const dsnpKeyOwner = 1000;

    // published keys blobs fetched from blockchain
    const publishedKeysBlob = [
      64, 15, 234, 44, 175, 171, 220, 131, 117, 43, 227, 111, 165, 52, 150, 64, 218, 44, 130, 138, 221, 10, 41, 13, 241, 60, 210, 216, 23, 62, 178, 73, 111,
    ];
    const dsnpKeys = {
      dsnpUserId: dsnpKeyOwner.toString(),
      keysHash: 100,
      keys: [
        {
          index: 0,
          content: new Uint8Array(publishedKeysBlob),
        },
      ] as KeyData[],
    } as DsnpKeys;

    const deserializedKeys = GraphStateManager.deserializeDsnpKeys(dsnpKeys);
    expect(deserializedKeys).toBeDefined();
  });

  it('generateKeyPair should return a key pair', async () => {
    const keyPair = GraphStateManager.generateKeyPair(GraphKeyType.X25519);
    expect(keyPair).toBeDefined();
    expect(keyPair.publicKey).toBeDefined();
    expect(keyPair.secretKey).toBeDefined();
  });

  it('should remove user graph', async () => {
    const graphState = graphStateManager.createGraphState();
    const removeUserGraphResult = graphState.removeUserGraph('1');
    expect(removeUserGraphResult).toBe(true);
  });

  it('should return false if graph does not contain user', async () => {
    const graphState = graphStateManager.createGraphState();
    const containsUserGraphResult = graphState.containsUserGraph('1');
    expect(containsUserGraphResult).toBe(false);
  });

  it('should return schema id for connection type and privacy type', async () => {
    const schemaId = graphStateManager.getSchemaIdFromConfig(ConnectionType.Follow, PrivacyType.Public);
    expect(schemaId).toBeGreaterThan(0);
  });
});
