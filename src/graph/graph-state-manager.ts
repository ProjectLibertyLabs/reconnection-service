import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
  Action,
  Graph,
  EnvironmentInterface,
  GraphKeyPair,
  GraphKeyType,
  ImportBundle,
  Update,
  Config,
  DevEnvironment,
  EnvironmentType,
  DsnpKeys,
  DsnpPublicKey,
  DsnpGraphEdge,
  ConnectionType,
  PrivacyType,
} from '@dsnp/graph-sdk';
import { ConfigService } from '../config/config.service';

@Injectable()
export class GraphStateManager implements OnApplicationBootstrap {
  private graphState: Graph;

  private environment: EnvironmentInterface; // Environment details

  private schemaIds: { [key: string]: { [key: string]: number } };

  private graphKeySchemaId: number;

  private static graphStateFinalizer = new FinalizationRegistry((graphState: Graph) => {
    if (graphState) {
      graphState.freeGraphState();
    }
  });

  public async onApplicationBootstrap() {
    if (!this.graphState) {
      throw new Error('Unable to initialize schema ids');
    }

    const publicFollow = this.graphState.getSchemaIdFromConfig(this.environment, ConnectionType.Follow, PrivacyType.Public);
    const privateFollow = this.graphState.getSchemaIdFromConfig(this.environment, ConnectionType.Follow, PrivacyType.Private);
    const privateFriend = this.graphState.getSchemaIdFromConfig(this.environment, ConnectionType.Friendship, PrivacyType.Private);

    this.graphKeySchemaId = this.graphState.getGraphConfig(this.environment).graphPublicKeySchemaId;

    this.schemaIds = {
      [ConnectionType.Follow]: {
        [PrivacyType.Public]: publicFollow,
        [PrivacyType.Private]: privateFollow,
      },
      [ConnectionType.Friendship]: {
        [PrivacyType.Private]: privateFriend,
      },
    };
  }

  constructor(configService: ConfigService) {
    const environmentType = configService.getGraphEnvironmentType();
    if (environmentType === EnvironmentType.Dev.toString()) {
      const configJson = configService.getGraphEnvironmentConfig();
      const config: Config = JSON.parse(configJson);
      const devEnvironment: DevEnvironment = { environmentType: EnvironmentType.Dev, config };
      this.environment = devEnvironment;
    } else {
      this.environment = { environmentType: EnvironmentType[environmentType] };
    }
    this.graphState = new Graph(this.environment);

    GraphStateManager.graphStateFinalizer.register(this, this.graphState);
  }

  public async getGraphState(): Promise<Graph> {
    if (this.graphState) {
      return this.graphState;
    }
    return {} as Graph;
  }

  public async getGraphConfig(): Promise<Config> {
    if (this.graphState) {
      return this.graphState.getGraphConfig(this.environment);
    }
    return {} as Config;
  }

  public getSchemaIdFromConfig(connectionType: ConnectionType, privacyType: PrivacyType): number {
    return this.schemaIds[connectionType][privacyType] ?? 0;
  }

  public getGraphKeySchemaId(): number {
    return this.graphKeySchemaId;
  }

  public static async generateKeyPair(keyType: GraphKeyType): Promise<GraphKeyPair> {
    return Graph.generateKeyPair(keyType);
  }

  public static async deserializeDsnpKeys(keys: DsnpKeys): Promise<DsnpPublicKey[]> {
    return Graph.deserializeDsnpKeys(keys);
  }

  public async importUserData(payload: ImportBundle[]): Promise<boolean> {
    if (this.graphState) {
      return this.graphState.importUserData(payload);
    }
    return false;
  }

  public async applyActions(actions: Action[], ignoreExistingConnection: boolean): Promise<boolean> {
    if (this.graphState) {
      return this.graphState.applyActions(actions, { ignoreExistingConnections: ignoreExistingConnection });
    }
    return false;
  }

  public async exportGraphUpdates(): Promise<Update[]> {
    if (this.graphState) {
      return this.graphState.exportUpdates();
    }
    return [];
  }

  public async removeUserGraph(dsnpUserId: string): Promise<boolean> {
    if (this.graphState) {
      return this.graphState.removeUserGraph(dsnpUserId);
    }
    return false;
  }

  public async graphContainsUser(dsnpUserId: string): Promise<boolean> {
    if (this.graphState) {
      return this.graphState.containsUserGraph(dsnpUserId);
    }
    return false;
  }

  public async getConnectionsForUserGraph(dsnpUserId: string, schemaId: number, includePending: boolean): Promise<DsnpGraphEdge[]> {
    if (this.graphState) {
      return this.graphState.getConnectionsForUserGraph(dsnpUserId, schemaId, includePending);
    }
    return [];
  }

  public async getConnectionWithoutKeys(): Promise<string[]> {
    if (this.graphState) {
      return this.graphState.getConnectionsWithoutKeys();
    }
    return [];
  }

  public async getOneSidedPrivateFriendshipConnections(dsnpUserId: string): Promise<DsnpGraphEdge[]> {
    if (this.graphState) {
      return this.graphState.getOneSidedPrivateFriendshipConnections(dsnpUserId);
    }
    return [];
  }

  public async getPublicKeys(dsnpUserId: string): Promise<DsnpPublicKey[]> {
    if (this.graphState) {
      return this.graphState.getPublicKeys(dsnpUserId);
    }
    return [];
  }

  public async forceCalculateGraphs(dsnpUserId: string): Promise<Update[]> {
    if (this.graphState) {
      return this.graphState.forceCalculateGraphs(dsnpUserId);
    }
    return [];
  }
}
