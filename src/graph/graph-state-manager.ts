import { Injectable } from '@nestjs/common';
import { Action, Graph, EnvironmentInterface, GraphKeyPair, GraphKeyType, ImportBundle, Update, Config } from '@dsnp/graph-sdk';

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

  constructor(environment: EnvironmentInterface, capacity?: number) {
    this.environment = environment;
    this.capacity = capacity;
    this.graphState = new Graph(this.environment, this.capacity);

    GraphStateManager.graphStateFinalizer.register(this, this.graphState);
  }

  private async isGraphStateFull(stateId: number): Promise<boolean> {
    if (this.graphState) {
      const graphCapacity = await this.graphState.getGraphCapacity();
      const graphStatesCount = await this.graphState.getGraphUsersCount();
      return graphCapacity === graphStatesCount;
    }
    return false;
  }

  public async getGraphConfig(stateId?: number): Promise<Config> {
    if (this.graphState) {
      return this.graphState.getGraphConfig(this.environment);
    }
    return {} as Config;
  }

  public static async generateKeyPair(keyType: GraphKeyType): Promise<GraphKeyPair> {
    return Graph.generateKeyPair(keyType);
  }


  public async importUserData(dsnpUserId: string, payload: ImportBundle[]): Promise<boolean> {
    if (this.graphState) {
      return this.graphState.importUserData(payload);
    }
    return false;
  }

  public async applyActions(dsnpUserId: string, actions: Action[]): Promise<boolean> {
    if (this.graphState) {
      return this.graphState.applyActions(actions);
    }
    return false;
  }

  public async exportGraphUpdates(dsnpUserId: string): Promise<Update[]> {
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
}
