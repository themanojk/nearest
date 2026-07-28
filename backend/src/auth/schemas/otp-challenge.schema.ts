import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum OtpChannel {
  Email = 'email',
  Phone = 'phone',
}

@Schema({
  collection: 'otp_challenges',
  timestamps: { createdAt: true, updatedAt: false },
  versionKey: false,
})
export class OtpChallenge {
  @Prop({ required: true, enum: OtpChannel })
  channel!: OtpChannel;

  @Prop({ required: true, index: true })
  target!: string;

  @Prop({ required: true })
  codeHash!: string;

  @Prop({ default: 0, min: 0, required: true })
  attempts!: number;

  @Prop({ default: 5, min: 1, required: true })
  maxAttempts!: number;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop()
  consumedAt?: Date;

  createdAt!: Date;
}

export type OtpChallengeDocument = HydratedDocument<OtpChallenge>;
export const OtpChallengeSchema = SchemaFactory.createForClass(OtpChallenge);

OtpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
OtpChallengeSchema.index({ target: 1, createdAt: -1 });
