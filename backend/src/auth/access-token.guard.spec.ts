import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { AccessTokenGuard } from './access-token.guard';
import { AuthenticatedRequest } from './authenticated-request';

describe('AccessTokenGuard', () => {
  function context(request: Partial<AuthenticatedRequest>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  it('attaches the verified active user identity to the request', async () => {
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: '66a111111111111111111111',
        type: 'access',
      }),
    } as unknown as JwtService;
    const users = {
      getActiveDocument: jest.fn().mockResolvedValue({}),
    } as unknown as UsersService;
    const guard = new AccessTokenGuard(jwt, users);
    const request = {
      headers: {
        authorization: 'Bearer valid-token',
      },
    } as Partial<AuthenticatedRequest>;

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.authUser).toEqual({
      userId: '66a111111111111111111111',
    });
  });

  it('rejects requests without a bearer access token', async () => {
    const guard = new AccessTokenGuard(
      {} as JwtService,
      {} as UsersService,
    );

    await expect(
      guard.canActivate(context({ headers: {} })),
    ).rejects.toThrow(UnauthorizedException);
  });
});
