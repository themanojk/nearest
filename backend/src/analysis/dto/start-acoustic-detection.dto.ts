import { IsBoolean, IsOptional } from 'class-validator';

export class StartAcousticDetectionDto {
  @IsOptional()
  @IsBoolean()
  force = false;
}
