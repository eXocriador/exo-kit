# syntax=docker/dockerfile:1
#
# АРХЕТИП F6 — Python-сервіс на uv: FastAPI, воркер, збирач (@exo/kit,
# templates/docker). Форми, плейсхолдери і як перевірено: templates/docker/README.md.
# Хто в портфелі на цій формі і чим відрізняється:
# /srv/docs/audits/2026-09-14-dockerfile-drift.md.
#
# Канонічний член — exoanima/services/builder (uv bind-монтуванням, кеш
# cache-монтуванням, стадія test від non-root, теки томів — `install -d -o`).
# Мінімум — exopost/repo/apps/api.
#
# Заповнити: __PORT__, __APP_MODULE__ (напр. app.main:app). Контекст — тека
# проєкту: pyproject.toml і uv.lock у корені контексту (у deploy.conf для
# монорепо — `svc=<тека>:Dockerfile`). Тести — pytest у групі `dev`
# (`[dependency-groups]`). uv-workspace на кілька пакетів (exopost) — маніфест
# кожного члена окремим COPY перед `uv sync` і `--all-packages` або `--package`.
#
# База — python:3.12-slim-TRIXIE, кодова назва в тезі навмисно. Голий
# `python:3.12-slim` на 2026-09-14 уже вказує на Debian 13 (усі вісім живих
# Python-образів — 13.x), а `node:22-bookworm-slim` — Debian 12. Тег без кодової
# назви перескочить на наступний реліз Debian мовчки, першою ж збіркою.

# ── спільна основа: користувач, залежності за локом ─────────────────────────
FROM python:3.12-slim-trixie AS base
# UV_COMPILE_BYTECODE=1 для non-root ОБОВ'ЯЗКОВИЙ: писати `.pyc` у site-packages
# процес не може, і без компіляції на збірці кожен запуск компілював би модулі в
# пам'яті заново. PYTHONDONTWRITEBYTECODE — щоб і не пробував.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH"

# uid 1000 / gid 1001 — ті самі `exo:srv`, що на хості володіють `data/` продукту:
# створене процесом лишається доступним групі `srv` без chown.
#
# Томи мусять НАЛЕЖАТИ цьому uid, а не лише бути записуваними для групи: `chmod`
# дозволено тільки власникові. Перший білд exoanima від non-root упав у CMake
# ESP-IDF (`file COPY cannot set permissions`) на робочій теці, яку колись
# створив root, хоча всі 67 911 файлів там були g+w. Переходячи на цей образ із
# root-образу — `sudo chown -R exo:srv <тека тому>` ДО першого запуску. Доказ —
# живий прогін основної дії в теці, СТВОРЕНІЙ ROOT: нова тека проходить і без
# chown і не доводить нічого; старт і health — тим паче.
#
# Теки томів створюються тут, а не застосунком: non-root теку в корені не
# створить (exoanima без монтувань — `PermissionError: '/data'`). 2775 — setgid,
# як каталоги продуктів на хості (§8).
RUN groupadd --gid 1001 srv \
    && useradd --uid 1000 --gid 1001 --create-home --shell /usr/sbin/nologin app \
    && install -d -o app -g srv -m 2775 /data

WORKDIR /app
# Рівно лок, а не `pip install .`: так exoanima до C2 тримала в проді ESPHome
# 2026.8.2 при 2026.7.4 у локі — кожна перезбірка ставила «найсвіжіше».
# `--no-install-project`: сам проєкт не встановлюється, код бере робоча тека.
#
# Два монтування замість `COPY` uv і замість кешу в шарі — обидва знайдені
# `docker history` пробного образу exoanima (1,12 ГБ проти 827 МБ): кеш wheel-ів
# запікався в шар (421 МБ шару при .venv на 223 МБ), а сам uv (53 МБ) рантайму
# не потрібен. uv запінений точно, не мінорним тегом: він читає лок, і нова
# ревізія формату посеред деплою — не той сюрприз.
COPY pyproject.toml uv.lock ./
RUN --mount=from=ghcr.io/astral-sh/uv:0.11.33,source=/uv,target=/usr/local/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev
COPY app ./app

# ── ворота: тести на тій самій основі ──────────────────────────────────────
FROM base AS test
RUN --mount=from=ghcr.io/astral-sh/uv:0.11.33,source=/uv,target=/usr/local/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project
COPY tests ./tests
# Від non-root, як рантайм: root обходить права на файли, і тест, зелений від
# root, не доводить нічого про процес, що працює від `app`.
USER app
RUN python -m pytest -q -p no:cacheprovider && touch /tmp/tests-passed

# ── рантайм ─────────────────────────────────────────────────────────────────
FROM base AS runtime
# Без цього рядка BuildKit стадію `test` просто ПРОПУСТИВ би: фінальному образу
# вона ні для чого не потрібна, і ворота «проходили» б, не запускаючись.
COPY --from=test /tmp/tests-passed /tmp/tests-passed

# ARG в останній стадії: хеш міняється з кожним комітом і не має інвалідувати
# встановлення вище.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
USER app
EXPOSE __PORT__
# Ні wget, ні curl у slim-образі немає, python є. `--start-interval` потребує
# Docker ≥ 25 і працює лише разом зі `--start-period`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=5 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:__PORT__/health/live', timeout=4).status == 200 else 1)"]
# umask 002: нове в томах лишається записуваним для групи `srv` — інакше файли
# вийдуть 644, і ні власник, ні агент під `claude` не приберуть їх без sudo.
CMD ["sh", "-c", "umask 002 && exec uvicorn __APP_MODULE__ --host 0.0.0.0 --port __PORT__"]
