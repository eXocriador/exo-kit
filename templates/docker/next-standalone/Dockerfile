# syntax=docker/dockerfile:1
#
# АРХЕТИП F2 — Next.js з `output: 'standalone'` (@exo/kit, templates/docker).
# Форми, плейсхолдери і як перевірено: templates/docker/README.md.
# Хто в портфелі на цій формі і чим відрізняється:
# /srv/docs/audits/2026-09-14-dockerfile-drift.md.
#
# Канонічний член — teamself/apps/console (єдиний із трьох на канонічній базі).
#
# Заповнити: __SVC_DIR__ (тека застосунку, напр. apps/web), __PORT__.
# Контекст — корінь репо: npm workspaces, один кореневий лок. У next.config —
# `output: 'standalone'`; у package.json застосунку — скрипти `typecheck`,
# `test`, `build`. Роути /health/* — з `export const dynamic = 'force-dynamic'`:
# APP_VERSION існує лише в рантаймі (див. нижче), і відрендерене на збірці тіло
# проби несло б не той `version`.

# ── залежності за локом ─────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# git — лише якщо в залежностях є git-пін (`@exo/kit` github:…#vX.Y.Z). npm
# сьогодні бере тарбол codeload і без git, але тримається це на двох
# незапінених умовах: у kit немає скрипта `prepare`, і npm не змінить порядок
# спроб. Стадію й так викидають, рантайм git не отримує. Git-пінів немає —
# рядок прибрати.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
# Лише маніфести: шар install кешується від змін коду. Маніфест КОЖНОЇ робочої
# області з лока — без жодної `npm ci` відмовляє. По рядку на кожну:
# COPY apps/worker/package.json apps/worker/
COPY package.json package-lock.json ./
COPY __SVC_DIR__/package.json __SVC_DIR__/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ── збірка і ворота ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
# УСЕ дерево зі стадії deps, а не лише кореневий node_modules: npm не
# зобов'язаний піднімати залежність нагору (teamself: `@exo/kit` лежить у
# packages/*/node_modules), і копія самого кореня мовчки губить такий пакет —
# аж до `Can't resolve` посеред `next build`.
COPY --from=deps /app /app
COPY . .
# Ворота тут, а не на хості: бачать рівно дерево образу. `next build` перевіряє
# типи лише у файлах, що потрапили в граф сторінок; `typecheck` — усе дерево.
RUN npm run typecheck --workspace=__SVC_DIR__ \
 && npm test --workspace=__SVC_DIR__
# `NEXT_PUBLIC_*` вшиваються САМЕ ТУТ: ARG+ENV перед збіркою і ім'я в BUILD_ARGS
# deploy.conf. Жодна серверна проба їх втрати не бачить — доводити ґрепом по
# `.next/static` (урок exoanima, C1).
# ARG NEXT_PUBLIC_SENTRY_DSN
# ENV NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN}
RUN --mount=type=cache,target=/app/__SVC_DIR__/.next/cache \
    npm run build --workspace=__SVC_DIR__

# ── рантайм ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# Standalone-сервер слухає $HOSTNAME, а Docker кладе туди id контейнера — це не
# адреса для bind, і сервер падає на старті з EAI_AGAIN.
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=__PORT__
# Файли коду — root-ові й лише читаються: процесу не треба вміти переписати
# власний сервер. Теки `public` немає — третій рядок прибрати (COPY відсутньої
# теки валить збірку).
COPY --from=build /app/__SVC_DIR__/.next/standalone ./
COPY --from=build /app/__SVC_DIR__/.next/static ./__SVC_DIR__/.next/static
COPY --from=build /app/__SVC_DIR__/public ./__SVC_DIR__/public
# Кеш рантайму Next (ISR, fetch, картинки) пише сюди. Від root тека з'являлась
# сама; non-root мусить отримати її готовою й своєю — інакше перший запис це
# EACCES у лозі й сторінка, що не відповідає (teamself, 2026-09-10).
RUN install -d -o node -g node __SVC_DIR__/.next/cache
# MIGRATE=dbmate у deploy.conf запускає dbmate З ЦЬОГО ОБРАЗУ, тож бінарник і
# міграції їдуть сюди, і схема з кодом — один коміт за побудовою (netwatch,
# exo-ai). БД немає — обидва рядки прибрати.
# COPY --from=amacneil/dbmate:2.35.1 /usr/local/bin/dbmate /usr/local/bin/dbmate
# COPY db/migrations ./db/migrations

# ARG в останній стадії: хеш міняється з кожним комітом і не має інвалідувати
# встановлення, ворота і `next build` вище.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
# `node` (uid 1000) — non-root користувач офіційного образу (§5).
USER node
EXPOSE __PORT__
# Ні wget, ні curl у slim-образі немає, node є. `--start-interval` потребує
# Docker ≥ 25 і працює лише разом зі `--start-period`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:__PORT__/health/live').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "__SVC_DIR__/server.js"]
