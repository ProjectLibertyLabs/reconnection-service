import { Graph, EnvironmentInterface, Action, Update, DsnpGraphEdge } from "@dsnp/graph-sdk";

class GraphStateManager {
  private graphStates: Map<number, Graph>; // Map to store multiple graph states

  constructor() {
    this.graphStates = new Map<number, Graph>();
  }

  public async createGraphState(environment: EnvironmentInterface, capacity?: number): Promise<Graph> {
    const graph = new Graph(environment, capacity);
    const stateId = graph.getGraphHandle();
    this.graphStates.set(stateId, graph);
    return graph;
  }

  public getGraphState(stateId: number): Graph | undefined {
    return this.graphStates.get(stateId);
  }

  public removeGraphState(stateId: number): void {
    this.graphStates.delete(stateId);
  }
}

export const graphStateManager = new GraphStateManager();