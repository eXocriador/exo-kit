-- 001_kit_auth.sql — the five tables `@exo/kit/auth` needs, under the names
-- /srv/docs/standards/auth.md fixed: users, identities, sessions, verification.
-- (two_factor is 002, applied only by a product that turns TOTP on.)
--
-- Convergent on purpose. It runs against an empty database AND against a
-- product that already has auth.md-shaped tables, so every statement is
-- IF NOT EXISTS: CREATE TABLE for a new product, ADD COLUMN for an old one.
--
-- What it deliberately does NOT do: change the type of a column that already
-- exists, or move a primary key. Those need to know how many rows are in the
-- table, and only the product knows that. auth.md says it in the section "Як
-- додати вхід" and it still holds — the old column is the product's to migrate,
-- and never to destroy silently.
--
-- Applied BEFORE the product's own migrations.

-- ─── Users ──────────────────────────────────────────────────────────────────
-- `id uuid`, not `text`. Better Auth generates either (advanced.database
-- .generateId: 'uuid' is a first-class mode and its own generator emits uuid
-- columns for it), so this is our decision rather than the library's: every
-- table that references users(id) in exoanima and exointel already holds a
-- uuid, and `text` would be paid for by all of them. Reasoning in the README.
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Display name, as the provider gives it. Nullable: a magic-link account has none.
  name           text,
  -- The short handle auth.md keeps apart from `name`. Better Auth has no such
  -- field; @exo/kit/auth fills it on creation (the local part of the address).
  -- Never unique and never searched on — two domains share a local part easily.
  login          text,
  -- NOT NULL because the library treats the address as the account's identity:
  -- every lookup is by it, and a row without one can never be signed into.
  email          text NOT NULL,
  -- The single irreversible decision in this schema depends on this column:
  -- whether two logins become one account. Only ever rises.
  email_verified boolean NOT NULL DEFAULT false,
  avatar_url     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS name           text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login          text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email          text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url     text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at     timestamptz NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();

-- UNIQUE, and this is a CHANGE OF POLICY worth reading twice.
--
-- auth.md used to index lower(email) WITHOUT unique, and said so explicitly:
-- "дві людини з непідтвердженою однаковою поштою — два акаунти". Better Auth
-- cannot express that — `user.email` is the account's identity — so where the
-- standard said "if in doubt, make a second account", the library REFUSES the
-- login instead (`account_not_linked`). The security property is identical;
-- the experience is not, and the standard is rewritten to match.
--
-- On lower(), not the raw column: the library lowercases every address it
-- looks up, but its magic-link route creates a user with the string as typed.
-- `Alice@x` would land a row no later lookup could find. @exo/kit/auth
-- normalizes in a databaseHook so the two can never disagree; this index is
-- what makes that a guarantee instead of a hope.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

-- ─── Identities ─────────────────────────────────────────────────────────────
-- Better Auth's `account`. The pair auth.md calls the identity is
-- (provider, provider_id) — its `providerId` and `accountId`, both text:
-- GitHub gives a bigint, Google an opaque `sub`, and our own email login the
-- normalized address.
--
-- The token columns are the library's bookkeeping, not ours. They hold a live
-- provider access token when one was issued, which is why this table is worth
-- treating as a secret store even though no password of ours is in it.
CREATE TABLE IF NOT EXISTS identities (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                 text NOT NULL,
  provider_id              text NOT NULL,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Only ever non-null for provider = 'credential': scrypt, in the kit's
  -- format (scrypt$N$r$p$salt$hash) on every product at once.
  password                 text,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE identities ADD COLUMN IF NOT EXISTS id                       uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE identities ADD COLUMN IF NOT EXISTS password                 text;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS access_token             text;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS refresh_token            text;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS id_token                 text;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS access_token_expires_at  timestamptz;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS refresh_token_expires_at timestamptz;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS scope                    text;
ALTER TABLE identities ADD COLUMN IF NOT EXISTS created_at               timestamptz NOT NULL DEFAULT now();
ALTER TABLE identities ADD COLUMN IF NOT EXISTS updated_at               timestamptz NOT NULL DEFAULT now();

-- **The library does not create this, and it is the stronger guarantee of the
-- two it ships with.** `auth@1.7.4 generate` emits only an index on userId
-- (sandbox §3.1). Without a unique key, two tabs finishing the same login at
-- the same moment write two identity rows for one provider account.
CREATE UNIQUE INDEX IF NOT EXISTS identities_provider_key ON identities (provider, provider_id);
CREATE INDEX IF NOT EXISTS identities_user_idx ON identities (user_id);

-- ─── Sessions ───────────────────────────────────────────────────────────────
-- The cookie carries `<token>.<HMAC>`; the authority is this row. Same shape
-- the standard already required, and the reason is unchanged: a signed cookie
-- alone cannot be revoked before it expires, so "log out everywhere" would be
-- a lie. The new column against auth.md's version is `token` — the id is no
-- longer the secret, which is why the cabinet can list sessions by id safely.
CREATE TABLE IF NOT EXISTS sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token           text NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  ip              text,
  user_agent      text,
  -- Written only by the `admin` plugin, and only for an impersonation session.
  impersonated_by uuid
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token           text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at      timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip              text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent      text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS impersonated_by uuid;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_key ON sessions (token);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- ─── Verification ───────────────────────────────────────────────────────────
-- One table for every single-use string the login issues: the magic link, the
-- address-verification link, the password reset, and the OAuth `state`. It
-- replaces the products' own `login_tokens`.
--
-- One difference from what auth.md's own implementation did, and it is a
-- weakening worth naming: those tables stored a SHA-256 of the token, so a row
-- was not enough to log in. Better Auth stores `value` as issued. A dump of
-- this table is therefore live credentials for as long as the rows have not
-- expired — which for a magic link is the fifteen minutes the product set.
CREATE TABLE IF NOT EXISTS verification (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value      text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier);
CREATE INDEX IF NOT EXISTS verification_expires_idx ON verification (expires_at);
