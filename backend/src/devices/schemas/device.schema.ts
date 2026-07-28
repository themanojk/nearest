import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export enum DeviceLifecycleStatus {
  Active = 'active',
  Deactivated = 'deactivated',
  Damaged = 'damaged',
  Lost = 'lost',
}

export enum DevicePairingStatus {
  Paired = 'paired',
  Revoked = 'revoked',
  Unpaired = 'unpaired',
}

@Schema({
  collection: 'devices',
  timestamps: true,
  versionKey: false,
})
export class Device {
  @Prop({ required: true, trim: true, uppercase: true, unique: true })
  serialNumber!: string;

  @Prop({ required: true, trim: true })
  hardwareRevision!: string;

  @Prop({ required: true, trim: true })
  firmwareVersion!: string;

  /**
   * Manufacturer-provisioned Ed25519 SPKI public key in PEM format.
   * The corresponding private key must never leave the device secure storage.
   */
  @Prop({ required: true })
  identityPublicKeyPem!: string;

  @Prop({ type: Types.ObjectId, index: true })
  childId?: Types.ObjectId;

  @Prop({ index: true })
  ownerUserId?: string;

  @Prop({ trim: true })
  displayName?: string;

  @Prop({
    default: DevicePairingStatus.Unpaired,
    enum: DevicePairingStatus,
    index: true,
    required: true,
  })
  pairingStatus!: DevicePairingStatus;

  @Prop({
    default: DeviceLifecycleStatus.Active,
    enum: DeviceLifecycleStatus,
    index: true,
    required: true,
  })
  lifecycleStatus!: DeviceLifecycleStatus;

  @Prop()
  pairedAt?: Date;

  @Prop({ type: Types.ObjectId })
  pairedSessionId?: Types.ObjectId;

  @Prop({ default: 0, min: 0, required: true })
  credentialVersion!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type DeviceDocument = HydratedDocument<Device>;
export const DeviceSchema = SchemaFactory.createForClass(Device);

DeviceSchema.index({ ownerUserId: 1, lifecycleStatus: 1, _id: -1 });
DeviceSchema.index({ serialNumber: 1, pairingStatus: 1 });
