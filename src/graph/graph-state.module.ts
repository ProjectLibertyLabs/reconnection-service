import { Module } from '@nestjs/common';
import { GraphStateManager } from './graph-state-manager';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [ConfigModule],
  providers: [GraphStateManager],
  exports: [GraphStateManager],
})
export class GraphManagerModule {}
