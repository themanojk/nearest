import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({
  collection: 'refresh_sessions',
  timestamps: true,
  versionKey: false,
})
export class RefreshSession {
  @Prop({ required: true, type: Types.ObjectId, index: true })
  userId!: Types.ObjectId;

  @Prop({ required: true, unique: true })
  tokenHash!: string;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop()
  revokedAt?: Date;

  @Prop()
  revokeReason?: 'logout' | 'rotated';

  createdAt!: Date;
  updatedAt!: Date;
}

export type RefreshSessionDocument = HydratedDocument<RefreshSession>;
export const RefreshSessionSchema =
  SchemaFactory.createForClass(RefreshSession);

RefreshSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
RefreshSessionSchema.index({ userId: 1, revokedAt: 1 });
