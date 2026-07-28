import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum AuthProvider {
  EmailOtp = 'email_otp',
  PhoneOtp = 'phone_otp',
}

export enum UserStatus {
  Active = 'active',
  Deleted = 'deleted',
  Suspended = 'suspended',
}

export interface PhoneNumber {
  countryCode: string;
  number: string;
  verifiedAt: Date;
}

export interface UserPreferences {
  language: string;
  notificationChannels: {
    email: boolean;
    push: boolean;
    sms: boolean;
  };
  timezone: string;
}

@Schema({
  collection: 'users',
  timestamps: true,
  versionKey: false,
})
export class User {
  @Prop({ trim: true })
  firstName?: string;

  @Prop({ trim: true })
  lastName?: string;

  @Prop({ lowercase: true, trim: true })
  email?: string;

  @Prop({ type: Object })
  phone?: PhoneNumber;

  @Prop({ required: true, enum: AuthProvider })
  authProvider!: AuthProvider;

  @Prop({
    default: UserStatus.Active,
    enum: UserStatus,
    index: true,
    required: true,
  })
  status!: UserStatus;

  @Prop({
    default: () => ({
      timezone: 'UTC',
      language: 'en',
      notificationChannels: {
        push: true,
        email: false,
        sms: false,
      },
    }),
    required: true,
    type: Object,
  })
  preferences!: UserPreferences;

  createdAt!: Date;
  updatedAt!: Date;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { email: { $type: 'string' } },
  },
);
UserSchema.index(
  { 'phone.countryCode': 1, 'phone.number': 1 },
  {
    unique: true,
    partialFilterExpression: { phone: { $type: 'object' } },
  },
);
