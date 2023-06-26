import {
  Graph,
  EnvironmentInterface,
  GraphKeyPair,
  GraphKeyType,
  ImportBundle,
} from '@dsnp/graph-sdk';

export class GraphStateManager {
  private graphStates: Map<number, Graph>; // Map to store multiple graph states

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

  public async createGraphState(): Promise<Graph> {
    const graph = new Graph(this.environment, this.capacity);
    const stateId = this.generateStateId();
    this.graphStates.set(stateId, graph);
    return graph;
  }

  public async isGraphStateFull(stateId: number): Promise<boolean> {
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

  public static async generateKeyPair(
    keyType: GraphKeyType,
  ): Promise<GraphKeyPair> {
    return Graph.generateKeyPair(keyType);
  }

  public async ImportUserData(
    payload: ImportBundle[],
  ): Promise<boolean> {
    // TODO: Implement this method
    return false;
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
