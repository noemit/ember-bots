import { Arch } from 'builder-util';
const targetArchitectures = new WeakMap();

/** Builder's AppImage ${arch} macro spells x64 as x86_64. Set its target option
 * before artifact construction/hashing, using the requested architecture (never the host).
 * Other targets keep their native ${arch} patterns. No output is renamed.
 */
export default function beforePack(context) {
  if (context.electronPlatformName !== 'linux') return;
  for (const target of context.targets) {
    if (target.name !== 'appImage') continue;
    const arch = Arch[context.arch];
    if (!['x64', 'arm64'].includes(arch)) throw new Error(`Review the release contract before packaging AppImage for ${arch}.`);
    const previous = targetArchitectures.get(target);
    if (previous !== undefined && previous !== arch) throw new Error('Build each AppImage architecture separately in a clean directory; shared target options cannot safely name multiple architectures.');
    targetArchitectures.set(target, arch);
    target.options.artifactName = `Ember-linux-${arch}.AppImage`;
  }
}
