import { IsString, Length, Matches } from 'class-validator';

export class DiscoverDeviceDto {
  @IsString()
  @Length(4, 80)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]+$/)
  serialNumber!: string;
}

