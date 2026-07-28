import { IsMongoId, Matches } from 'class-validator';

export class VerifyOtpDto {
  @IsMongoId()
  verificationId!: string;

  @Matches(/^\d{4,8}$/)
  code!: string;
}
