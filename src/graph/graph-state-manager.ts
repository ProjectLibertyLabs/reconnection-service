import { Injectable } from '@nestjs/common';
import { Action, Graph, EnvironmentInterface, GraphKeyPair, GraphKeyType, ImportBundle, Update, Config, DevEnvironment, EnvironmentType, DsnpKeys, DsnpPublicKey, DsnpGraphEdge } from '@dsnp/graph-sdk';
import { ConfigService } from '../config/config.service';

@Injectable()
export class GraphStateManager {
  private graphState: Graph;

  private environment: EnvironmentInterface; // Environment details

  private capacity?: number; // Graph capacity

  private static graphStateFinalizer = new FinalizationRegistry((graphState: Graph) => {
    if (graphState) {
      graphState.freeGraphState();
    }
  });

  constructor(private configService: ConfigService) {
    const environmentType = configService.graph_environment_type();
    if (environmentType === EnvironmentType.Dev.toString()) {
      const config_json = configService.graph_environment_config();
      let config: Config = JSON.parse(config_json);
      const devEnvironment: DevEnvironment = { environmentType: EnvironmentType.Dev, config };
      this.environment = devEnvironment;
    } else {
      this.environment = { environmentType: EnvironmentType[environmentType as keyof typeof EnvironmentType] };
    }
    this.capacity = configService.graph_capacity() > 0? configService.graph_capacity(): undefined;
    this.graphState = new Graph(this.environment, this.capacity);

    GraphStateManager.graphStateFinalizer.register(this, this.graphState);
  }

  public async getGraphState(): Promise<Graph> {
    if (this.graphState) {
      return this.graphState;
    }
    return {} as Graph;
  }

  public async getGraphCapacity(): Promise<number> {
    return this.graphState.getGraphCapacity();
  }

  public async getGraphConfig(): Promise<Config> {
    if (this.graphState) {
      return this.graphState.getGraphConfig(this.environment);
    }
    return {} as Config;
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

  public async applyActions(actions: Action[]): Promise<boolean> {
    if (this.graphState) {
      return this.graphState.applyActions(actions);
    }
    return false;
  }

  public async exportGraphUpdates(): Promise<Update[]> {
    if (this.graphState) {
      return await this.graphState.exportUpdates();
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
