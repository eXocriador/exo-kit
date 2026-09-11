import { describe, it, expect, vi } from 'vitest';
import { createMailer, MailSendError, senderAddress, isOwnSender } from '../src/mailer/index.js';

type FetchArgs = Parameters<typeof fetch>;

/**
 * Three things are worth a test here, and "it posts JSON to Resend" is the
 * least of them.
 *
 * The first is that not configured is a state: a product with no key boots,
 * `mailerEnabled()` says so, and `sendEmail` answers `false` without a network
 * call. The second is that the best-effort path really is best-effort — a
 * refused request and a thrown one both come back as `false`, are reported
 * once, and never carry the recipient into a log line. The third is the strict
 * path: `send` throws a typed error with the status on it, because one product
 * wants to answer 202 either way and another wants to know.
 */
const respond = (status: number) =>
  vi.fn(async (..._args: FetchArgs) => new Response(status === 200 ? '{"id":"x"}' : '{"message":"no"}', { status }));

const configured = (over: Partial<Parameters<typeof createMailer>[0]> = {}) =>
  createMailer({
    apiKey: 're_test_key',
    from: '"Alpha Support" <no-reply@alpha.example>',
    ...over,
  });

const message = { to: 'someone@customer.example', subject: 'Hello', text: 'Body' };

describe('not configured is a state', () => {
  it('reports itself disabled with either half missing', () => {
    expect(createMailer({ apiKey: null, from: 'a@b.example' }).mailerEnabled()).toBe(false);
    expect(createMailer({ apiKey: 're_x', from: '' }).mailerEnabled()).toBe(false);
    expect(createMailer({ apiKey: undefined, from: undefined }).mailerEnabled()).toBe(false);
    expect(configured().mailerEnabled()).toBe(true);
  });

  it('sendEmail answers false without touching the network', async () => {
    const fetchImpl = respond(200);
    const mailer = createMailer({ apiKey: null, from: null, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await mailer.sendEmail(message)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('send throws a MailSendError with no status, and says why', async () => {
    const mailer = createMailer({ apiKey: null, from: null });
    await expect(mailer.send(message)).rejects.toBeInstanceOf(MailSendError);
    await expect(mailer.send(message)).rejects.toMatchObject({ status: null, reason: 'not_configured' });
  });
});

describe('the request', () => {
  it('posts the message to Resend with the bearer key and the configured sender', async () => {
    const fetchImpl = respond(200);
    const mailer = configured({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await mailer.sendEmail(message)).toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer re_test_key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      from: '"Alpha Support" <no-reply@alpha.example>',
      to: ['someone@customer.example'],
      subject: 'Hello',
      text: 'Body',
    });
    // A hung provider must not hold a request open indefinitely.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('includes html only when the caller gave one', async () => {
    const fetchImpl = respond(200);
    const mailer = configured({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await mailer.sendEmail({ ...message, html: '<p>Body</p>' });
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body));
    expect(body.html).toBe('<p>Body</p>');
  });
});

describe('best effort', () => {
  it('a refused request is false, reported once with the status, and never with the recipient', async () => {
    const reportError = vi.fn();
    const mailer = configured({ fetchImpl: respond(422) as unknown as typeof fetch, reportError });
    expect(await mailer.sendEmail(message)).toBe(false);

    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = reportError.mock.calls[0]!;
    expect(err).toBeInstanceOf(MailSendError);
    expect(ctx).toMatchObject({ component: 'mailer', event: 'mailer.send_failed' });
    expect(ctx.fields).toMatchObject({ status: 422, subject: 'Hello' });
    expect(JSON.stringify(ctx)).not.toContain('customer.example');
  });

  it('a thrown fetch is false and reported, not rethrown', async () => {
    const reportError = vi.fn();
    const fetchImpl = vi.fn(async (..._args: FetchArgs) => {
      throw new Error('ECONNRESET');
    });
    const mailer = configured({ fetchImpl: fetchImpl as unknown as typeof fetch, reportError });
    expect(await mailer.sendEmail(message)).toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({ event: 'mailer.send_failed' });
  });

  it('stays quiet when there is nobody to report to', async () => {
    const mailer = configured({ fetchImpl: respond(500) as unknown as typeof fetch });
    await expect(mailer.sendEmail(message)).resolves.toBe(false);
  });
});

describe('the strict path', () => {
  it('send resolves on success', async () => {
    const mailer = configured({ fetchImpl: respond(200) as unknown as typeof fetch });
    await expect(mailer.send(message)).resolves.toBeUndefined();
  });

  it('send throws with the provider status on it, and does not report — the caller has the error', async () => {
    const reportError = vi.fn();
    const mailer = configured({ fetchImpl: respond(403) as unknown as typeof fetch, reportError });
    const err = await mailer.send(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).status).toBe(403);
    expect((err as MailSendError).reason).toBe('refused');
    expect(reportError).not.toHaveBeenCalled();
  });

  it('send wraps a transport failure, keeping the cause', async () => {
    const boom = new Error('ETIMEDOUT');
    const fetchImpl = vi.fn(async (..._args: FetchArgs) => {
      throw boom;
    });
    const mailer = configured({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await mailer.send(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).reason).toBe('transport');
    expect((err as MailSendError).cause).toBe(boom);
  });
});

/**
 * The address we send from is the address our own notices arrive back from.
 * Two products learned that the hard way: a support inbox that is also the
 * escalation target receives its own escalation notice as a new "customer"
 * conversation, and an AI answers it. The guard is on the sender, and it must
 * match one address exactly — never a domain, never a substring — because a
 * false positive here is a real customer silently ignored.
 */
describe('recognising our own outbound address', () => {
  it('reads the address out of a display-name mailbox — the production format', () => {
    expect(senderAddress('"Alpha Support" <No-Reply@Alpha.example>')).toBe('no-reply@alpha.example');
    expect(isOwnSender('"Alpha Support" <no-reply@alpha.example>', 'no-reply@alpha.example')).toBe(true);
  });

  it('accepts a bare address configuration too', () => {
    expect(isOwnSender('no-reply@alpha.example', 'no-reply@alpha.example')).toBe(true);
  });

  it('ignores case and surrounding whitespace on both sides', () => {
    expect(isOwnSender('  No-Reply@Alpha.Example  ', ' no-reply@alpha.example ')).toBe(true);
  });

  it('does not match a different address at the same domain', () => {
    const from = '"Alpha Support" <no-reply@alpha.example>';
    expect(isOwnSender(from, 'customer@alpha.example')).toBe(false);
    expect(isOwnSender(from, 'no-reply@alpha.example.evil.test')).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(isOwnSender('no-reply@alpha.example', null)).toBe(false);
    expect(isOwnSender('no-reply@alpha.example', '')).toBe(false);
    expect(isOwnSender('', 'no-reply@alpha.example')).toBe(false);
    expect(isOwnSender(undefined, '')).toBe(false);
  });

  it('is bound to the instance too', () => {
    const mailer = configured();
    expect(mailer.senderAddress()).toBe('no-reply@alpha.example');
    expect(mailer.isOwnSender('no-reply@alpha.example')).toBe(true);
    expect(mailer.isOwnSender('other@alpha.example')).toBe(false);
  });
});
