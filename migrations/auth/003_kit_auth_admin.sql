-- 003_kit_auth_admin.sql — the four columns the `admin` plugin writes. Applied
-- only by a product that passes `admin: true`.
--
-- BEFORE TURNING THIS ON, read what it costs. The plugin's gate is
-- `users.role = 'admin'` — a row in this database. A product whose admin is
-- decided some other way (filebrowser matches a verified address against
-- ADMIN_EMAIL, which is policy the product owns) gains fifteen routes that its
-- only admin can never pass: a surface with no user. Enable it where roles
-- really do live in the column, and nowhere else.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role        text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned      boolean DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason  text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_expires timestamptz;

-- An impersonation session records who opened it. Nullable, and null for every
-- ordinary session — which is also how an audit reads "this was not a person
-- signing in as themselves".
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS impersonated_by uuid;
