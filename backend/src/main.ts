import { Logger, LogLevel, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const configuredLogLevel = config.getOrThrow<string>('LOG_LEVEL');
  app.useLogger(logLevels(configuredLogLevel));
  app.flushLogs();

  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
  app.enableCors({
    origin: config.getOrThrow<string>('FRONTEND_ORIGIN'),
  });

  const port = config.getOrThrow<number>('BACKEND_PORT');
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(
    `backend.started port=${port} prefix=v1 logLevel=${configuredLogLevel}`,
  );
  logger.debug(
    `backend.configured corsOrigin=${config.getOrThrow<string>('FRONTEND_ORIGIN')}`,
  );
}

void bootstrap();

function logLevels(configuredLevel: string): LogLevel[] {
  switch (configuredLevel) {
    case 'error':
      return ['error'];
    case 'warn':
      return ['error', 'warn'];
    case 'info':
      return ['error', 'warn', 'log'];
    default:
      return ['error', 'warn', 'log', 'debug'];
  }
}
