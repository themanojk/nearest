import { IsBoolean, IsOptional } from 'class-validator';

export class StartRiskAggregationDto {
  @IsOptional()
  @IsBoolean()
  force = false;
}
