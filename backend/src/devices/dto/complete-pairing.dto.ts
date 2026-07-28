import { IsMongoId, IsString, Length, Matches } from 'class-validator';

export class CompletePairingDto {
  @IsMongoId()
  childId!: string;

  @IsString()
  @Length(1, 80)
  @Matches(/\S/)
  displayName!: string;
}
