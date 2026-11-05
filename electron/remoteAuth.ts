import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Remote-access password hashing.
 *
 * `scrypt` is deliberately the async form: the sync one blocks the Electron main thread for
 * ~140ms per attempt, which freezes the desktop UI and every event stream while a login is
 * being checked. The failure mode was measured at 8 attempts per rate-limit window, so the
 * sync version was a stall an unauthenticated peer could ask for.
 */
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>;

/** Long enough for a passphrase, short enough that hashing it is not a denial-of-service lever. */
export const MAX_REMOTE_PASSWORD_LENGTH = 256;
export const MIN_REMOTE_PASSWORD_LENGTH = 8;

export const hashRemotePassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, 32);
  return `scrypt$${salt}$${hash.toString('hex')}`;
};

export const verifyRemotePassword = async (password: string, stored: unknown): Promise<boolean> => {
  if (typeof stored !== 'string') return false;
  if (typeof password !== 'string' || password.length > MAX_REMOTE_PASSWORD_LENGTH) return false;
  const [algorithm, salt, expected] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !expected || !/^[0-9a-f]{64}$/i.test(expected)) return false;
  try {
    const actual = await scryptAsync(password, salt, 32);
    const target = Buffer.from(expected, 'hex');
    return actual.length === target.length && timingSafeEqual(actual, target);
  } catch {
    return false;
  }
};
