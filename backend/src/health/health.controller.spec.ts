import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns a healthy backend status', () => {
    const result = new HealthController().getHealth();

    expect(result.service).toBe('backend');
    expect(result.status).toBe('ok');
    expect(result.timestamp).toBeDefined();
  });
});
