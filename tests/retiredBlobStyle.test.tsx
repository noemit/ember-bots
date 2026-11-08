import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { isBlobStyle, migrateBlobStyle } from '../electron/transport';
import Blob from '../src/blob/Blob';
import BuddyBlob from '../src/blob/BuddyBlob';
import ScribbleBlob from '../src/blob/ScribbleBlob';
import { loadBlobComponent } from '../src/blob/dockIcon';
import { ACTIVE_BLOB_STYLES, effectiveBlobStyle } from '../src/blob/styles';
import { allocateAvatar, identityShape } from '../src/blob/allocateIdentity';
import { BUDDY_SHAPES } from '../src/blob/buddy';
import { resolveAvatarIdentity, seedIdentity } from '../src/blob/seed';

test('retirement preserves the saved preference rather than migrating it', () => {
  expect(ACTIVE_BLOB_STYLES).not.toContain('scribble');
  expect(isBlobStyle('scribble')).toBe(true);
  expect(migrateBlobStyle('scribble')).toBe('scribble');
  const saved = { blobStyle: 'scribble' as const };
  expect(effectiveBlobStyle(saved.blobStyle)).toBe('buddy');
  expect(saved.blobStyle).toBe('scribble');
  for (const style of ACTIVE_BLOB_STYLES) expect(effectiveBlobStyle(style)).toBe(style);
});

test('renderer and dock use Buddy with preserved colours and safe shape fallbacks', async () => {
  expect(await loadBlobComponent('scribble')).toBe(BuddyBlob);
  for (const shapeName of ['thistle', 'cloud']) {
    const identity = resolveAvatarIdentity({ id: 'bot', instanceId: 'local', directory: '/project' }, [], {}, {
      'directory:local::/project': { color: '#551eb3', shapeName },
    });
    const original = JSON.stringify(identity);
    for (const mood of ['idle', 'busy', 'thinking', 'input', 'question', 'unread', 'error'] as const) {
      const actual = renderToStaticMarkup(<Blob style="scribble" identity={identity} seed="bot" mood={mood} />);
      expect(actual).toBe(renderToStaticMarkup(<Blob style="buddy" identity={identity} seed="bot" mood={mood} />));
      expect(actual).toContain('blob-buddy');
      expect(actual).not.toContain('blob-scribble');
      expect(actual).toContain('#551eb3');
    }
    expect(JSON.stringify(identity)).toBe(original);
  }
});

test('retired preferences allocate only effective Buddy silhouettes', () => {
  const peers = Array.from({ length: 8 }, (_, index) => seedIdentity('peer-' + index));
  const assignment = allocateAvatar('new-bot', peers, 'scribble');
  expect(assignment).toEqual(allocateAvatar('new-bot', peers, 'buddy'));
  const identity = { ...seedIdentity('new-bot'), ...assignment, shapeName: 'thistle' };
  expect(identityShape('scribble', identity)).toBe(identityShape('buddy', identity));
  expect(BUDDY_SHAPES.map(shape => shape.name)).toContain(identityShape('scribble', identity));
});

test('retired renderer remains available for development studies', () => {
  expect(renderToStaticMarkup(<ScribbleBlob seed="study" />)).toContain('blob-scribble');
});
