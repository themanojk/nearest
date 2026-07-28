import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class RetentionPreferencesDto {
  @IsInt()
  @IsOptional()
  @Min(0)
  @Max(365)
  eventClipRetentionDays?: number;

  @IsInt()
  @IsOptional()
  @Min(0)
  @Max(365)
  rawAudioRetentionDays?: number;

  @IsInt()
  @IsOptional()
  @Min(0)
  @Max(365)
  transcriptRetentionDays?: number;
}
