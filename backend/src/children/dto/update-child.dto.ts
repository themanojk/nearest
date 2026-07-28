import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
} from 'class-validator';
import { ChildAgeGroup } from '../schemas/child-profile.schema';

export class UpdateChildDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

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

  @IsOptional()
  @IsEnum(ChildAgeGroup)
  ageGroup?: ChildAgeGroup;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Matches(/^[a-z]{2,3}(?:-[A-Z]{2})?$/, {
    each: true,
    message: 'each language must be a BCP 47 language tag such as en or en-IN',
  })
  languages?: string[];
}
