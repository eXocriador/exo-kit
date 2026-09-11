import { describe, it, expect, vi } from 'vitest';
import { createLogger } from '../src/log/index.js';

/**
 * Two things matter here and neither is "pino logs".
 *
 * The first is that `service` comes from the caller. A default would be copied
 * between products and then read as fact — the exact failure this factory
 * replaces, where a second product shipped every log line under the first
 * product's name and its stream, and nothing anywhere said so.
 *
 * The second is that shipping is optional, best-effort, and cannot take a
 * request path down with it.
 */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      for (const line of text.split('\n').filter(Boolean)) {
        try {
          lines.push(JSON.parse(line));
        } catch {
          /* not a pino line */
        }
      }
      return true;
    });
  return { lines, restore: () => spy.mockRestore() };
}

describe('service name', () => {
  it('is stamped on every record from the caller’s config', () => {
    const { lines, restore } = capture();
    createLogger({ service: 'alpha-web', level: 'debug' }).logInfo('boot');
    restore();
    expect(lines.at(-1)).toMatchObject({ service: 'alpha-web', event: 'boot' });
  });

  it('is whatever the caller said — two loggers do not share one', () => {
    const { lines, restore } = capture();
    createLogger({ service: 'alpha-web' }).logInfo('a');
    createLogger({ service: 'beta-web' }).logInfo('b');
    restore();
    const services = lines.map((l) => l['service']);
    expect(services).toContain('alpha-web');
    expect(services).toContain('beta-web');
  });
});

describe('levels', () => {
  it('logError renders an Error as message plus stack', () => {
    const { lines, restore } = capture();
    createLogger({ service: 's' }).logError('failed', new Error('boom'), { where: 'x' });
    restore();
    const rec = lines.at(-1)!;
    expect(rec).toMatchObject({ event: 'failed', err: 'boom', where: 'x' });
    expect(String(rec['stack'])).toContain('boom');
  });

  it('logError accepts a non-Error without throwing', () => {
    const { lines, restore } = capture();
    createLogger({ service: 's' }).logError('failed', 'just a string');
    restore();
    expect(lines.at(-1)).toMatchObject({ err: 'just a string' });
  });

  it('logDebug is silent at the default production level', () => {
    const { lines, restore } = capture();
    createLogger({ service: 's', level: 'info' }).logDebug('noisy');
    restore();
    expect(lines.find((l) => l['event'] === 'noisy')).toBeUndefined();
  });
});

describe('audit records', () => {
  it('carry the reader/target pair that makes the trail answerable', () => {
    const { lines, restore } = capture();
    createLogger({ service: 's' }).logAudit({
      event: 'admin_read',
      path: '/api/admin/users',
      method: 'GET',
      userId: 'admin-1',
      targetUserId: 'user-9',
      ip: '10.0.0.1',
    });
    restore();
    expect(lines.at(-1)).toMatchObject({
      event: 'admin_read',
      userId: 'admin-1',
      targetUserId: 'user-9',
    });
  });

  /**
   * The open shape is deliberate. One product's record carries a capability
   * name, another's a conversation id. Closing it would mean either listing
   * every product's vocabulary in the kit, or every product keeping its own
   * copy of this function — which is how the two copies drifted in the first
   * place.
   */
  it('pass product-specific fields through untouched', () => {
    const { lines, restore } = capture();
    createLogger({ service: 's' }).logAudit({
      event: 'privileged_call',
      path: '/api/x',
      method: 'POST',
      userId: null,
      ip: '::1',
      capability: 'osint.lookup',
      conversationId: 42,
    });
    restore();
    expect(lines.at(-1)).toMatchObject({ capability: 'osint.lookup', conversationId: 42 });
  });
});

describe('OpenObserve shipping', () => {
  it('is off when no endpoint is configured, and nothing is buffered', async () => {
    const fetchImpl = vi.fn();
    const { restore } = capture();
    const log = createLogger({ service: 's', fetchImpl: fetchImpl as unknown as typeof fetch });
    log.logInfo('a');
    await log.flush();
    restore();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is off when an endpoint is given with no credentials', async () => {
    const fetchImpl = vi.fn();
    const { restore } = capture();
    const log = createLogger({
      service: 's',
      openobserve: { url: 'http://oo:5080', stream: 's' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    log.logInfo('a');
    await log.flush();
    restore();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the batch to the configured org and stream', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response('{}', { status: 200 }));
    const { restore } = capture();
    const log = createLogger({
      service: 's',
      openobserve: { url: 'http://oo:5080', org: 'acme', stream: 'alpha', token: 'dGVzdA==' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    log.logWarn('slow', { ms: 900 });
    await log.flush();
    restore();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://oo:5080/api/acme/alpha/_json');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>[];
    expect(body[0]).toMatchObject({ level: 'warn', event: 'slow', ms: 900 });
    expect(body[0]!['_timestamp']).toEqual(expect.any(Number));
  });

  it('defaults the org but never the stream', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response('{}', { status: 200 }));
    const { restore } = capture();
    const log = createLogger({
      service: 's',
      openobserve: { url: 'http://oo:5080', stream: 'alpha', email: 'a@b.c', password: 'x' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    log.logInfo('a');
    await log.flush();
    restore();
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://oo:5080/api/default/alpha/_json');
  });

  it('does not ship debug lines', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response('{}', { status: 200 }));
    const { restore } = capture();
    const log = createLogger({
      service: 's',
      level: 'debug',
      openobserve: { url: 'http://oo:5080', stream: 'alpha', token: 'x' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    log.logDebug('noisy');
    await log.flush();
    restore();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /** A logging-sink failure must never affect the request path. */
  it('swallows a sink that rejects', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => {
      throw new Error('sink down');
    });
    const { restore } = capture();
    const log = createLogger({
      service: 's',
      openobserve: { url: 'http://oo:5080', stream: 'alpha', token: 'x' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    log.logInfo('a');
    await expect(log.flush()).resolves.toBeUndefined();
    restore();
  });

  it('flushes early once maxBatch records are buffered', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response('{}', { status: 200 }));
    const { restore } = capture();
    const log = createLogger({
      service: 's',
      openobserve: { url: 'http://oo:5080', stream: 'alpha', token: 'x', maxBatch: 2 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    log.logInfo('a');
    expect(fetchImpl).not.toHaveBeenCalled();
    log.logInfo('b');
    await Promise.resolve();
    restore();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
