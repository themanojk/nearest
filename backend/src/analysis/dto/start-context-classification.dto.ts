import { IsBoolean, IsOptional } from 'class-validator';

export class StartContextClassificationDto {
  @IsOptional()
  @IsBoolean()
  force: boolean = false;
}
