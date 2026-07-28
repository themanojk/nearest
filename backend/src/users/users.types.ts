import {
  AuthProvider,
  PhoneNumber,
  UserPreferences,
  UserStatus,
} from './schemas/user.schema';

export interface UserResponse {
  authProvider: AuthProvider;
  createdAt: string;
  email?: string;
  firstName?: string;
  id: string;
  lastName?: string;
  phone?: PhoneNumber;
  preferences: UserPreferences;
  status: UserStatus;
  updatedAt: string;
}
