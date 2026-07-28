import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import {
  sanitizeErrorMessage,
  sanitizeForLogs,
} from './log-sanitizer';

type RequestWithAuth = Request & {
  authUser?: {
    userId: string;
  };
};

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithAuth>();
    const response = http.getResponse<Response>();
    const requestId = this.requestId(request);
    const startedAt = process.hrtime.bigint();
    response.setHeader('x-request-id', requestId);

    this.logger.debug(
      JSON.stringify({
        event: 'http.request.started',
        requestId,
        method: request.method,
        path: request.path,
        ip: request.ip,
        userId: request.authUser?.userId,
        contentType: request.headers['content-type'],
        contentLength: request.headers['content-length'],
        userAgent: request.headers['user-agent'],
        params: sanitizeForLogs(request.params),
        query: sanitizeForLogs(request.query),
        body: sanitizeForLogs(request.body),
      }),
    );

    let completed = false;
    const finish = (error?: unknown) => {
      if (completed) return;
      completed = true;
      const statusCode = this.statusCode(error, response.statusCode);
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const log = {
        event: 'http.request.completed',
        requestId,
        method: request.method,
        path: request.path,
        userId: request.authUser?.userId,
        statusCode,
        durationMs: Number(durationMs.toFixed(2)),
        responseLength: response.getHeader('content-length'),
      };

      if (!error) {
        this.logger.log(JSON.stringify(log));
        return;
      }

      const errorDetails = {
        ...log,
        errorName:
          error instanceof Error ? error.name : 'UnknownRequestError',
        errorMessage:
          error instanceof Error
            ? sanitizeErrorMessage(error.message)
            : 'Request failed',
      };
      if (statusCode >= 500) {
        this.logger.error(
          JSON.stringify(errorDetails),
          error instanceof Error && error.stack
            ? sanitizeErrorMessage(error.stack)
            : undefined,
        );
      } else {
        this.logger.warn(JSON.stringify(errorDetails));
      }
    };

    return next.handle().pipe(
      tap({
        complete: () => finish(),
        error: (error: unknown) => finish(error),
      }),
    );
  }

  private requestId(request: Request): string {
    const supplied = request.headers['x-request-id'];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
    return candidate && REQUEST_ID_PATTERN.test(candidate)
      ? candidate
      : randomUUID();
  }

  private statusCode(error: unknown, responseStatus: number): number {
    if (error instanceof HttpException) return error.getStatus();
    return error ? 500 : responseStatus;
  }
}
