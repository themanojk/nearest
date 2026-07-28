import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';

class NotificationChannelsDto {
  @IsBoolean()
  @IsOptional()
  email?: boolean;

  @IsBoolean()
  @IsOptional()
  push?: boolean;

  @IsBoolean()
  @IsOptional()
  sms?: boolean;
}

class UserPreferencesDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)
  language?: string;

  @IsOptional()
  @Type(() => NotificationChannelsDto)
  @ValidateNested()
  notificationChannels?: NotificationChannelsDto;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  timezone?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  lastName?: string;

  @IsOptional()
  @Type(() => UserPreferencesDto)
  @ValidateNested()
  preferences?: UserPreferencesDto;
}
