-- 20200101000003_kit_auth_admin.sql — the four columns the `admin` plugin
-- writes. Applied only by a product that passes `admin: true`.
--
-- BEFORE TURNING THIS ON, read what it costs. The plugin's gate is
-- `users.role = 'admin'` — a row in this database. A product whose admin is
-- decided some other way (filebrowser matches a verified address against
-- ADMIN_EMAIL, which is policy the product owns) gains fifteen routes that its
-- only admin can never pass: a surface with no user. Enable it where roles
-- really do live in the column, and nowhere else.
--
-- Vendored, not read from the package at run time: `exo-kit-migrations sync`
-- copies this file byte for byte into the consumer's `migrations/kit/`, and
-- dbmate — a separate container with no Node in it — reads the copy. Edit it
-- here; a copy edited there is drift, and the consumer's `check` gate fails on
-- it. Reasoning: README, "Migrations: `@exo/kit/migrate`".
--
-- The `20200101` prefix is not a date. dbmate orders by the number in the file
-- name across every `-d` directory at once, and a kit block has to land before
-- the product migrations that build on it — including products whose own
-- migrations are older than this module. It is an ordering floor, and it is
-- the same in every product, so the version recorded for this file is too.

-- migrate:up
ALTER TABLE users ADD COLUMN IF NOT EXISTS role        text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned      boolean DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason  text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_expires timestamptz;

-- An impersonation session records who opened it. Nullable, and null for every
-- ordinary session — which is also how an audit reads "this was not a person
-- signing in as themselves".
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS impersonated_by uuid;

-- migrate:down
-- No rollback, on purpose. This migration is convergent — it runs against an
-- empty database and against a product that already has these tables — so
-- "undo" has no single meaning, and every honest guess drops a table that may
-- hold accounts. dbmate refuses a file without a down block, so the block
-- exists and refuses instead: `rollback` fails, the schema and the recorded
-- version both stay. Forward-only is the standard (auth.md); a mistake is
-- corrected by the next migration, not by walking backwards.
DO $$ BEGIN RAISE EXCEPTION 'no rollback: 20200101000003_kit_auth_admin'; END $$;
