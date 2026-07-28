import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersController } from '../users/users.controller';
import { UsersModule } from '../users/users.module';
import { AccessTokenGuard } from './access-token.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import {
  OtpChallenge,
  OtpChallengeSchema,
} from './schemas/otp-challenge.schema';
import {
  RefreshSession,
  RefreshSessionSchema,
} from './schemas/refresh-session.schema';

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('AUTH_JWT_SECRET'),
        signOptions: {
          audience: 'nearnest-app',
          issuer: 'nearnest-api',
        },
        verifyOptions: {
          audience: 'nearnest-app',
          issuer: 'nearnest-api',
        },
      }),
    }),
    MongooseModule.forFeature([
      {
        name: OtpChallenge.name,
        schema: OtpChallengeSchema,
      },
      {
        name: RefreshSession.name,
        schema: RefreshSessionSchema,
      },
    ]),
  ],
  controllers: [AuthController, UsersController],
  providers: [AuthService, AccessTokenGuard],
  exports: [AccessTokenGuard, JwtModule, UsersModule],
})
export class AuthModule {}
