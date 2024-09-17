import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Graph, EnvironmentInterface, GraphKeyPair, GraphKeyType, Config, EnvironmentType, DsnpKeys, DsnpPublicKey, ConnectionType, PrivacyType } from '@projectlibertylabs/graph-sdk';
import { ConfigService } from '../config/config.service';

@Injectable()
export class GraphStateManager implements OnApplicationBootstrap {
  private environment: EnvironmentInterface; // Environment details

  private schemaIds: Record<string, Record<string, number>>;

  private graphKeySchemaId: number;

  public onApplicationBootstrap() {
    const graphState = this.createGraphState();

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
    this.environment = { environmentType: EnvironmentType[environmentType] };
  }

  public createGraphState(): Graph {
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
}
