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
  private environment: EnvironmentInterface; // Environment details

  private schemaIds: { [key: string]: { [key: string]: number } };

  private graphKeySchemaId: number;

  public onApplicationBootstrap() {
    const graphState = this.getGraphState();

    const publicFollow = graphState.getSchemaIdFromConfig(this.environment, ConnectionType.Follow, PrivacyType.Public);
    const privateFollow = graphState.getSchemaIdFromConfig(this.environment, ConnectionType.Follow, PrivacyType.Private);
    const privateFriend = graphState.getSchemaIdFromConfig(this.environment, ConnectionType.Friendship, PrivacyType.Private);

    this.graphKeySchemaId = graphState.getGraphConfig(this.environment).graphPublicKeySchemaId;

    this.schemaIds = {
      [ConnectionType.Follow]: {
        [PrivacyType.Public]: publicFollow,
        [PrivacyType.Private]: privateFollow,
      },
      [ConnectionType.Friendship]: {
        [PrivacyType.Private]: privateFriend,
      },
    };
    graphState.freeGraphState();
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
  }

  public getGraphState(): Graph {
    return new Graph(this.environment);
  }

  public getGraphConfig(graphState: Graph): Config {
    if (graphState) {
      return graphState.getGraphConfig(this.environment);
    }
    return {} as Config;
  }

  public getSchemaIdFromConfig(connectionType: ConnectionType, privacyType: PrivacyType): number {
    return this.schemaIds[connectionType][privacyType] ?? 0;
  }

  public getGraphKeySchemaId(): number {
    return this.graphKeySchemaId;
  }

  public static generateKeyPair(keyType: GraphKeyType): GraphKeyPair {
    return Graph.generateKeyPair(keyType);
  }

  public static deserializeDsnpKeys(keys: DsnpKeys): DsnpPublicKey[] {
    return Graph.deserializeDsnpKeys(keys);
  }

  // eslint-disable-next-line class-methods-use-this
  public importUserData(graphState: Graph, payload: ImportBundle[]): boolean {
    if (graphState) {
      return graphState.importUserData(payload);
    }
    return false;
  }

  // eslint-disable-next-line class-methods-use-this
  public applyActions(graphState: Graph, actions: Action[], ignoreExistingConnection: boolean): boolean {
    if (graphState) {
      return graphState.applyActions(actions, { ignoreExistingConnections: ignoreExistingConnection });
    }
    return false;
  }

  // eslint-disable-next-line class-methods-use-this
  public exportGraphUpdates(graphState: Graph): Update[] {
    if (graphState) {
      return graphState.exportUpdates();
    }
    return [];
  }

  // eslint-disable-next-line class-methods-use-this
  public exportUserGraphUpdates(graphState: Graph, dsnpId: string): Update[] {
    if (graphState) {
      return graphState.exportUserGraphUpdates(dsnpId);
    }

    return [];
  }

  // eslint-disable-next-line class-methods-use-this
  public removeUserGraph(graphState: Graph, dsnpUserId: string): boolean {
    if (graphState) {
      return graphState.removeUserGraph(dsnpUserId);
    }
    return false;
  }

  // eslint-disable-next-line class-methods-use-this
  public graphContainsUser(graphState: Graph, dsnpUserId: string): boolean {
    if (graphState) {
      return graphState.containsUserGraph(dsnpUserId);
    }
    return false;
  }

  // eslint-disable-next-line class-methods-use-this
  public getConnectionsForUserGraph(graphState: Graph, dsnpUserId: string, schemaId: number, includePending: boolean): DsnpGraphEdge[] {
    if (graphState) {
      return graphState.getConnectionsForUserGraph(dsnpUserId, schemaId, includePending);
    }
    return [];
  }

  // eslint-disable-next-line class-methods-use-this
  public getConnectionWithoutKeys(graphState: Graph): string[] {
    if (graphState) {
      return graphState.getConnectionsWithoutKeys();
    }
    return [];
  }

  // eslint-disable-next-line class-methods-use-this
  public getOneSidedPrivateFriendshipConnections(graphState: Graph, dsnpUserId: string): DsnpGraphEdge[] {
    if (graphState) {
      return graphState.getOneSidedPrivateFriendshipConnections(dsnpUserId);
    }
    return [];
  }

  // eslint-disable-next-line class-methods-use-this
  public getPublicKeys(graphState: Graph, dsnpUserId: string): DsnpPublicKey[] {
    if (graphState) {
      return graphState.getPublicKeys(dsnpUserId);
    }
    return [];
  }

  // eslint-disable-next-line class-methods-use-this
  public forceCalculateGraphs(graphState: Graph, dsnpUserId: string): Update[] {
    if (graphState) {
      return graphState.forceCalculateGraphs(dsnpUserId);
    }
    return [];
  }

  // eslint-disable-next-line class-methods-use-this
  public freeGraphState(graphState: Graph): void {
    if (graphState) {
      graphState.freeGraphState();
    }
  }
}
