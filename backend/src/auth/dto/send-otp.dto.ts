import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsDefined,
  IsString,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { OtpChannel } from '../schemas/otp-challenge.schema';

class PhoneDto {
  @IsString()
  @Matches(/^\+[1-9]\d{0,2}$/)
  countryCode!: string;

  @IsString()
  @Matches(/^\d{6,15}$/)
  number!: string;
}

export class SendOtpDto {
  @IsEnum(OtpChannel)
  channel!: OtpChannel;

  @ValidateIf((input: SendOtpDto) => input.channel === OtpChannel.Email)
  @IsDefined()
  @IsEmail()
  email?: string;

  @ValidateIf((input: SendOtpDto) => input.channel === OtpChannel.Phone)
  @IsDefined()
  @Type(() => PhoneDto)
  @ValidateNested()
  phone?: PhoneDto;

  @IsString()
  @ValidateIf((input: SendOtpDto) => input.locale !== undefined)
  locale?: string;
}
