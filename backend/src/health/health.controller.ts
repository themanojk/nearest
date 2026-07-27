import { Controller, Get } from '@nestjs/common';

interface HealthResponse {
  service: 'backend';
  status: 'ok';
  timestamp: string;
}

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return {
      service: 'backend',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
