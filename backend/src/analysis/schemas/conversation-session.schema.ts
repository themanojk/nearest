import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export interface ConversationUtterance {
  confidence?: number;
  endMs: number;
  speakerId: string;
  startMs: number;
  text: string;
}

export interface ConversationQuality {
  cleanedText: string;
  flags: string[];
  score: number;
  usable: boolean;
}

export interface ConversationClassification {
  confidence: number;
  label: string;
}

export interface ProfanityClassification {
  directedAtChild: 'unknown';
  exposureLevel: string;
  notificationReason?: string;
  notificationRecommended: boolean;
  occurrenceCount: number;
  occurrences: Array<{
    canonicalTerm: string;
    confidence: number;
    endMs: number;
    evidence: string;
    severity: string;
    speakerId: string;
    startMs: number;
    term: string;
  }>;
  severity: string;
  terms: string[];
}

@Schema({
  collection: 'conversation_sessions',
  timestamps: true,
  versionKey: false,
})
export class ConversationSession {
  @Prop({ required: true, type: Types.ObjectId, index: true })
  analysisJobId!: Types.ObjectId;

  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, min: 0 })
  sessionIndex!: number;

  @Prop({ required: true, min: 0 })
  startMs!: number;

  @Prop({ required: true, min: 1 })
  endMs!: number;

  @Prop({ type: [String], required: true })
  speakers!: string[];

  @Prop({ type: [Object], required: true })
  utterances!: ConversationUtterance[];

  @Prop({ required: true, default: 'unknown' })
  environment!: string;

  @Prop({ required: true, default: false })
  childPresent!: boolean;

  @Prop({ type: Object })
  quality?: ConversationQuality;

  @Prop({ type: Object })
  conversationType?: ConversationClassification;

  @Prop({ type: Object })
  profanity?: ProfanityClassification;

  @Prop({ type: [Object], default: [] })
  safetySignals!: Array<{
    confidence: number;
    endMs: number;
    evidence: string;
    severity: string;
    signalType: string;
    speakerId: string;
    startMs: number;
  }>;

  @Prop()
  contextModel?: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ConversationSessionDocument =
  HydratedDocument<ConversationSession>;
export const ConversationSessionSchema =
  SchemaFactory.createForClass(ConversationSession);

ConversationSessionSchema.index(
  { analysisJobId: 1, sessionIndex: 1 },
  { unique: true },
);
ConversationSessionSchema.index({
  tenantId: 1,
  analysisJobId: 1,
  startMs: 1,
});
