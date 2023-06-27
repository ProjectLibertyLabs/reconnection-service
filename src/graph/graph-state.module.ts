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
                // Replace with env needed for testing as default is mainnet
                // var env = { environmentType: EnvironmentType.Mainnet };
                createGraphStateManager();
            },
        },
    ],
    exports: [GraphStateManager],
})
export class GraphManagerModule {}
