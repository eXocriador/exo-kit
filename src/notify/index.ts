/**
 * `@exo/kit/notify` — getting an escalation to a human.
 *
 * ── What importing this pulls in ──
 * Nothing. The Telegram leg is one `fetch`; the email leg is a function the
 * product hands in (typically `sendEmail` from `@exo/kit/mailer`, which is a
 * type-only import here).
 *
 * ── Why two legs and this order ──
 * A support plan that promises "escalation to a real human, 24/7" has to
 * actually reach one. A Telegram DM is primary because it is durable and
 * reaches a phone; email is the fallback when Telegram is unconfigured or the
 * send fails. Both are optional infrastructure — unset means no-op, never an
 * error — and neither may delay the webhook that raised the escalation beyond
 * its own timeout, nor fail it. `notifyEscalation` therefore never throws.
 *
 * ── What the caller supplies, and why the kit will not assemble it ──
 * The recipient (`to`) and the link a human opens (`conversationUrl`). Which
 * inbox an installation escalates to is the product's business; which account
 * a conversation lives in is a property of the product too, and a copy of this
 * module that built the link itself from an env var nobody set would have
 * emitted `/app/accounts//conversations/123` on every notice it sent. So the
 * kit takes the URL or takes `null`, and with `null` the notice names the
 * conversation number instead of pointing at nowhere.
 */
import type { ReportError } from '../infra/types.js';
import type { EmailMessage } from '../mailer/index.js';

export interface TelegramDmConfig {
  /** Bot token from @BotFather. Empty means "not configured". */
  botToken: string | null | undefined;
  /** The chat that receives the DM — an owner's private chat id. Empty means "not configured". */
  chatId: string | number | null | undefined;
  /** Fires with `event: 'notify.telegram_failed'` and the status in `fields`. Never carries the token. */
  reportError?: ReportError;
  /** Per-request ceiling. Default 10 s. */
  timeoutMs?: number;
  /** Injected for tests. Default: the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface TelegramDm {
  enabled(): boolean;
  /** Best-effort: `false` when not configured, refused, or unreachable. Never throws. */
  send(text: string): Promise<boolean>;
}

export function createTelegramDm(config: TelegramDmConfig): TelegramDm {
  const botToken = config.botToken ?? '';
  const chatId = config.chatId === null || config.chatId === undefined ? '' : String(config.chatId);
  const timeoutMs = config.timeoutMs ?? 10_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  const enabled = Boolean(botToken && chatId);

  return {
    enabled: () => enabled,
    async send(text) {
      if (!enabled) return false;
      try {
        const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Previews off: an escalation carries a link into the support tool,
          // and a preview of that page in a chat is a leak with no reader.
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          config.reportError?.(new Error(`telegram responded ${res.status}`), {
            component: 'notify',
            event: 'notify.telegram_failed',
            fields: { status: res.status },
          });
          return false;
        }
        return true;
      } catch (err) {
        config.reportError?.(err, { component: 'notify', event: 'notify.telegram_failed' });
        return false;
      }
    },
  };
}

export interface EscalationNotice {
  /** Where the email leg goes — the inbox a person watches. */
  to: string;
  conversationId: number;
  category: string;
  reason: string | null;
  /** Shadow mode: the customer was never answered. Prefixes the notice so a human reads it as such. */
  shadow: boolean;
  /**
   * Where a human opens this conversation. `null` when the installation has
   * nothing to build one from; the notice then names the number.
   */
  conversationUrl: string | null;
}

export interface EscalationNotifierConfig {
  /** The primary leg, or `null` when this installation has none. */
  telegram: TelegramDm | null;
  /**
   * The fallback leg — `sendEmail` from `@exo/kit/mailer`, or anything with
   * that shape. `null` when this installation has none.
   */
  sendEmail: ((msg: EmailMessage) => Promise<boolean>) | null;
  /** Fires with `event: 'notify.email_failed'` if the email leg THROWS — which a kit mailer never does. */
  reportError?: ReportError;
}

export interface EscalationNotifier {
  /**
   * Telegram first; email only when Telegram did not go out. Resolves once
   * both legs have had their chance. Never throws.
   */
  notifyEscalation(notice: EscalationNotice): Promise<void>;
}

export function createEscalationNotifier(config: EscalationNotifierConfig): EscalationNotifier {
  return {
    async notifyEscalation(notice) {
      const prefix = notice.shadow ? '[shadow] ' : '';
      const headline = `${prefix}Support escalation — ${notice.category}`;
      const lines = [
        headline,
        notice.reason ? `Reason: ${notice.reason}` : null,
        notice.conversationUrl ?? `Conversation #${notice.conversationId}`,
      ].filter((l): l is string => Boolean(l));
      const text = lines.join('\n');

      if (config.telegram && (await config.telegram.send(text))) return;
      if (!config.sendEmail) return;

      try {
        await config.sendEmail({ to: notice.to, subject: headline, text });
      } catch (err) {
        config.reportError?.(err, {
          component: 'notify',
          event: 'notify.email_failed',
          fields: { category: notice.category },
        });
      }
    },
  };
}
