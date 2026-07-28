import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export enum PairingSessionStatus {
  Created = 'created',
  DeviceDiscovered = 'device_discovered',
  Verified = 'verified',
  Completed = 'completed',
  Failed = 'failed',
}

@Schema({
  collection: 'device_pairing_sessions',
  timestamps: true,
  versionKey: false,
})
export class DevicePairingSession {
  @Prop({ required: true, index: true })
  ownerUserId!: string;

  @Prop({ type: Types.ObjectId })
  deviceId?: Types.ObjectId;

  @Prop({ trim: true })
  serialNumber?: string;

  @Prop({ required: true, enum: PairingSessionStatus, index: true })
  status!: PairingSessionStatus;

  @Prop()
  challengeId?: string;

  @Prop()
  challengeNonce?: string;

  @Prop()
  challengeExpiresAt?: Date;

  @Prop()
  challengeConsumedAt?: Date;

  @Prop({ default: 0, min: 0, required: true })
  failedAttempts!: number;

  @Prop({ default: 5, min: 1, required: true })
  maxAttempts!: number;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({ required: true })
  purgeAt!: Date;

  @Prop({ type: Types.ObjectId })
  childId?: Types.ObjectId;

  @Prop()
  completedAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type DevicePairingSessionDocument =
  HydratedDocument<DevicePairingSession>;
export const DevicePairingSessionSchema =
  SchemaFactory.createForClass(DevicePairingSession);

DevicePairingSessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
DevicePairingSessionSchema.index({ ownerUserId: 1, status: 1, createdAt: -1 });
