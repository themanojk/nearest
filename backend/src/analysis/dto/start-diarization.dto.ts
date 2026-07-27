import { IsBoolean, IsOptional } from 'class-validator';

export class StartDiarizationDto {
  @IsOptional()
  @IsBoolean()
  force: boolean = false;
}
