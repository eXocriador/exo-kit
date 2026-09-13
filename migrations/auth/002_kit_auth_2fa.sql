-- 002_kit_auth_2fa.sql — the second factor. Applied only by a product that
-- passes `totp` to createAuth(); `auth.migrations` leaves it out otherwise.
--
-- ONE THING TO KNOW BEFORE ENABLING THIS: Better Auth ENCRYPTS `secret` and
-- `backup_codes` with the application secret, where the kit's own TOTP stored
-- the secret as issued. That is strictly better — a database dump is no longer
-- enough to mint codes — and it has a price that must be written down
-- somewhere a person will find it: **losing SESSION_SECRET now means losing
-- every second factor**, not just invalidating sessions. Rotating that secret
-- locks every TOTP user out until they re-enrol with a recovery code.
CREATE TABLE IF NOT EXISTS two_factor (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Symmetric ciphertext over the app secret, not the base32 a person scans.
  secret                    text NOT NULL,
  backup_codes              text NOT NULL,
  verified                  boolean,
  -- The library's own lockout after a run of wrong codes. The kit never had one.
  failed_verification_count integer,
  locked_until              timestamptz
);
CREATE INDEX IF NOT EXISTS two_factor_user_idx ON two_factor (user_id);

-- The flag the library reads to know a second step is required. On `users`
-- rather than here, so signing in costs one query and not two. The rename to
-- snake_case travels through the plugin's own `schema` option — the main
-- `user.fields` map does not reach a field a plugin declares.
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled boolean NOT NULL DEFAULT false;
