import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { ChildrenService } from './children.service';
import {
  ChildProfileEnvelope,
  ChildProfilePageEnvelope,
} from './children.types';
import { AnalysisPreferencesDto } from './dto/analysis-preferences.dto';
import { CreateChildDto } from './dto/create-child.dto';
import { ListChildrenDto } from './dto/list-children.dto';
import { RetentionPreferencesDto } from './dto/retention-preferences.dto';
import { UpdateChildDto } from './dto/update-child.dto';

@Controller('children')
@UseGuards(AccessTokenGuard)
export class ChildrenController {
  constructor(private readonly children: ChildrenService) {}

  @Post()
  async create(
    @CurrentUserId() ownerUserId: string,
    @Body() input: CreateChildDto,
  ): Promise<ChildProfileEnvelope> {
    return {
      success: true,
      data: await this.children.create(ownerUserId, input),
    };
  }

  @Get()
  list(
    @CurrentUserId() ownerUserId: string,
    @Query() query: ListChildrenDto,
  ): Promise<ChildProfilePageEnvelope> {
    return this.children.list(ownerUserId, query);
  }

  @Get(':childId')
  async getById(
    @CurrentUserId() ownerUserId: string,
    @Param('childId') childId: string,
  ): Promise<ChildProfileEnvelope> {
    return {
      success: true,
      data: await this.children.getById(ownerUserId, childId),
    };
  }

  @Patch(':childId')
  async update(
    @CurrentUserId() ownerUserId: string,
    @Param('childId') childId: string,
    @Body() input: UpdateChildDto,
  ): Promise<ChildProfileEnvelope> {
    return {
      success: true,
      data: await this.children.update(ownerUserId, childId, input),
    };
  }

  @Patch(':childId/analysis-preferences')
  async updateAnalysisPreferences(
    @CurrentUserId() ownerUserId: string,
    @Param('childId') childId: string,
    @Body() input: AnalysisPreferencesDto,
  ): Promise<ChildProfileEnvelope> {
    return {
      success: true,
      data: await this.children.updateAnalysisPreferences(
        ownerUserId,
        childId,
        input,
      ),
    };
  }

  @Patch(':childId/retention-preferences')
  async updateRetentionPreferences(
    @CurrentUserId() ownerUserId: string,
    @Param('childId') childId: string,
    @Body() input: RetentionPreferencesDto,
  ): Promise<ChildProfileEnvelope> {
    return {
      success: true,
      data: await this.children.updateRetentionPreferences(
        ownerUserId,
        childId,
        input,
      ),
    };
  }

  @Delete(':childId')
  async archive(
    @CurrentUserId() ownerUserId: string,
    @Param('childId') childId: string,
  ): Promise<ChildProfileEnvelope> {
    return {
      success: true,
      data: await this.children.archive(ownerUserId, childId),
    };
  }
}
