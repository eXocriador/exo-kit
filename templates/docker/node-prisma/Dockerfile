# syntax=docker/dockerfile:1
#
# АРХЕТИП F4 — Next/Node із Prisma, одне дерево без робочих областей
# (@exo/kit, templates/docker). Форми, плейсхолдери і як перевірено:
# templates/docker/README.md. Хто в портфелі на цій формі і чим відрізняється:
# /srv/docs/audits/2026-09-14-dockerfile-drift.md.
#
# Канонічний член — tyusha/repo (чотири ворота, ворота від node).
#
# Чим відрізняється від F2 і чому НЕ standalone. `MIGRATE=prisma` у deploy.conf
# кличе `npx --no-install prisma migrate deploy` З ЦЬОГО ОБРАЗУ (exo-deploy,
# cmd_migrate), а standalone-трасування Next бере лише те, що імпортує код, —
# CLI Prisma туди не потрапляє. Тому рантайм несе node_modules цілком, але
# ПРОДОВІ: `prisma` (CLI) лежить у `dependencies`, як і все, що імпортує
# prisma.config.ts. `import 'dotenv/config'` там при `dotenv` у devDependencies
# (форма tyusha сьогодні) = `migrate deploy` падає в рантаймі на
# `Cannot find module` — оточення в контейнері й так приходить з `.env`.
#
# Заповнити: __PORT__. У package.json — скрипти `typecheck`, `test`, `build`.
# Власний сервер (server.ts із socket.io — syncwatch) — бандл esbuild у dist/,
# як у F3 (build.mjs звідти), і `CMD ["node", "dist/server.js"]`; не `tsx` у
# рантаймі (рішення C2: пік пам'яті +57 %, запитів −19 %, три процеси).

FROM node:22-bookworm-slim AS base
WORKDIR /app
# openssl потрібен Prisma, ca-certificates — усьому, що ходить назовні TLS-ом.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ── залежності за локом ─────────────────────────────────────────────────────
FROM base AS deps
# git — лише для git-пінів (`@exo/kit` github:…#vX.Y.Z; причина — у F2). Стадію
# викидають, рантайм git не отримує.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ── збірка і ворота ─────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
# Саму теку теж, інакше збірка не запише в неї .next. Не `-R`: файли вже
# приїхали з потрібним власником через --chown.
RUN chown node:node /app
# Ворота ЙДУТЬ ВІД node, не від root. Прод працює від node, і перевірки прав
# (запис у примонтовану теку) root обходить узагалі: у tyusha перший прогін від
# root дав два хибні «сховище доступне» на теці 0555. Тест, який від root не
# може впасти, не перевіряє нічого. Порядок — від дешевшого до дорожчого.
USER node
RUN npx --no-install prisma generate
RUN npm run typecheck
RUN npm test
RUN npm run build
# Лише продові пакети — у тому самому дереві, без другого `npm ci`: vitest,
# eslint, @types виходять, `prisma` (у dependencies) лишається. Кеш збірки Next
# рантайму не потрібен і важить сотні МБ.
#
# ВІДОМИЙ ЗАЛИШОК: `typescript` лишається. Він опційний peer `@prisma/client`, лок
# позначає його `devOptional`, а такий пакет `--omit=dev` не викидає (пробна
# збірка C2: typescript — єдиний такий). `--omit=optional` не ліки: разом із ним
# пішли б платформні бінарники, які Next тягне саме як optionalDependencies
# (`@next/swc-*`).
RUN npm prune --omit=dev --no-audit --no-fund \
 && rm -rf .next/cache

# ── рантайм ─────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=__PORT__
# Код — root-овий і лише читається; своє в процесу — тільки кеш рантайму Next.
# `--chown=root:root` не косметика: `COPY --from` ЗБЕРІГАЄ власника зі стадії
# build, а там усе node-ове (ворота від node) — без цього прапорця код у
# рантаймі належав би процесу (заміряно пробною збіркою C2: `package.json` —
# node). Пише в примонтовану теку даних — вона приходить томом з власником 1000
# (python-uv/Dockerfile про власність томів).
COPY --from=build --chown=root:root /app ./
RUN install -d -o node -g node .next/cache

# ARG в останній стадії: хеш міняється з кожним комітом і не має інвалідувати
# встановлення, ворота і збірку вище.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
USER node
EXPOSE __PORT__
# Ні wget, ні curl у slim-образі немає, node є. `--start-interval` потребує
# Docker ≥ 25 і працює лише разом зі `--start-period`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:__PORT__/health/live').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Не `npx next start`: npx — ще один процес npm у пам'яті поруч із сервером, а
# без `--no-install` при відсутньому бінарнику він піде в мережу. Прямий шлях до
# CLI Next — один процес node. Міграції сюди НЕ входять: їх котить окремий
# одноразовий контейнер цього ж образу до `up` (exo-deploy), інакше кожен
# рестарт чіпав би схему.
CMD ["node", "node_modules/next/dist/bin/next", "start"]
