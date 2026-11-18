import * as fs from 'node:fs';

const IGNORED_CHMOD_CODES = new Set([
  'ENOENT',
  'ENOSYS',
  'EPERM',
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
]);

/**
 * Enforce strict POSIX mode bits (`0o700` for directories, `0o600` for private files) even when a
 * path already existed with looser permissions or `umask` softened creation, while ignoring
 * unsupported `chmod` errors on Windows or exotic filesystems.
 */
export const tightenPermissions = (
  targetPath: string,
  mode: number,
  chmod: (path: string, mode: number) => void = fs.chmodSync
): void => {
  try {
    chmod(targetPath, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && IGNORED_CHMOD_CODES.has(code)) return;
    throw error;
  }
};

export const tightenPermissionsAsync = async (
  targetPath: string,
  mode: number,
  chmod: (path: string, mode: number) => Promise<void> = fs.promises.chmod
): Promise<void> => {
  try {
    await chmod(targetPath, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && IGNORED_CHMOD_CODES.has(code)) return;
    throw error;
  }
};
