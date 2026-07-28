import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types, UpdateQuery } from 'mongoose';
import { AnalysisPreferencesDto } from './dto/analysis-preferences.dto';
import { CreateChildDto } from './dto/create-child.dto';
import { ListChildrenDto } from './dto/list-children.dto';
import { RetentionPreferencesDto } from './dto/retention-preferences.dto';
import { UpdateChildDto } from './dto/update-child.dto';
import {
  ChildProfilePageEnvelope,
  ChildProfileResponse,
} from './children.types';
import {
  AnalysisPreferences,
  ChildProfile,
  ChildProfileDocument,
  ChildProfileStatus,
  RetentionPreferences,
} from './schemas/child-profile.schema';

const DEFAULT_ANALYSIS_PREFERENCES: AnalysisPreferences = {
  bullyingDetection: false,
  childSpeakerIdentification: false,
  conversationAnalysis: false,
  dangerDetection: false,
  environmentDetection: false,
  healthSignalDetection: false,
  profanityDetection: false,
};

const DEFAULT_RETENTION_PREFERENCES: RetentionPreferences = {
  eventClipRetentionDays: 30,
  rawAudioRetentionDays: 7,
  transcriptRetentionDays: 30,
};

@Injectable()
export class ChildrenService {
  constructor(
    @InjectModel(ChildProfile.name)
    private readonly childModel: Model<ChildProfile>,
  ) {}

  async create(
    ownerUserId: string,
    input: CreateChildDto,
  ): Promise<ChildProfileResponse> {
    this.assertOwnerUserId(ownerUserId);
    const child = await this.childModel.create({
      ageGroup: input.ageGroup,
      analysisPreferences: {
        ...DEFAULT_ANALYSIS_PREFERENCES,
        ...input.analysisPreferences,
      },
      languages: this.normaliseLanguages(input.languages),
      name: input.name.trim(),
      nickname: input.nickname?.trim(),
      ownerUserId,
      profileImageUrl: input.profileImageUrl,
      retentionPreferences: {
        ...DEFAULT_RETENTION_PREFERENCES,
        ...input.retentionPreferences,
      },
      status: ChildProfileStatus.Active,
    });

    return this.toResponse(child);
  }

  async list(
    ownerUserId: string,
    query: ListChildrenDto,
  ): Promise<ChildProfilePageEnvelope> {
    this.assertOwnerUserId(ownerUserId);
    const filter: QueryFilter<ChildProfile> = {
      ownerUserId,
      status: ChildProfileStatus.Active,
    };
    if (query.cursor) {
      filter._id = { $lt: this.parseChildId(query.cursor) };
    }

    const documents = await this.childModel
      .find(filter)
      .sort({ _id: -1 })
      .limit(query.limit + 1)
      .exec();
    const hasNextPage = documents.length > query.limit;
    const page = hasNextPage ? documents.slice(0, query.limit) : documents;

    return {
      success: true,
      data: page.map((child) => this.toResponse(child)),
      meta: {
        nextCursor: hasNextPage
          ? this.documentId(page[page.length - 1])
          : undefined,
      },
    };
  }

  async getById(
    ownerUserId: string,
    childId: string,
  ): Promise<ChildProfileResponse> {
    return this.toResponse(await this.findOwnedChild(ownerUserId, childId));
  }

  async update(
    ownerUserId: string,
    childId: string,
    input: UpdateChildDto,
  ): Promise<ChildProfileResponse> {
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) set.name = input.name.trim();
    if (input.nickname !== undefined) set.nickname = input.nickname.trim();
    if (input.profileImageUrl !== undefined) {
      set.profileImageUrl = input.profileImageUrl;
    }
    if (input.ageGroup !== undefined) set.ageGroup = input.ageGroup;
    if (input.languages !== undefined) {
      set.languages = this.normaliseLanguages(input.languages);
    }

    return this.updateOwnedChild(ownerUserId, childId, set);
  }

  async updateAnalysisPreferences(
    ownerUserId: string,
    childId: string,
    input: AnalysisPreferencesDto,
  ): Promise<ChildProfileResponse> {
    return this.updateNestedPreferences(
      ownerUserId,
      childId,
      'analysisPreferences',
      input,
    );
  }

  async updateRetentionPreferences(
    ownerUserId: string,
    childId: string,
    input: RetentionPreferencesDto,
  ): Promise<ChildProfileResponse> {
    return this.updateNestedPreferences(
      ownerUserId,
      childId,
      'retentionPreferences',
      input,
    );
  }

  async archive(
    ownerUserId: string,
    childId: string,
  ): Promise<ChildProfileResponse> {
    return this.updateOwnedChild(ownerUserId, childId, {
      status: ChildProfileStatus.Archived,
    });
  }

  private async updateNestedPreferences(
    ownerUserId: string,
    childId: string,
    field: 'analysisPreferences' | 'retentionPreferences',
    input: AnalysisPreferencesDto | RetentionPreferencesDto,
  ): Promise<ChildProfileResponse> {
    const set = Object.fromEntries(
      Object.entries(input)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [`${field}.${key}`, value]),
    );
    return this.updateOwnedChild(ownerUserId, childId, set);
  }

  private async updateOwnedChild(
    ownerUserId: string,
    childId: string,
    set: Record<string, unknown>,
  ): Promise<ChildProfileResponse> {
    this.assertOwnerUserId(ownerUserId);
    if (Object.keys(set).length === 0) {
      throw new BadRequestException('At least one field must be provided');
    }

    const update: UpdateQuery<ChildProfile> = { $set: set };
    const child = await this.childModel
      .findOneAndUpdate(
        {
          _id: this.parseChildId(childId),
          ownerUserId,
          status: ChildProfileStatus.Active,
        },
        update,
        { returnDocument: 'after', runValidators: true },
      )
      .exec();

    if (!child) {
      throw new NotFoundException('Child profile not found');
    }
    return this.toResponse(child);
  }

  private async findOwnedChild(
    ownerUserId: string,
    childId: string,
  ): Promise<ChildProfileDocument> {
    this.assertOwnerUserId(ownerUserId);
    const child = await this.childModel
      .findOne({
        _id: this.parseChildId(childId),
        ownerUserId,
        status: { $ne: ChildProfileStatus.Deleted },
      })
      .exec();
    if (!child) {
      throw new NotFoundException('Child profile not found');
    }
    return child;
  }

  private assertOwnerUserId(ownerUserId: string | undefined): asserts ownerUserId {
    if (!ownerUserId?.trim()) {
      throw new BadRequestException('Authenticated parent identifier is required');
    }
  }

  private parseChildId(childId: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(childId)) {
      throw new BadRequestException('Invalid child profile identifier');
    }
    return new Types.ObjectId(childId);
  }

  private normaliseLanguages(languages: string[]): string[] {
    return [...new Set(languages)];
  }

  private documentId(child: ChildProfileDocument): string {
    return child._id.toHexString();
  }

  private toResponse(child: ChildProfileDocument): ChildProfileResponse {
    return {
      id: this.documentId(child),
      name: child.name,
      nickname: child.nickname,
      profileImageUrl: child.profileImageUrl,
      ageGroup: child.ageGroup,
      languages: child.languages,
      analysisPreferences: child.analysisPreferences,
      retentionPreferences: child.retentionPreferences,
      status: child.status,
      createdAt: child.createdAt.toISOString(),
      updatedAt: child.updatedAt.toISOString(),
    };
  }
}
