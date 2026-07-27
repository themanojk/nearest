import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export interface RiskEvidence {
  category?: string;
  confidence: number;
  endMs: number;
  evidenceText?: string;
  label: string;
  source: 'transcript' | 'acoustic';
  startMs: number;
}

@Schema({
  collection: 'risk_incidents',
  timestamps: true,
  versionKey: false,
})
export class RiskIncident {
  @Prop({ required: true, type: Types.ObjectId, index: true })
  analysisJobId!: Types.ObjectId;

  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, min: 0 })
  startMs!: number;

  @Prop({ required: true, min: 1 })
  endMs!: number;

  @Prop({ required: true, index: true })
  incidentType!: string;

  @Prop({ required: true, index: true })
  severity!: string;

  @Prop({ required: true, min: 0, max: 1 })
  confidence!: number;

  @Prop({ type: [String], required: true })
  modalities!: Array<'transcript' | 'acoustic'>;

  @Prop({ type: [Object], required: true })
  evidence!: RiskEvidence[];

  @Prop({ required: true })
  rationale!: string;

  @Prop({ required: true, default: 'unknown' })
  childInvolvement!: 'unknown';

  @Prop({ required: true, default: 'unreviewed', index: true })
  reviewStatus!: 'unreviewed';

  @Prop({ required: true })
  modelName!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type RiskIncidentDocument = HydratedDocument<RiskIncident>;
export const RiskIncidentSchema = SchemaFactory.createForClass(RiskIncident);

RiskIncidentSchema.index({
  tenantId: 1,
  analysisJobId: 1,
  startMs: 1,
});
