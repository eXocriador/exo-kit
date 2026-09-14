# syntax=docker/dockerfile:1
#
# АРХЕТИП F5 — фоновий Node-процес: воркер, планувальник, сканер (@exo/kit,
# templates/docker). Форми, плейсхолдери і як перевірено: templates/docker/README.md.
# Хто в портфелі на цій формі і чим відрізняється:
# /srv/docs/audits/2026-09-14-dockerfile-drift.md.
#
# Канонічний член — netwatch/repo/apps/scanner (ворота до збірки, один
# кореневий лок на монорепо).
#
# База — node:22-bookworm-slim, НЕ alpine, і це рішення C2 (2026-09-14), а не
# недогляд. (1) musl-збірки Node у BUILDING.md апстриму — рівень «Experimental»,
# glibc — Tier 1. (2) У монорепо воркер і web ставлять пакети з одного лока, а
# готові нативні бінарники для glibc і musl різні: дві libc — два способи
# зламатись на тому самому локу. (3) Шар bookworm-slim уже лежить на диску під
# шістнадцятьма образами, alpine — ще одна база на диску, заповненому на 90 %.
# (4) Те, заради чого сканер на alpine, у Debian 12 є пакетами: `chromium`
# 152 і `nmap` 7.93 (apt-cache policy, 2026-09-14). Члени на alpine — дрейф до
# наступного дотику, не норма.
#
# Заповнити: __SVC_DIR__ (тека сервісу, напр. apps/worker). Контекст — корінь
# репо. У package.json сервісу — скрипти `typecheck`, `test`, `build` (tsc у
# dist/). Воркер із сирим TS сусідніх пакетів — бандл esbuild, як у F3.

# ── збірка і ворота ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Маніфест КОЖНОЇ робочої області з лока — без жодної `npm ci` відмовляє, навіть
# якщо з неї тут не ставиться нічого. По рядку на кожну:
# COPY apps/web/package.json apps/web/
COPY package.json package-lock.json ./
COPY __SVC_DIR__/package.json __SVC_DIR__/
# `--workspace`: дерево лише цього сервісу — залежності web (next, git-пін kit)
# сюди не потрібні.
RUN --mount=type=cache,target=/root/.npm npm ci --workspace=__SVC_DIR__ --no-audit --no-fund
COPY __SVC_DIR__ ./__SVC_DIR__
# Ворота перед збіркою: образу з червоними типами чи тестами не існує.
RUN npm run typecheck --workspace=__SVC_DIR__ \
 && npm test --workspace=__SVC_DIR__ \
 && npm run build --workspace=__SVC_DIR__

# ── рантайм ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# Системні пакети рантайму (chromium, nmap…) — тут, одним шаром:
# RUN apt-get update && apt-get install -y --no-install-recommends <пакети> \
#     && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY __SVC_DIR__/package.json __SVC_DIR__/
# COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace=__SVC_DIR__ --no-audit --no-fund
COPY --from=build /app/__SVC_DIR__/dist ./__SVC_DIR__/dist

# ARG в останній стадії: хеш міняється з кожним комітом і не має інвалідувати
# встановлення вище. Воркер без HTTP несе версію в серцебитті (див. нижче) і в
# `release` Sentry.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
# `node` (uid 1000) — non-root користувач офіційного образу (§5). Залежності в
# /app/node_modules, node дійде до них угору з робочої теки.
USER node
WORKDIR /app/__SVC_DIR__
# Воркер без HTTP: проба — СЕРЦЕБИТТЯ. Цикл сам пише файл на кожній ітерації —
#   writeFileSync('/tmp/worker-alive', JSON.stringify({ status: 'ok', version: process.env.APP_VERSION }))
# — а проба бере його вік; поріг — три інтервали циклу. Та сама проба node-ом,
# що й у compose, без шелу і його `$$`. Воркер ІЗ HTTP (сканер) — проба як у F3:
#   CMD ["node", "-e", "fetch('http://127.0.0.1:<порт>/health/live').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "const s = require('node:fs').statSync('/tmp/worker-alive', { throwIfNoEntry: false }); process.exit(s && Date.now() - s.mtimeMs < 90000 ? 0 : 1)"]
CMD ["node", "dist/index.js"]
