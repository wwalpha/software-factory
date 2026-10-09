import pino from 'pino';
import { ensure } from '../domain/invariants.js';
export const logger = pino(
  {
    level: process.env.FACTORY_LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'token',
        'apiKey',
        'secret',
        'authorization',
        'req.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
  },
  pino.destination(2),
);
export function redact(text: string, secrets: string[] = []): string {
  let result = text
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
  for (const secret of secrets)
    if (secret.length >= 4) result = result.split(secret).join('[REDACTED]');
  return result;
}
export function rejectSecrets(value: unknown, secrets: string[]): void {
  if (typeof value === 'string')
    ensure(
      !secrets.some((s) => s.length >= 4 && value.includes(s)) &&
        !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value) &&
        !/\bsk-[A-Za-z0-9_-]{8,}\b/.test(value),
      'secret',
      'Secret material rejected at persistence boundary',
    );
  else if (Array.isArray(value))
    value.forEach((v) => rejectSecrets(v, secrets));
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) rejectSecrets(v, secrets);
    if (
      'content' in value &&
      'executable' in value &&
      typeof value.content === 'string'
    )
      rejectSecrets(
        Buffer.from(value.content, 'base64').toString('utf8'),
        secrets,
      );
  }
}
