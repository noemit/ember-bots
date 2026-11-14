export class ConnectionResponseError extends Error {}

/** A test never retains a whole catalogue or waits indefinitely for a streaming response. */
export async function readConnectionJson(response: Response, maxBytes = 1024 * 1024, timeoutMs = 8_000): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DOMException('Connection test timed out', 'TimeoutError')), timeoutMs);
    timer.unref?.();
  });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), expired]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new ConnectionResponseError('Connection test response exceeded its limit');
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new ConnectionResponseError('Connection test response was not JSON'); }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

