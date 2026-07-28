import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { AccessTokenPayload } from './auth.types';
import { AuthenticatedRequest } from './authenticated-request';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const [scheme, token] = authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Bearer access token is required');
    }

    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
      if (payload.type !== 'access' || !payload.sub) {
        throw new UnauthorizedException('Invalid access token');
      }
      await this.users.getActiveDocument(payload.sub);
      request.authUser = { userId: payload.sub };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
