import { EnvironmentInterface, EnvironmentType } from '@dsnp/graph-sdk';
import { GraphStateManager } from './graph-state-manager';

export function createGraphStateManager(env?: EnvironmentInterface): GraphStateManager {
    if (!env) {
        env  = {environmentType: EnvironmentType.Mainnet};
    }
    return new GraphStateManager(env);
}
