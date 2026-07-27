import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({
  collection: 'speaker_turns',
  timestamps: true,
  versionKey: false,
})
export class SpeakerTurn {
  @Prop({ required: true, type: Types.ObjectId, index: true })
  analysisJobId!: Types.ObjectId;

  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, min: 0 })
  turnIndex!: number;

  @Prop({ required: true })
  speakerId!: string;

  @Prop({ required: true, min: 0 })
  startMs!: number;

  @Prop({ required: true, min: 1 })
  endMs!: number;

  @Prop({ required: true })
  text!: string;

  @Prop({ min: 0, max: 1 })
  confidence?: number;

  @Prop({ required: true })
  model!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type SpeakerTurnDocument = HydratedDocument<SpeakerTurn>;
export const SpeakerTurnSchema = SchemaFactory.createForClass(SpeakerTurn);

SpeakerTurnSchema.index(
  { analysisJobId: 1, turnIndex: 1 },
  { unique: true },
);
SpeakerTurnSchema.index({ tenantId: 1, analysisJobId: 1, startMs: 1 });
