import {
  sanitizeErrorMessage,
  sanitizeForLogs,
} from './log-sanitizer';

describe('log sanitizer', () => {
  it('redacts credentials, personal data, signatures, and signed URLs', () => {
    expect(
      sanitizeForLogs({
        childId: 'child-1',
        password: 'super-secret',
        phone: { countryCode: '+91', number: '9999999999' },
        accessToken: 'jwt',
        nested: {
          signature: 'device-signature',
          url: 'http://storage/upload?X-Amz-Signature=secret',
        },
      }),
    ).toEqual({
      childId: 'child-1',
      password: '[REDACTED]',
      phone: '[REDACTED]',
      accessToken: '[REDACTED]',
      nested: {
        signature: '[REDACTED]',
        url: '[REDACTED]',
      },
    });
  });

  it('removes bearer tokens and signed query strings from errors', () => {
    expect(
      sanitizeErrorMessage(
        'Bearer abc.def failed at http://storage/file?X-Amz-Signature=secret',
      ),
    ).toBe(
      'Bearer [REDACTED] failed at http://storage/file?[REDACTED]',
    );
  });
});
