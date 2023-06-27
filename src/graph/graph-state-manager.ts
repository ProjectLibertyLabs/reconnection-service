import { Injectable } from '@nestjs/common';
import { Action, Graph, EnvironmentInterface, GraphKeyPair, GraphKeyType, ImportBundle, Update } from '@dsnp/graph-sdk';

@Injectable()
export class GraphStateManager {
  private graphStates: Map<number, Graph>; // Map to store multiple graph states

  private userToStatesMap: Map<string, number[]>; // Map to store user to state mapping

  private currentStateId: number; // Current state ID

  private environment: EnvironmentInterface; // Environment details

  private capacity?: number; // Graph capacity

  constructor(environment: EnvironmentInterface, capacity?: number) {
    this.graphStates = new Map<number, Graph>();
    this.currentStateId = 1; // Initial state ID
    this.environment = environment;
    this.capacity = capacity;
  }

  private generateStateId(): number {
    const stateId = this.currentStateId;
    this.currentStateId += 1;
    return stateId;
  }

  private async createGraphState(dsnpUserId: string): Promise<Graph> {
    const graph = new Graph(this.environment, this.capacity);
    const stateId = this.generateStateId();
    this.graphStates.set(stateId, graph);
    const stateIds = this.userToStatesMap.get(dsnpUserId) ?? [];
    this.userToStatesMap.set(dsnpUserId, [...stateIds, stateId]);
    return graph;
  }

  private async isGraphStateFull(stateId: number): Promise<boolean> {
    const graph = this.graphStates.get(stateId);
    if (graph) {
      const graphCapacity = await graph.getGraphCapacity();
      const graphStatesCount = await graph.getGraphUsersCount();
      return graphCapacity === graphStatesCount;
    }
    return false;
  }

  public async getTotalStatesCount(): Promise<number> {
    return this.graphStates.size;
  }

  public static async generateKeyPair(keyType: GraphKeyType): Promise<GraphKeyPair> {
    return Graph.generateKeyPair(keyType);
  }

  public async getAllStatesForUser(dsnpUserId: string): Promise<number[] | undefined> {
    return this.userToStatesMap.get(dsnpUserId);
  }

  public async importUserData(dsnpUserId: string, payload: ImportBundle[]): Promise<boolean> {
    let stateIds = this.userToStatesMap.get(dsnpUserId) ?? [];
    var currentGraph : Graph | undefined;

    if (stateIds.length === 0 || (await this.isGraphStateFull(stateIds[stateIds.length - 1]))) {
      currentGraph = await this.createGraphState(dsnpUserId);
    } else {
      currentGraph = this.graphStates.get(stateIds[stateIds.length - 1]);
    }

    if (currentGraph) {
      return currentGraph.importUserData(payload);
    }
    return false;
  }

  public async applyActions(dsnpUserId: string, actions: Action[]): Promise<boolean> {
    const stateIds = this.userToStatesMap.get(dsnpUserId);
    if (stateIds) {
      const lastStateId = stateIds[stateIds.length - 1];
      const graph = this.graphStates.get(lastStateId);
      if (graph) {
        return graph.applyActions(actions);
      }
    }
    return false;
  }

  public async exportGraphUpdates(dsnpUserId: string): Promise<Update[] | undefined> {
    const stateIds = this.userToStatesMap.get(dsnpUserId);
    if (stateIds) {
      const lastStateId = stateIds[stateIds.length - 1];
      const graph = this.graphStates.get(lastStateId);
      if (graph) {
        return graph.exportUpdates();
      }
    }
    return undefined;
  }

  public removeGraphState(stateId: number): void {
    this.graphStates.get(stateId)?.freeGraphState();
    this.graphStates.delete(stateId);
  }

  public async clearAllGraphStates(): Promise<void> {
    this.graphStates.forEach((graph) => {
      graph.freeGraphState();
    });
    this.graphStates.clear();
  }
}
