import { UserResponse } from '../users/users.types';

export interface AccessTokenPayload {
  sub: string;
  type: 'access';
}

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresInSeconds: number;
  tokenType: 'Bearer';
}

export interface AuthResponse {
  tokens: AuthTokens;
  user: UserResponse;
}

export interface OtpSendResponse {
  developmentCode?: string;
  expiresInSeconds: number;
  verificationId: string;
}
