import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum ChildAgeGroup {
  Age3To5 = '3_5',
  Age6To8 = '6_8',
  Age9To12 = '9_12',
  Age13To15 = '13_15',
  Age16To17 = '16_17',
}

export enum ChildProfileStatus {
  Active = 'active',
  Archived = 'archived',
  Deleted = 'deleted',
}

export interface AnalysisPreferences {
  bullyingDetection: boolean;
  childSpeakerIdentification: boolean;
  conversationAnalysis: boolean;
  dangerDetection: boolean;
  environmentDetection: boolean;
  healthSignalDetection: boolean;
  profanityDetection: boolean;
}

export interface RetentionPreferences {
  eventClipRetentionDays: number;
  rawAudioRetentionDays: number;
  transcriptRetentionDays: number;
}

@Schema({
  collection: 'child_profiles',
  timestamps: true,
  versionKey: false,
})
export class ChildProfile {
  @Prop({ required: true, index: true })
  ownerUserId!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true })
  nickname?: string;

  @Prop()
  profileImageUrl?: string;

  @Prop({ required: true, enum: ChildAgeGroup })
  ageGroup!: ChildAgeGroup;

  @Prop({ required: true, type: [String] })
  languages!: string[];

  @Prop({ required: true, type: Object })
  analysisPreferences!: AnalysisPreferences;

  @Prop({ required: true, type: Object })
  retentionPreferences!: RetentionPreferences;

  @Prop({
    default: ChildProfileStatus.Active,
    enum: ChildProfileStatus,
    index: true,
    required: true,
  })
  status!: ChildProfileStatus;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ChildProfileDocument = HydratedDocument<ChildProfile>;
export const ChildProfileSchema = SchemaFactory.createForClass(ChildProfile);

ChildProfileSchema.index({ ownerUserId: 1, status: 1, _id: -1 });
