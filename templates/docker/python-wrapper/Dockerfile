# syntax=docker/dockerfile:1
#
# АРХЕТИП F7 — Python-обгортка над стороннім інструментом (OSINT-сервіси:
# maigret, phoneinfoga, spiderfoot, telethon) (@exo/kit, templates/docker).
# Форми, плейсхолдери і як перевірено: templates/docker/README.md.
# Хто в портфелі на цій формі і чим відрізняється:
# /srv/docs/audits/2026-09-14-dockerfile-drift.md.
#
# Канонічний член — netwatch/repo/apps/osint-services/spiderfoot (апстрім
# запінений комітом, джерело окремою стадією).
#
# Чим відрізняється від F6: коду продукту тут — один server.py (HTTP-обгортка),
# а залежності — чуже дерево, яке ми не розробляємо, а фіксуємо. Тому pip з
# хешованим локом, а не uv-проєкт: pyproject для чужого дерева був би вигадкою.
#
# Заповнити: __PORT__, __USER__ (ім'я системного користувача), __UID__ (10010+,
# унікальний у продукті; пише в bind-монт під /srv — тоді 1000:1001, як F6),
# __IMPORT_CHECK__ (модуль інструмента, напр. maigret).
#
# База — python:3.12-slim-trixie (чому кодова назва в тезі — у F6).

# ── джерело апстриму, запінене комітом (прибрати, якщо інструмент — пакет PyPI) ──
# Пін на SHA, не на гілку: `--depth 1` гілки дає інше дерево щоразу, як апстрим
# щось доллє, — саме це робив старий compose spiderfoot при кожному рестарті.
# git — лише в цій стадії, `.git` в образ не їде.
# FROM python:3.12-slim-trixie AS source
# ARG UPSTREAM_COMMIT=<повний sha>
# RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git \
#     && rm -rf /var/lib/apt/lists/*
# RUN set -eux; git init /upstream; cd /upstream; \
#     git remote add origin https://github.com/<власник>/<репо>.git; \
#     git fetch --depth 1 origin "${UPSTREAM_COMMIT}"; git checkout FETCH_HEAD; \
#     rm -rf /upstream/.git

# ── рантайм ─────────────────────────────────────────────────────────────────
FROM python:3.12-slim-trixie AS runtime
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Лок — requirements.txt, де на КОЖЕН пакет, транзитивні теж, `==` і хеш:
#   uv pip compile requirements.in --generate-hashes --python-version 3.12 -o requirements.txt
# `--require-hashes` тут не параноя щодо PyPI, а перевірка ПОВНОТИ лока на
# збірці: у цьому режимі pip відмовляє на будь-якому пакеті без піна й хешу, тож
# забутий транзитивний більше не доїжджає «найсвіжішим» мовчки. Список `==` без
# хешів (форма живих членів — `pip freeze` із контейнера) цього не ловить.
# `.pyc` pip компілює при встановленні сам, від root, на збірці — non-root
# процесу писати їх не треба (пор. UV_COMPILE_BYTECODE у F6).
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

# COPY --from=source /upstream /upstream
COPY server.py /app/server.py

# Ворота обгортки — не тести чужого коду, а «інструмент справді ліг і
# імпортується»: інакше образ збирається, стартує, health зелений, а перший
# запит падає на ImportError. Бінарник апстриму — ще й `<інструмент> version`
# тут же (phoneinfoga).
RUN python -m py_compile /app/server.py \
    && python -c "import __IMPORT_CHECK__"

# Non-root (§5). Інструменти тримають стан у ~ (spiderfoot — ~/.spiderfoot), тож
# користувачу потрібен справжній HOME, і саме туди compose монтує том. Переїзд
# із root-образу — том перечовнити на uid ДО першого запуску (F6 про власність).
RUN useradd --system --create-home --home-dir /home/__USER__ --uid __UID__ __USER__
USER __USER__
WORKDIR /app
ENV HOME=/home/__USER__

# ARG в останній стадії: хеш міняється з кожним комітом і не має інвалідувати
# встановлення вище.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
EXPOSE __PORT__
# Ні wget, ні curl у slim-образі немає, python є. `--start-interval` потребує
# Docker ≥ 25 і працює лише разом зі `--start-period`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --start-interval=2s --retries=5 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:__PORT__/health/live', timeout=4).status == 200 else 1)"]
CMD ["python", "/app/server.py"]
