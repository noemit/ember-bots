import { describe, expect, test } from 'bun:test';
import { piEntriesToMessages, type PiEntry } from '../src/lib/piMapping';
import { decodeBase64Bytes, detectImageMimeType, imageContentDigest } from '../src/lib/imageIdentity';
import { outgoingMessageSignature, reconcileFullTranscript, reconcileTranscriptAppend, reconcileTranscriptTail } from '../src/lib/transcriptReconciliation';
import type { ChatMessage, FileAttachment } from '../src/types';

const optimistic = (id: string, text: string, files: FileAttachment[]): ChatMessage => ({
  id, role: 'user', text, completed: true,
  parts: [
    ...(text ? [{ type: 'text' as const, id: `${id}-text`, text }] : []),
    ...files.map((file, i) => ({ type: 'file' as const, id: `${id}-file-${i}`, file })),
  ],
});
const piUser = (id: number, text: string, images: Array<{ data: string; mimeType: string }>): PiEntry => ({
  id, kind: 'pi.user', model: [{ role: 'user', timestamp: id * 1000, content: [
    ...(text ? [{ type: 'text', text }] : []),
    ...images.map(({ data, mimeType }) => ({ type: 'image', data, mimeType })),
  ] }],
});
const localFile = (filename: string, data: string, mime = 'image/png'): FileAttachment => ({
  filename, mime, url: `data:${mime};base64,${data}`,
});

describe('image send reconciliation', () => {
  test('mapped Hearth entry reconciles the original upload despite its generic display filename', () => {
    const sent = optimistic('client-1', 'inspect this', [localFile('screenshot-final.png', 'payload-A')]);
    const [mapped] = piEntriesToMessages([piUser(7, 'inspect this', [{ data: 'payload-A', mimeType: 'image/png' }])]);
    expect(mapped.parts.find((part) => part.type === 'file')?.file.filename).toBe('image.png');
    expect(outgoingMessageSignature(sent)).toBe(outgoingMessageSignature(mapped));
    const result = reconcileFullTranscript([sent], [mapped], new Set([sent.id]));
    expect(result.reconciledOptimisticIds).toEqual([sent.id]);
    expect(result.messages.map((message) => message.id)).toEqual(['e7']);
  });

  test('canonicalizes permissive base64 variants to the bytes Kiln decodes', () => {
    // Node/Kiln accept non-zero unused padding bits: both decode to byte 0x01.
    const a = optimistic('a', 'same', [localFile('a.png', 'AQ==')]);
    const b = optimistic('b', 'same', [localFile('b.png', 'AR==')]);
    expect(decodeBase64Bytes('AQ==')).toEqual(decodeBase64Bytes('AR=='));
    expect(decodeBase64Bytes('A!Q== \n')).toEqual(decodeBase64Bytes('AQ=='));
    expect(imageContentDigest('image/png', 'AQ==')).toBe(imageContentDigest('image/png', 'AR=='));
    expect(outgoingMessageSignature(a)).toBe(outgoingMessageSignature(b));
    const [echo] = piEntriesToMessages([piUser(8, 'same', [{ data: 'AR==', mimeType: 'image/png' }])]);
    const result = reconcileFullTranscript([a], [echo], new Set([a.id]));
    expect(result.reconciledOptimisticIds).toEqual([a.id]);
    expect(result.messages.map((message) => message.id)).toEqual(['e8']);
  });

  test('same text with different bytes and image-only messages stay distinct', () => {
    const a = optimistic('a', 'same', [localFile('one.png', 'AQ==')]);
    const b = optimistic('b', 'same', [localFile('two.png', 'Ag==')]);
    expect(outgoingMessageSignature(a)).not.toBe(outgoingMessageSignature(b));
    const imageOnlyA = optimistic('ia', '', [localFile('one.png', 'AQ==')]);
    const imageOnlyB = optimistic('ib', '', [localFile('two.png', 'Ag==')]);
    expect(outgoingMessageSignature(imageOnlyA)).not.toBe(outgoingMessageSignature(imageOnlyB));
    expect(outgoingMessageSignature(imageOnlyA)).not.toBeNull();
  });

  test('an unsupported payload keeps the supplied MIME while valid sniffed image formats replace it', () => {
    const sent = optimistic('mime', 'inspect', [localFile('upload.jpg', 'AQ==', 'image/jpeg')]);
    const [echo] = piEntriesToMessages([piUser(9, 'inspect', [{ data: 'AQ==', mimeType: 'image/png' }])]);
    expect(outgoingMessageSignature(sent)).not.toBe(outgoingMessageSignature(echo));

    const pngBytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const mislabeled = optimistic('valid-mime', 'inspect', [localFile('upload.jpg', pngBytes, 'image/jpeg')]);
    const [sniffed] = piEntriesToMessages([piUser(10, 'inspect', [{ data: pngBytes, mimeType: 'image/png' }])]);
    expect(detectImageMimeType(decodeBase64Bytes(pngBytes))).toBe('image/png');
    expect(outgoingMessageSignature(mislabeled)).toBe(outgoingMessageSignature(sniffed));
  });

  test('multiple images are ordered, exact payloads matter, repeated sends pair one-for-one', () => {
    const f1 = localFile('a.png', 'first');
    const f2 = localFile('b.png', 'second');
    const first = optimistic('send-1', 'look', [f1, f2]);
    const reordered = optimistic('server-reordered', 'look', [f2, f1]);
    expect(outgoingMessageSignature(first)).not.toBe(outgoingMessageSignature(reordered));

    const repeat1 = optimistic('repeat-1', 'again', [f1]);
    const repeat2 = optimistic('repeat-2', 'again', [f1]);
    const [echo1, echo2] = piEntriesToMessages([
      piUser(10, 'again', [{ data: 'first', mimeType: 'image/png' }]),
      piUser(11, 'again', [{ data: 'first', mimeType: 'image/png' }]),
    ]);
    const result = reconcileFullTranscript([repeat1, repeat2], [echo1, echo2], new Set([repeat1.id, repeat2.id]));
    expect(result.reconciledOptimisticIds).toEqual([repeat1.id, repeat2.id]);
    expect(result.messages.map((message) => message.id)).toEqual(['e10', 'e11']);
  });

  test('tail and late append reconcile byte-identical image echoes without retaining stale bubbles', () => {
    const sent = optimistic('late', 'photo', [localFile('original-name.png', 'same-bytes')]);
    const [echo] = piEntriesToMessages([piUser(22, 'photo', [{ data: 'same-bytes', mimeType: 'image/png' }])]);
    const held = [optimistic('e21', 'previous', []), sent];
    const fetchedTail = [optimistic('e21', 'previous', []), echo];
    const tail = reconcileTranscriptTail(held, fetchedTail, new Set([sent.id]));
    expect(tail.reconciledOptimisticIds).toEqual([sent.id]);
    expect(tail.messages.map((message) => message.id)).toEqual(['e21', 'e22']);
    const append = reconcileTranscriptAppend([sent], [echo], new Set([sent.id]));
    expect(append.reconciledOptimisticIds).toEqual([sent.id]);
    expect(append.messages.map((message) => message.id)).toEqual(['e22']);
  });

  test('an older identical entry is not consumed; OpenChamber filenames retain compatibility', () => {
    const old = optimistic('old-server', 'same', [localFile('different-name.png', 'identical')]);
    const pending = optimistic('pending', 'same', [localFile('new-name.png', 'identical')]);
    const echo = optimistic('echo', 'same', [localFile('image.png', 'identical')]);
    const result = reconcileFullTranscript([old, pending], [old, echo], new Set([pending.id]));
    expect(result.reconciledOptimisticIds).toEqual([pending.id]);
    expect(result.messages.map((message) => message.id)).toEqual(['old-server', 'echo']);

    const openChamberA = optimistic('oc1', 'text', [{ filename: 'same.png', mime: 'image/png', url: 'file:///same.png' }]);
    const openChamberB = optimistic('oc2', 'text', [{ filename: 'same.png', mime: 'image/png', url: 'file:///other.png' }]);
    const openChamberDifferentName = optimistic('oc3', 'text', [{ filename: 'other.png', mime: 'image/png', url: 'file:///same.png' }]);
    expect(outgoingMessageSignature(openChamberA)).toBe(outgoingMessageSignature(openChamberB));
    expect(outgoingMessageSignature(openChamberA)).not.toBe(outgoingMessageSignature(openChamberDifferentName));
  });
});
