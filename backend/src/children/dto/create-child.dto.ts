import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { ChildAgeGroup } from '../schemas/child-profile.schema';
import { AnalysisPreferencesDto } from './analysis-preferences.dto';
import { RetentionPreferencesDto } from './retention-preferences.dto';

export class CreateChildDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  nickname?: string;

  @IsOptional()
  @IsUrl({
    protocols: ['https'],
    require_protocol: true,
  })
  profileImageUrl?: string;

  @IsEnum(ChildAgeGroup)
  ageGroup!: ChildAgeGroup;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Matches(/^[a-z]{2,3}(?:-[A-Z]{2})?$/, {
    each: true,
    message: 'each language must be a BCP 47 language tag such as en or en-IN',
  })
  languages!: string[];

  @Type(() => AnalysisPreferencesDto)
  @IsDefined()
  @ValidateNested()
  analysisPreferences!: AnalysisPreferencesDto;

  @IsOptional()
  @Type(() => RetentionPreferencesDto)
  @ValidateNested()
  retentionPreferences?: RetentionPreferencesDto;
}
