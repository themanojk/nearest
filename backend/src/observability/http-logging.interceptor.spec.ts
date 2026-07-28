import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { lastValueFrom, of, throwError } from 'rxjs';
import { HttpLoggingInterceptor } from './http-logging.interceptor';

describe('HttpLoggingInterceptor', () => {
  const logger = {
    debug: jest.fn<void, [string]>(),
    error: jest.fn<void, [string, string?]>(),
    log: jest.fn<void, [string]>(),
    warn: jest.fn<void, [string]>(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs sanitized request details and successful completion', async () => {
    const { context, response } = createContext({
      body: { childId: 'child-1', password: 'secret' },
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'mobile-request-1',
      },
    });
    const interceptor = interceptorWithLogger();

    await lastValueFrom(
      interceptor.intercept(context, {
        handle: () => of({ success: true }),
      }),
    );

    expect(response.setHeader).toHaveBeenCalledWith(
      'x-request-id',
      'mobile-request-1',
    );
    const started = JSON.parse(logger.debug.mock.calls[0][0]) as {
      body: { childId: string; password: string };
    };
    expect(started.body).toEqual({
      childId: 'child-1',
      password: '[REDACTED]',
    });
    const completed = JSON.parse(logger.log.mock.calls[0][0]) as {
      event: string;
      statusCode: number;
    };
    expect(completed).toMatchObject({
      event: 'http.request.completed',
      statusCode: 200,
    });
  });

  it('warns for expected client errors', async () => {
    const { context } = createContext();
    const interceptor = interceptorWithLogger();
    const handler: CallHandler = {
      handle: () =>
        throwError(() => new BadRequestException('Invalid input')),
    };

    await expect(
      lastValueFrom(interceptor.intercept(context, handler)),
    ).rejects.toBeInstanceOf(BadRequestException);

    const completed = JSON.parse(logger.warn.mock.calls[0][0]) as {
      statusCode: number;
    };
    expect(completed.statusCode).toBe(400);
    expect(logger.error).not.toHaveBeenCalled();
  });

  function interceptorWithLogger(): HttpLoggingInterceptor {
    const interceptor = new HttpLoggingInterceptor();
    Object.assign(interceptor, { logger });
    return interceptor;
  }
});

function createContext(
  requestOverrides: Partial<Request> = {},
): {
  context: ExecutionContext;
  response: Pick<Response, 'getHeader' | 'setHeader' | 'statusCode'>;
} {
  const request = {
    authUser: { userId: 'user-1' },
    body: {},
    headers: {},
    ip: '127.0.0.1',
    method: 'POST',
    originalUrl: '/v1/test',
    path: '/v1/test',
    params: {},
    query: {},
    route: { path: '/test' },
    ...requestOverrides,
  } as unknown as Request;
  const response = {
    getHeader: jest.fn(),
    setHeader: jest.fn(),
    statusCode: 200,
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return { context, response };
}
