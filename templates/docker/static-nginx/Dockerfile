# syntax=docker/dockerfile:1
#
# АРХЕТИП F1 — статика за непривілейованим nginx (@exo/kit, templates/docker).
# Форми, плейсхолдери і як перевірено: templates/docker/README.md.
# Хто в портфелі на цій формі і чим відрізняється:
# /srv/docs/audits/2026-09-14-dockerfile-drift.md.
#
# Канонічний член — exoanima/apps/web (pnpm, вузький COPY, ARG APP_VERSION).
# npm-варіант — exopost/repo/apps/web (ворота тестів): `npm ci` замість
# `pnpm fetch` + `install --offline`, решта та сама.
#
# Заповнити: __SVC_DIR__ (тека застосунку, напр. apps/web), __PKG__ (його name у
# package.json), __OUT_DIR__ (що кладе збірка: `dist` у Vite, `out` у статичного
# експорту Next). Порт 8080 і uid 101 — від образу nginx, не вибір продукту.
# Поруч — nginx.conf: він кладеться в __SVC_DIR__/nginx.conf.
#
# Збирає exo-deploy з `git archive HEAD` (некомічений код в образ не
# потрапляє) — /srv/products/AGENTS.md §3, §5.

FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Версію pnpm corepack бере з `packageManager` кореневого package.json — пін
# живе в репо, а не в цьому файлі.
RUN corepack enable
WORKDIR /repo

# Спершу лише лок: `pnpm fetch` кладе в стор усе, що в ньому записано, і цей шар
# переживає будь-яку правку коду. Не перелік `package.json` робочих областей —
# `COPY` з маскою сплющує теки, а перелік руками мовчки забув би наступний пакет.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# Далі тільки те, з чого справді збирається застосунок, а не `COPY . .`: з ним
# правка сусіднього сервісу перезапускала збірку статики (у exoanima це був
# `next build` — найважчий крок на машині, де RAM і так вузьке місце).
# Кореневі конфіги, які розширює застосунок (tsconfig.base.json), — сюди ж.
# Немає `packages/` — рядок прибрати.
# COPY tsconfig.base.json ./
COPY packages ./packages
COPY __SVC_DIR__ ./__SVC_DIR__
# Маніфести ІНШИХ робочих областей — лише щоб pnpm бачив усіх, хто записаний у
# локу; без них `--frozen-lockfile` відмовляє. По рядку на кожну:
# COPY apps/api/package.json ./apps/api/package.json
RUN pnpm install --offline --frozen-lockfile --filter "__PKG__..." --filter "{.}"

# Ворота — тут, у стадії образу, а не на хості: вони бачать рівно те дерево, з
# якого збирається образ (урок ревізії 2026-09-10). Статика не виняток: без
# воріт сьогодні cockatiel, exocriador-dev і сам канонічний член — це дрейф.
RUN pnpm --filter __PKG__ run typecheck \
 && pnpm --filter __PKG__ run test

# Змінні збірки (VITE_* / NEXT_PUBLIC_*) вшиваються в бандл САМЕ ТУТ: у статики
# немає рантайму, який прочитав би оточення. Кожна — ARG+ENV тут і ім'я в
# BUILD_ARGS deploy.conf. Жодна проба здоров'я їх втрати не побачить — доводити
# ґрепом по зібраному бандлу (урок exoanima, C1).
# ARG VITE_API_URL
# ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm --filter __PKG__ run build

# ── рантайм ─────────────────────────────────────────────────────────────────
# Непривілейований nginx: uid 101, слухає 8080. Статиці root не потрібен ніколи.
FROM nginxinc/nginx-unprivileged:1.27.5-alpine
COPY --from=build /repo/__SVC_DIR__/__OUT_DIR__ /usr/share/nginx/html
COPY __SVC_DIR__/nginx.conf /etc/nginx/conf.d/default.conf

# ARG саме тут, в останній стадії: значення міняється з кожним комітом, а
# оголошений вище арг інвалідував би кеш збірки. Ціна, яку треба знати: верхній
# шар образу новий на КОЖНОМУ коміті, тож кожен деплой перестворює контейнер
# (exoanima: ~17–19 с не-200 на деплой) — плата за «версія одним curl».
ARG APP_VERSION=dev
USER root
RUN sed -i "s/__APP_VERSION__/${APP_VERSION}/g" /etc/nginx/conf.d/default.conf
USER nginx

EXPOSE 8080
# Проба — `wget` із busybox самого alpine-образу. Правило «HEALTHCHECK без
# wget/curl» стосується Node/Python-образів, куди інструмент довелося б
# доставляти пакетом; тут node і python немає, а wget уже є. `--start-interval`
# потребує Docker ≥ 25 і працює лише разом зі `--start-period`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=2s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health/live >/dev/null 2>&1 || exit 1
