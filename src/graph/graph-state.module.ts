import { Logger, Module } from '@nestjs/common';
import { GraphStateManager } from './graph-state-manager';
import { createGraphStateManager } from './graph-state-manager.factory';
import { EnvironmentType, DevEnvironment, Config } from '@dsnp/graph-sdk';
import { ConfigService } from '../config/config.service';
import { ConfigModule } from '../config/config.module';

@Module({
    imports: [ConfigModule],
    providers: [
        {
            provide: GraphStateManager,
            useFactory: (configService: ConfigService) => {
                try {
                    let environmentType = configService.graph_environment_type();
                    if (environmentType === EnvironmentType.Dev.toString()) {
                        const config_json = configService.graph_environment_config();
                        let config: Config = JSON.parse(config_json);
                        const devEnvironment: DevEnvironment = { environmentType: EnvironmentType.Dev, config };
                        return createGraphStateManager(devEnvironment);
                    }
                    return createGraphStateManager({ environmentType: EnvironmentType[environmentType as keyof typeof EnvironmentType] });
                } catch (e) {
                    Logger.error(e);
                    return null;
                }
            },
            inject: [ConfigService], // Important! Inject ConfigService into the factory function
        },
    ],
    exports: [GraphStateManager],
})
export class GraphManagerModule {}
