/* eslint-disable @typescript-eslint/unbound-method */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { ChildrenService } from './children.service';
import {
  ChildAgeGroup,
  ChildProfile,
  ChildProfileDocument,
  ChildProfileStatus,
} from './schemas/child-profile.schema';

const CHILD_ID = '66a111111111111111111111';

function childDocument(
  overrides: Partial<ChildProfile> = {},
): ChildProfileDocument {
  const now = new Date('2026-07-27T10:00:00.000Z');
  return {
    _id: new Types.ObjectId(CHILD_ID),
    ownerUserId: 'parent-a',
    name: 'Aarav',
    ageGroup: ChildAgeGroup.Age6To8,
    languages: ['en', 'hi'],
    analysisPreferences: {
      bullyingDetection: false,
      childSpeakerIdentification: false,
      conversationAnalysis: true,
      dangerDetection: true,
      environmentDetection: true,
      healthSignalDetection: false,
      profanityDetection: false,
    },
    retentionPreferences: {
      eventClipRetentionDays: 30,
      rawAudioRetentionDays: 7,
      transcriptRetentionDays: 30,
    },
    status: ChildProfileStatus.Active,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as ChildProfileDocument;
}

describe('ChildrenService', () => {
  function setup(options?: {
    findOneResult?: ChildProfileDocument | null;
    listDocuments?: ChildProfileDocument[];
    updatedDocument?: ChildProfileDocument | null;
  }) {
    const document = childDocument();
    const listDocuments = options?.listDocuments ?? [document];
    const findOneResult =
      options && 'findOneResult' in options
        ? options.findOneResult
        : document;
    const updatedDocument =
      options && 'updatedDocument' in options
        ? options.updatedDocument
        : document;
    const listQuery = {
      exec: jest.fn().mockResolvedValue(listDocuments),
      limit: jest.fn(),
      sort: jest.fn(),
    };
    listQuery.sort.mockReturnValue(listQuery);
    listQuery.limit.mockReturnValue(listQuery);

    const model = {
      create: jest.fn().mockResolvedValue(document),
      find: jest.fn().mockReturnValue(listQuery),
      findOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(findOneResult),
      }),
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(updatedDocument),
      }),
    } as unknown as Model<ChildProfile>;

    return {
      document,
      listQuery,
      model,
      service: new ChildrenService(model),
    };
  }

  it('creates an owner-scoped child with conservative defaults', async () => {
    const { model, service } = setup();

    const result = await service.create('parent-a', {
      name: ' Aarav ',
      ageGroup: ChildAgeGroup.Age6To8,
      languages: ['en', 'hi', 'en'],
      analysisPreferences: {
        dangerDetection: true,
      },
    });

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: 'parent-a',
        name: 'Aarav',
        languages: ['en', 'hi'],
        status: ChildProfileStatus.Active,
        analysisPreferences: {
          bullyingDetection: false,
          childSpeakerIdentification: false,
          conversationAnalysis: false,
          dangerDetection: true,
          environmentDetection: false,
          healthSignalDetection: false,
          profanityDetection: false,
        },
        retentionPreferences: {
          eventClipRetentionDays: 30,
          rawAudioRetentionDays: 7,
          transcriptRetentionDays: 30,
        },
      }),
    );
    expect(result.id).toBe(CHILD_ID);
  });

  it('lists only active children owned by the requesting parent', async () => {
    const { listQuery, model, service } = setup();

    const result = await service.list('parent-a', { limit: 20 });

    expect(model.find).toHaveBeenCalledWith({
      ownerUserId: 'parent-a',
      status: ChildProfileStatus.Active,
    });
    expect(listQuery.sort).toHaveBeenCalledWith({ _id: -1 });
    expect(listQuery.limit).toHaveBeenCalledWith(21);
    expect(result.data).toHaveLength(1);
  });

  it('does not reveal a child belonging to another parent', async () => {
    const { model, service } = setup({ findOneResult: null });

    await expect(service.getById('parent-b', CHILD_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(model.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: 'parent-b',
      }),
    );
  });

  it('updates only supplied analysis preference fields', async () => {
    const { model, service } = setup();

    await service.updateAnalysisPreferences('parent-a', CHILD_ID, {
      bullyingDetection: true,
    });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: 'parent-a',
        status: ChildProfileStatus.Active,
      }),
      {
        $set: {
          'analysisPreferences.bullyingDetection': true,
        },
      },
      expect.objectContaining({
        runValidators: true,
      }),
    );
  });

  it('archives instead of physically deleting a child profile', async () => {
    const archived = childDocument({ status: ChildProfileStatus.Archived });
    const { model, service } = setup({ updatedDocument: archived });

    const result = await service.archive('parent-a', CHILD_ID);

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      {
        $set: {
          status: ChildProfileStatus.Archived,
        },
      },
      expect.any(Object),
    );
    expect(result.status).toBe(ChildProfileStatus.Archived);
  });

  it('rejects an empty preference patch', async () => {
    const { service } = setup();

    await expect(
      service.updateRetentionPreferences('parent-a', CHILD_ID, {}),
    ).rejects.toThrow(BadRequestException);
  });
});
