import { IsNumberString, IsOptional } from 'class-validator';
import { IGraphUpdateJob, createGraphUpdateJob } from './graph-update-job.interface';

export class GraphUpdateJobDto implements IGraphUpdateJob {
  @IsNumberString({
    no_symbols: true,
  })
  public dsnpId: string;

  @IsNumberString({ no_symbols: true })
  public providerId: string;

  @IsOptional()
  public debugDisposition?: string | undefined;

  public get key(): string {
    return `${this.dsnpId}:${this.providerId}`;
  }

  public toGraphUpdateJob(): { key: string; data: IGraphUpdateJob } {
    return createGraphUpdateJob(this.dsnpId, this.providerId, this.debugDisposition);
  }
}
