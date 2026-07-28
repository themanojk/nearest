import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  Max,
  Min,
} from 'class-validator';

export class CreateMultipartPartsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(10_000, { each: true })
  partNumbers!: number[];
}

