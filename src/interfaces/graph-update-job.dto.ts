import { IsBoolean, IsNumberString, IsOptional } from 'class-validator';
import { GraphUpdateJobState, IGraphUpdateJob, createGraphUpdateJob } from './graph-update-job.interface';

export class GraphUpdateJobDto implements IGraphUpdateJob {
  @IsNumberString({
    no_symbols: true,
  })
  public dsnpId: string;

  @IsNumberString({ no_symbols: true })
  public providerId: string;

  @IsBoolean()
  public processTransitiveUpdates: boolean;

  public state: GraphUpdateJobState;

  @IsOptional()
  public debugDisposition?: string | undefined;

  public get key(): string {
    return `${this.dsnpId}:${this.providerId}`;
  }

  public toGraphUpdateJob(): { key: string; data: IGraphUpdateJob } {
    return createGraphUpdateJob(this.dsnpId, this.providerId, this.processTransitiveUpdates, this.state, this.debugDisposition);
  }
}
