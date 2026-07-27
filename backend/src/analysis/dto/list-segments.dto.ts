import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ScanSegmentType } from '../schemas/scan-segment.schema';

export class ListSegmentsDto {
  @IsOptional()
  @IsEnum(ScanSegmentType)
  type?: ScanSegmentType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;
}
