import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({
  collection: 'acoustic_events',
  timestamps: true,
  versionKey: false,
})
export class AcousticEvent {
  @Prop({ required: true, type: Types.ObjectId, index: true })
  analysisJobId!: Types.ObjectId;

  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  sourceChunkId!: string;

  @Prop({ required: true, min: 0 })
  startMs!: number;

  @Prop({ required: true, min: 1 })
  endMs!: number;

  @Prop({ required: true, index: true })
  label!: string;

  @Prop({ required: true, index: true })
  category!: string;

  @Prop({ required: true, index: true })
  severity!: string;

  @Prop({ required: true, min: 0, max: 1 })
  confidence!: number;

  @Prop({ required: true })
  modelName!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AcousticEventDocument = HydratedDocument<AcousticEvent>;
export const AcousticEventSchema = SchemaFactory.createForClass(AcousticEvent);

AcousticEventSchema.index({
  tenantId: 1,
  analysisJobId: 1,
  startMs: 1,
});
