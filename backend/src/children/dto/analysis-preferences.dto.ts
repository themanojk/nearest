import { IsBoolean, IsOptional } from 'class-validator';

export class AnalysisPreferencesDto {
  @IsBoolean()
  @IsOptional()
  bullyingDetection?: boolean;

  @IsBoolean()
  @IsOptional()
  childSpeakerIdentification?: boolean;

  @IsBoolean()
  @IsOptional()
  conversationAnalysis?: boolean;

  @IsBoolean()
  @IsOptional()
  dangerDetection?: boolean;

  @IsBoolean()
  @IsOptional()
  environmentDetection?: boolean;

  @IsBoolean()
  @IsOptional()
  healthSignalDetection?: boolean;

  @IsBoolean()
  @IsOptional()
  profanityDetection?: boolean;
}
