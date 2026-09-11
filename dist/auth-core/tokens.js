import { createHash, randomBytes } from 'node:crypto';
export function createAuthTokens(config) {
    const query = config.query;
    const maxLength = config.maxTokenLength ?? 200;
    function tokenHash(raw) {
        return createHash('sha256').update(raw).digest('hex');
    }
    /**
     * Mint a token for a user+purpose and return the raw value (for the email
     * link), or null when the DB is unavailable. Unused older tokens of the same
     * purpose are dropped so only the most recent link works.
     */
    async function createAuthToken(userId, purpose, ttlSeconds) {
        const raw = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        const ok = await query(async (sql) => {
            await sql `
        DELETE FROM auth_tokens
        WHERE user_id = ${userId}::uuid AND purpose = ${purpose} AND used_at IS NULL
      `;
            await sql `
        INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at)
        VALUES (${tokenHash(raw)}, ${userId}::uuid, ${purpose}, ${expiresAt})
      `;
            return true;
        });
        return ok ? raw : null;
    }
    /**
     * Check a token's validity WITHOUT consuming it — used by a login-2FA step,
     * where a wrong code shouldn't burn the pending token (the user needs to be
     * able to retry within the TTL, not restart the whole login).
     */
    async function peekAuthToken(raw, purpose) {
        if (!raw || raw.length > maxLength)
            return null;
        const rows = await query(async (sql) => {
            return await sql `
        SELECT user_id::text AS user_id
        FROM auth_tokens
        WHERE token_hash = ${tokenHash(raw)}
          AND purpose = ${purpose}
          AND used_at IS NULL
          AND expires_at > NOW()
        LIMIT 1
      `;
        });
        const row = rows?.[0];
        return row ? { userId: row.user_id } : null;
    }
    /**
     * Atomically consume a token: valid + unexpired + unused → marks it used and
     * returns the owning user id; anything else → null. Single UPDATE, so a link
     * can never be redeemed twice even under concurrent requests.
     */
    async function consumeAuthToken(raw, purpose) {
        if (!raw || raw.length > maxLength)
            return null;
        const rows = await query(async (sql) => {
            return await sql `
        UPDATE auth_tokens
        SET used_at = NOW()
        WHERE token_hash = ${tokenHash(raw)}
          AND purpose = ${purpose}
          AND used_at IS NULL
          AND expires_at > NOW()
        RETURNING user_id::text AS user_id
      `;
        });
        const row = rows?.[0];
        return row ? { userId: row.user_id } : null;
    }
    /**
     * Same as consumeAuthToken, but runs the consume and a caller-supplied
     * follow-up write in ONE transaction. Without this, a token consumed via a
     * separate query stays consumed even if the follow-up write (setting the new
     * password, marking the email verified) then fails — permanently dead-ending
     * the link. Here, a failure in `onConsumed` rolls back the consume too.
     * `ok:false` (invalid/expired/already-used token) is distinguished from a
     * `null` return (DB unavailable/error) so callers can give the right message.
     */
    async function consumeAuthTokenWith(raw, purpose, onConsumed) {
        if (!raw || raw.length > maxLength)
            return { ok: false };
        return query(async (sql) => {
            return await sql.begin(async (tx) => {
                const rows = await tx `
          UPDATE auth_tokens
          SET used_at = NOW()
          WHERE token_hash = ${tokenHash(raw)}
            AND purpose = ${purpose}
            AND used_at IS NULL
            AND expires_at > NOW()
          RETURNING user_id::text AS user_id
        `;
                const row = rows[0];
                if (!row)
                    return { ok: false };
                const result = await onConsumed(tx, row.user_id);
                return { ok: true, userId: row.user_id, result };
            });
        });
    }
    return {
        createAuthToken,
        peekAuthToken,
        consumeAuthToken,
        consumeAuthTokenWith,
        tokenHash,
    };
}
//# sourceMappingURL=tokens.js.map