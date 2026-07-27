import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { TranscriptionLanguageMode } from '../schemas/analysis-job.schema';

export class CreateAnalysisDto {
  @IsString()
  @Length(1, 128)
  childId!: string;

  @IsString()
  @Length(1, 255)
  fileName!: string;

  @IsString()
  @Matches(/^audio\/[a-z0-9.+-]+$/i, {
    message: 'contentType must be an audio media type',
  })
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sizeBytes!: number;

  @IsOptional()
  @IsEnum(TranscriptionLanguageMode)
  transcriptionLanguageMode?: TranscriptionLanguageMode =
    TranscriptionLanguageMode.Auto;
}
