import { describe, it, expect, vi } from 'vitest';
import { createTelegramDm, createEscalationNotifier } from '../src/notify/index.js';
import type { EscalationNotice } from '../src/notify/index.js';
import type { EmailMessage } from '../src/mailer/index.js';

type FetchArgs = Parameters<typeof fetch>;

/**
 * An escalation is the moment a plan's "a real human, 24/7" promise has to be
 * kept, so the notice has two legs and a strict order: Telegram reaches a
 * phone, email is the fallback when Telegram is unconfigured or fails. Both
 * legs are optional infrastructure — unset means no-op, never an error — and
 * the whole thing must never delay or fail the webhook that called it.
 *
 * The one behaviour that changed on the way into the kit is the link: the
 * caller supplies `conversationUrl`, and when it has none the notice names the
 * conversation number rather than pointing at `/app/accounts//conversations/N`.
 */
const respond = (status: number) =>
  vi.fn(async (..._args: FetchArgs) => new Response(status === 200 ? '{"ok":true}' : '{"ok":false}', { status }));

const telegramConfigured = (fetchImpl: ReturnType<typeof respond>, reportError = vi.fn()) =>
  createTelegramDm({
    botToken: '123456:token',
    chatId: '42',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    reportError,
  });

const notice = {
  to: 'support@alpha.example',
  conversationId: 123,
  category: 'billing',
  reason: 'Customer asked for a refund past the window',
  shadow: false,
  conversationUrl: 'https://chat.alpha.example/app/accounts/1/conversations/123',
};

describe('createTelegramDm', () => {
  it('is disabled with either half missing and then sends nothing', async () => {
    const fetchImpl = respond(200);
    const dm = createTelegramDm({ botToken: '', chatId: '42', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(dm.enabled()).toBe(false);
    expect(await dm.send('hello')).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createTelegramDm({ botToken: 'x', chatId: null }).enabled()).toBe(false);
  });

  it('posts sendMessage to the bot API with previews off', async () => {
    const fetchImpl = respond(200);
    const dm = telegramConfigured(fetchImpl);
    expect(await dm.send('hello')).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.telegram.org/bot123456:token/sendMessage');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: '42',
      text: 'hello',
      disable_web_page_preview: true,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('a refused request is false and reported once — with the status, never the token', async () => {
    const reportError = vi.fn();
    const dm = telegramConfigured(respond(401), reportError);
    expect(await dm.send('hello')).toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, ctx] = reportError.mock.calls[0]!;
    expect(ctx).toMatchObject({ component: 'notify', event: 'notify.telegram_failed', fields: { status: 401 } });
    expect(JSON.stringify(reportError.mock.calls[0])).not.toContain('123456:token');
  });

  it('a thrown fetch is false and reported, not rethrown', async () => {
    const reportError = vi.fn();
    const fetchImpl = vi.fn(async (..._args: FetchArgs) => {
      throw new Error('ENOTFOUND');
    });
    const dm = createTelegramDm({ botToken: 't', chatId: 'c', fetchImpl: fetchImpl as unknown as typeof fetch, reportError });
    expect(await dm.send('hello')).toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe('createEscalationNotifier — the two legs', () => {
  it('Telegram first, and when it goes out no email is sent', async () => {
    const sendEmail = vi.fn(async (_msg: EmailMessage) => true);
    const notifier = createEscalationNotifier({ telegram: telegramConfigured(respond(200)), sendEmail });
    await notifier.notifyEscalation(notice);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('falls back to email when Telegram is unconfigured', async () => {
    const sendEmail = vi.fn(async (_msg: EmailMessage) => true);
    const notifier = createEscalationNotifier({ telegram: null, sendEmail });
    await notifier.notifyEscalation(notice);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({
      to: 'support@alpha.example',
      subject: 'Support escalation — billing',
    });
  });

  it('falls back to email when Telegram fails', async () => {
    const sendEmail = vi.fn(async (_msg: EmailMessage) => true);
    const notifier = createEscalationNotifier({ telegram: telegramConfigured(respond(500)), sendEmail });
    await notifier.notifyEscalation(notice);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('is a no-op with neither leg, and still does not throw', async () => {
    const notifier = createEscalationNotifier({ telegram: null, sendEmail: null });
    await expect(notifier.notifyEscalation(notice)).resolves.toBeUndefined();
  });

  it('never lets the email leg throw into the webhook', async () => {
    const reportError = vi.fn();
    const sendEmail = vi.fn(async (_msg: EmailMessage) => {
      throw new Error('mailer exploded');
    });
    const notifier = createEscalationNotifier({ telegram: null, sendEmail, reportError });
    await expect(notifier.notifyEscalation(notice)).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ event: 'notify.email_failed' }));
  });
});

describe('createEscalationNotifier — the text', () => {
  const textSentTo = async (input: Partial<EscalationNotice>) => {
    const fetchImpl = respond(200);
    const notifier = createEscalationNotifier({ telegram: telegramConfigured(fetchImpl), sendEmail: null });
    await notifier.notifyEscalation({ ...notice, ...input });
    return JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)).text as string;
  };

  it('is the category, the reason, and the link — one per line', async () => {
    expect(await textSentTo({})).toBe(
      [
        'Support escalation — billing',
        'Reason: Customer asked for a refund past the window',
        'https://chat.alpha.example/app/accounts/1/conversations/123',
      ].join('\n'),
    );
  });

  it('drops the reason line when there is none', async () => {
    expect(await textSentTo({ reason: null })).toBe(
      ['Support escalation — billing', 'https://chat.alpha.example/app/accounts/1/conversations/123'].join('\n'),
    );
  });

  it('names the conversation number when the caller has no URL — never a link to nowhere', async () => {
    // This is the line that used to read `/app/accounts//conversations/123`
    // in an installation whose env did not set an account id. The kit does not
    // build the link at all: which account a conversation lives in is a
    // property of the product, so the caller passes the URL or passes null.
    const text = await textSentTo({ conversationUrl: null });
    expect(text.split('\n').at(-1)).toBe('Conversation #123');
    expect(text).not.toContain('/app/accounts/');
  });

  it('prefixes a shadow-mode notice on both the text and the email subject', async () => {
    expect((await textSentTo({ shadow: true })).split('\n')[0]).toBe('[shadow] Support escalation — billing');

    const sendEmail = vi.fn(async (_msg: EmailMessage) => true);
    const notifier = createEscalationNotifier({ telegram: null, sendEmail });
    await notifier.notifyEscalation({ ...notice, shadow: true });
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({
      subject: '[shadow] Support escalation — billing',
      text: expect.stringMatching(/^\[shadow\] Support escalation — billing\n/),
    });
  });
});
