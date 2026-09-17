import { describe, it, expect, vi } from 'vitest';
import { createEmbedder } from '../src/llm/index.js';

type FetchArgs = Parameters<typeof fetch>;

const ok = (body: unknown, status = 200) =>
  vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify(body), { status }));

describe('createEmbedder', () => {
  it('returns the vector', async () => {
    const embed = createEmbedder({
      model: 'bge-m3',
      fetchImpl: ok({ embedding: [0.1, 0.2] }) as unknown as typeof fetch,
    });
    expect(await embed('text')).toEqual([0.1, 0.2]);
  });

  it('returns null on an empty or non-numeric vector rather than a broken one', async () => {
    const empty = createEmbedder({ model: 'm', fetchImpl: ok({ embedding: [] }) as unknown as typeof fetch });
    expect(await empty('t')).toBeNull();
    const junk = createEmbedder({ model: 'm', fetchImpl: ok({ embedding: ['a'] }) as unknown as typeof fetch });
    expect(await junk('t')).toBeNull();
  });

  it('returns null, never throws, when the backend is down', async () => {
    const embed = createEmbedder({
      model: 'm',
      fetchImpl: (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch,
    });
    await expect(embed('t')).resolves.toBeNull();
  });
});
