import { IsString, Length, Matches } from 'class-validator';

export class UpdateDeviceDto {
  @IsString()
  @Length(1, 80)
  @Matches(/\S/)
  displayName!: string;
}
