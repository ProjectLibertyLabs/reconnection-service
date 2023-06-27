import { Module } from '@nestjs/common';
import { GraphStateManager } from './graph-state-manager';
import { createGraphStateManager } from './graph-state-manager.factory';

@Module({
    imports: [],
    providers: [
        {
            provide: GraphStateManager,
            useFactory: createGraphStateManager,
        },
    ],
    exports: [GraphStateManager],
})
export class GraphManagerModule {}
