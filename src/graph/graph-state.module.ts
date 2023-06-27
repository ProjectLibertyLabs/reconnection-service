import { Module } from '@nestjs/common';
import { GraphStateManager } from './graph-state-manager';
import { createGraphStateManager } from './graph-state-manager.factory';
import { EnvironmentType } from '@dsnp/graph-sdk';

@Module({
    imports: [],
    providers: [
        {
            provide: GraphStateManager,
            useFactory: () => {
                const environmentConfig = {
                    environmentType: EnvironmentType.Mainnet // Or any other environment
                };
                return createGraphStateManager(environmentConfig);
            },
        },
    ],
    exports: [GraphStateManager],
})
export class GraphManagerModule {}
