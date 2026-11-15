/** Final names are scoped by release tag, never renamed after hashing. */
export function binaryName(kind, target, platform = process.platform, arch = process.arch) {
  if (target) [, platform, arch] = target.split('-');
  const os = { darwin: 'macos', win32: 'windows', windows: 'windows', linux: 'linux' }[platform];
  if (!os || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported binary platform or architecture');
  return kind === 'kiln' ? `kiln${os === 'windows' ? '.exe' : ''}` : `tinder-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
}
