import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({
  collection: 'timeline_events',
  timestamps: true,
  versionKey: false,
})
export class TimelineEvent {
  @Prop({ required: true, type: Types.ObjectId, index: true })
  analysisJobId!: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, index: true })
  conversationSessionId!: Types.ObjectId;

  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, min: 0 })
  startMs!: number;

  @Prop({ required: true, min: 1 })
  endMs!: number;

  @Prop({ required: true, index: true })
  eventType!: string;

  @Prop({ required: true, index: true })
  severity!: string;

  @Prop({ required: true, min: 0, max: 1 })
  confidence!: number;

  @Prop({ required: true })
  speakerId!: string;

  @Prop({ required: true })
  evidence!: string;

  @Prop({ required: true, default: 'unknown' })
  childInvolvement!: 'unknown';

  @Prop({ required: true })
  modelName!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type TimelineEventDocument = HydratedDocument<TimelineEvent>;
export const TimelineEventSchema = SchemaFactory.createForClass(TimelineEvent);

TimelineEventSchema.index({
  tenantId: 1,
  analysisJobId: 1,
  startMs: 1,
});
