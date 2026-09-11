import { describe, it, expect, vi } from 'vitest';
import { createLlm, resolveProviderName, createEmbedder, flattenConversation } from '../src/llm/index.js';

type FetchArgs = Parameters<typeof fetch>;

const ok = (body: unknown, status = 200) =>
  vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify(body), { status }));

describe('resolveProviderName', () => {
  it('accepts the four known names, case-insensitively', () => {
    expect(resolveProviderName('Ollama')).toBe('ollama');
    expect(resolveProviderName(' anthropic ')).toBe('anthropic');
    expect(resolveProviderName('openai')).toBe('openai');
    expect(resolveProviderName('vibeconduit')).toBe('vibeconduit');
  });

  it('resolves a caller-supplied legacy alias', () => {
    expect(resolveProviderName('hermes', { aliases: { hermes: 'vibeconduit' } })).toBe('vibeconduit');
  });

  it('uses the fallback only when the value is absent', () => {
    expect(resolveProviderName(undefined, { fallback: 'ollama' })).toBe('ollama');
    expect(resolveProviderName('', { fallback: 'ollama' })).toBe('ollama');
  });

  /**
   * Failing loud beats falling back. A silent default would have
   * `isAvailable()` report some OTHER backend's liveness, so callers never
   * take the graceful AI-offline path even though the intended provider is
   * down — the failure looks like "the model answered nothing", forever.
   */
  it('throws on an unrecognised name even when a fallback exists', () => {
    expect(() => resolveProviderName('gpt5', { fallback: 'ollama' })).toThrow(/unrecognized/);
  });

  it('throws when there is neither a value nor a fallback', () => {
    expect(() => resolveProviderName(null)).toThrow();
  });
});

describe('ollama', () => {
  it('reads the answer out of the chat response', async () => {
    const fetchImpl = ok({ message: { content: '  hi  ' } });
    const llm = createLlm({ provider: 'ollama', model: 'm', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await llm.generate('q')).toBe('hi');
  });

  it('sends the role-tagged message list natively, not a flattened prompt', async () => {
    const fetchImpl = ok({ message: { content: 'x' } });
    const llm = createLlm({ provider: 'ollama', model: 'm', fetchImpl: fetchImpl as unknown as typeof fetch });
    await llm.chat([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ]);
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body));
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('answers null and reports on a non-ok status', async () => {
    const reportError = vi.fn();
    const llm = createLlm({
      provider: 'ollama',
      model: 'm',
      reportError,
      fetchImpl: ok({}, 500) as unknown as typeof fetch,
    });
    expect(await llm.generate('q')).toBeNull();
    expect(reportError.mock.calls[0]![1]).toMatchObject({ event: 'llm.ollama.request_failed' });
  });

  it('answers null — never throws — when the request errors out', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const llm = createLlm({ provider: 'ollama', model: 'm', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(llm.generate('q')).resolves.toBeNull();
  });

  /**
   * The graceful AI-offline path hinges on isAvailable() answering false the
   * moment the backend is unreachable and true when it answers — without ever
   * throwing.
   */
  it('isAvailable is true when the probe answers ok', async () => {
    const llm = createLlm({ provider: 'ollama', model: 'm', fetchImpl: ok({ models: [] }) as unknown as typeof fetch });
    expect(await llm.isAvailable()).toBe(true);
  });

  it('isAvailable is false on a non-ok status, an error and a timeout', async () => {
    const bad = createLlm({ provider: 'ollama', model: 'm', fetchImpl: ok({}, 500) as unknown as typeof fetch });
    expect(await bad.isAvailable()).toBe(false);

    const thrown = createLlm({
      provider: 'ollama',
      model: 'm',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(await thrown.isAvailable()).toBe(false);

    const timedOut = createLlm({
      provider: 'ollama',
      model: 'm',
      fetchImpl: (async () => {
        throw new DOMException('Aborted', 'TimeoutError');
      }) as unknown as typeof fetch,
    });
    expect(await timedOut.isAvailable()).toBe(false);
  });
});

describe('anthropic', () => {
  it('splits system turns into the top-level field the Messages API expects', async () => {
    const fetchImpl = ok({ content: [{ type: 'text', text: 'answer' }] });
    const llm = createLlm({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-haiku-4-5-20251001',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(
      await llm.chat([
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ]),
    ).toBe('answer');
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body));
    expect(body.system).toBe('be terse');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('picks the first text block, ignoring other block types', async () => {
    const llm = createLlm({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'm',
      fetchImpl: ok({ content: [{ type: 'thinking' }, { type: 'text', text: 'real' }] }) as unknown as typeof fetch,
    });
    expect(await llm.generate('q')).toBe('real');
  });

  it('refuses and reports with no key configured', async () => {
    const reportError = vi.fn();
    const fetchImpl = ok({});
    const llm = createLlm({
      provider: 'anthropic',
      apiKey: '',
      model: 'm',
      reportError,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await llm.generate('q')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reportError.mock.calls[0]![1]).toMatchObject({ event: 'llm.anthropic.no_api_key' });
    expect(await llm.isAvailable()).toBe(false);
  });
});

describe('openai', () => {
  it('reads choices.0.message.content', async () => {
    const llm = createLlm({
      provider: 'openai',
      apiKey: 'k',
      model: 'm',
      fetchImpl: ok({ choices: [{ message: { content: 'answer' } }] }) as unknown as typeof fetch,
    });
    expect(await llm.generate('q')).toBe('answer');
  });

  it('answers null on a shape it did not expect, rather than throwing', async () => {
    const llm = createLlm({
      provider: 'openai',
      apiKey: 'k',
      model: 'm',
      fetchImpl: ok({ choices: 'surprise' }) as unknown as typeof fetch,
    });
    expect(await llm.generate('q')).toBeNull();
  });
});

describe('vibeconduit', () => {
  it('retries the fallback model on 429 and returns its answer', async () => {
    const logWarn = vi.fn();
    let call = 0;
    const fetchImpl = vi.fn(async (..._args: FetchArgs) => {
      call += 1;
      return call === 1
        ? new Response('{}', { status: 429 })
        : new Response(JSON.stringify({ choices: [{ message: { content: 'second' } }] }), { status: 200 });
    });
    const llm = createLlm({
      provider: 'vibeconduit',
      apiKey: 'k',
      model: 'primary',
      fallbackModel: 'backup',
      logWarn,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await llm.generate('q')).toBe('second');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchImpl.mock.calls[1]![1] as RequestInit).body)).model).toBe('backup');
    expect(logWarn).toHaveBeenCalledWith('llm.vibeconduit.primary_exhausted', {
      model: 'primary',
      fallback: 'backup',
    });
  });

  it('does not retry when the fallback is disabled', async () => {
    const fetchImpl = ok({}, 429);
    const llm = createLlm({
      provider: 'vibeconduit',
      apiKey: 'k',
      model: 'primary',
      fallbackModel: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await llm.generate('q')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the fallback is the same model', async () => {
    const fetchImpl = ok({}, 429);
    const llm = createLlm({
      provider: 'vibeconduit',
      apiKey: 'k',
      model: 'same',
      fallbackModel: 'same',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await llm.generate('q');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /**
   * An unauthenticated gateway to a paid model is an unattributable channel
   * for anything that can reach it — and every prompt a product sends goes
   * through it. Under requireKey the refusal has to hold on both the call path
   * and the probe, or a caller takes the healthy path to a silent null.
   */
  it('refuses to call, and reports itself offline, with requireKey and no key', async () => {
    const fetchImpl = ok({});
    const llm = createLlm({
      provider: 'vibeconduit',
      apiKey: '',
      model: 'm',
      requireKey: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await llm.generate('q')).toBeNull();
    expect(await llm.isAvailable()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows a keyless call when requireKey is off (local development)', async () => {
    const fetchImpl = ok({ choices: [{ message: { content: 'x' } }] });
    const llm = createLlm({
      provider: 'vibeconduit',
      apiKey: '',
      model: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await llm.generate('q')).toBe('x');
  });
});

describe('createLlm', () => {
  it('exposes the active provider and its default model', () => {
    const llm = createLlm({ provider: 'ollama', model: 'gemma4:26b' });
    expect(llm.providerName).toBe('ollama');
    expect(llm.activeModel).toBe('gemma4:26b');
  });

  it('prefers the provider’s native chat when it has one', async () => {
    const fetchImpl = ok({ message: { content: 'native' } });
    const llm = createLlm({ provider: 'ollama', model: 'm', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await llm.chat([{ role: 'user', content: 'hi' }])).toBe('native');
    expect(fetchImpl.mock.calls[0]![0]).toMatch(/\/api\/chat$/);
  });
});

describe('flattenConversation', () => {
  it('labels user and assistant turns but leaves system instructions bare', () => {
    expect(
      flattenConversation([
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'more' },
      ]),
    ).toBe('be terse\n\nUser: hi\n\nAssistant: hello\n\nUser: more');
  });

  it('is the empty string for an empty conversation', () => {
    expect(flattenConversation([])).toBe('');
  });
});

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
