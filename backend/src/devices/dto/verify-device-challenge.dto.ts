import { IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class VerifyDeviceChallengeDto {
  @IsUUID('4')
  challengeId!: string;

  @IsString()
  @MaxLength(512)
  @Matches(/^[A-Za-z0-9_-]+={0,2}$/)
  signature!: string;
}

