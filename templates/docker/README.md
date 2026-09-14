# Архетипи образів і compose-сервісу (`@exo/kit`, `templates/docker`)

Файли, які продукт **копіює**, а не імпортує. Стандарт, який вони втілюють, —
`/srv/products/AGENTS.md` §4–§6. Рішення, з яких їх списано, —
§10 там же, блоки «Модульність, C2 (продуктова половина)» і
«Модульність, C2 (kit-половина)». Наскільки портфель від них відстоїть сьогодні —
`/srv/docs/audits/2026-09-14-dockerfile-drift.md`.

Коментарі в архетипах — не прикраса. Кожен неочевидний рядок коштував комусь у
портфелі зламаної збірки чи деплою, і коментар каже, кому й чим. Копія без
коментаря тримає рядок рівно до першого, хто його «спростить».

## Яку форму брати

| форма | тека | коли | канонічний член портфеля | порт / uid |
|---|---|---|---|---|
| F1 | `static-nginx/` (+ `nginx.conf`) | збірка дає статику: Vite SPA, `output: 'export'` | `exoanima/apps/web` | 8080 / 101 |
| F2 | `next-standalone/` | Next із серверним рендером | `teamself/apps/console` | свій / 1000 |
| F3 | `node-api/` (+ `build.mjs`) | Node HTTP-сервіс (Fastify) — канонічна родина нових продуктів | `exoanima/services/api` | свій / 1000 |
| F4 | `node-prisma/` | Next або Node на Prisma, одне дерево без робочих областей | `tyusha/repo` | свій / 1000 |
| F5 | `node-worker/` | фоновий процес: воркер, планувальник, сканер | `netwatch/repo/apps/scanner` | — / 1000 |
| F6 | `python-uv/` | свій Python-код на uv: FastAPI, воркер, збирач | `exoanima/services/builder` | свій / 1000:1001 |
| F7 | `python-wrapper/` | HTTP-обгортка над чужим Python-інструментом | `netwatch/…/osint-services/spiderfoot` | свій / 10010+ |

Не архетип: `exo-vpn` (root, WireGuard, `cap_add`) — постійний виняток §5.

Два розвилки, на яких легко помилитись:

- **F3: бандл чи `tsc`.** Бандл обов'язковий, коли робочі області віддають сирий
  TypeScript (`main: ./src/index.ts`) — Node його не виконає. Коли пакети
  збираються у свій `dist` (filebrowser) або робочих областей немає (exo-ai),
  `tsc` у `dist` — теж ця форма; тоді `build.mjs` не потрібен.
- **F2 чи F4.** Prisma з `MIGRATE=prisma` — завжди F4: standalone-трасування не
  бере CLI Prisma, а exo-deploy кличе міграції саме з образу продукту.

## Плейсхолдери

| плейсхолдер | де | що підставити |
|---|---|---|
| `__SVC_DIR__` | F1, F2, F3, F5 | тека сервісу від кореня репо (`apps/api`) |
| `__PKG__` | F1, F3 | `name` із package.json сервісу — для фільтрів pnpm |
| `__OUT_DIR__` | F1 | що кладе збірка: `dist` (Vite), `out` (експорт Next) |
| `__PORT__` | F2–F4, F6, F7, compose | порт усередині контейнера |
| `__APP_MODULE__` | F6 | ASGI-модуль (`app.main:app`) |
| `__USER__`, `__UID__`, `__IMPORT_CHECK__` | F7 | системний користувач, його uid, модуль інструмента |
| `__APP_NAME__`, `__SVC__`, `__DOCKERFILE__`, `__UID__`, `__GID__`, `__HEALTH_TEST__`, `__MEM_LIMIT__` | `compose-service.yml` | ім'я продукту, сервіс, шлях до Dockerfile, uid:gid образу, рядок HEALTHCHECK форми, замір |

`__APP_VERSION__` у `nginx.conf` — **не** плейсхолдер генератора: його підставляє
Dockerfile на збірці. Закоментовані `# COPY <інша робоча область>/package.json …`
розкоментувати по одному на кожну робочу область лока — інакше `--frozen-lockfile`
і `npm ci` відмовляють. Після підстановки має бути порожньо:

```bash
grep -n '__[A-Z_]*__' Dockerfile | grep -v __APP_VERSION__
```

`APP_VERSION` передає exo-deploy сам (`BUILD_ARGS` у `deploy.conf`).

## Спільне для всіх семи

- **База з кодовою назвою Debian:** `node:22-bookworm-slim`, `python:3.12-slim-trixie`,
  рантайм статики — `nginxinc/nginx-unprivileged:1.27.5-alpine`. Голі `node:22-slim`
  і `python:3.12-slim` 2026-09-14 вказують на РІЗНІ релізи Debian (12 і 13) і
  перескочать далі самі.
- **Лок і тільки лок:** `pnpm fetch` + `--offline --frozen-lockfile`, `npm ci`,
  `uv sync --frozen`, `pip install --require-hashes`.
- **Ворота в стадії, яку фінальний образ справді копіює.** Стадію, з якої він
  нічого не бере, BuildKit пропускає мовчки (доведено нижче, F6).
- **USER non-root; код root-овий і лише читається;** своє в процесу — тільки теки
  запису (`install -d -o`). Томи НАЛЕЖАТЬ uid процесу, g+w мало.
- **HEALTHCHECK в образі** зі `--start-period` і `--start-interval`: у Node —
  `node -e fetch`, у Python — `python -c urllib`, у nginx-alpine — його busybox
  `wget`. Curl і wget у Node/Python-образи не ставляться.
- **`ARG APP_VERSION` в останній стадії.** Ціна: верхній шар новий на кожному
  коміті, тож кожен деплой перестворює контейнер.
- **compose** (`compose-service.yml`): `start_period` і `start_interval` разом,
  `user` числами, json-file 10m×3, `mem_limit` лише із заміру,
  `no-new-privileges` + `cap_drop: ALL`, без `read_only`.

## Як перевірено (2026-09-14)

Для кожної форми — заглушка її форми в скретчпаді: pnpm-монорепо
(`apps/web` на Vite, `apps/api` на Fastify, `packages/shared` сирим TS),
npm-воркспейс (`apps/console` на Next 16.3.3, `apps/worker`), одне дерево Next +
Prisma 7.10.0, FastAPI на uv 0.11.33, обгортка над `http.server` з `anyio`.
Плейсхолдери — `sed`, далі коміт і збірка рівно як у exo-deploy:
`git archive HEAD | docker build -f … --build-arg APP_VERSION=<коміт> -`. Запуск —
`docker run --network none --security-opt no-new-privileges:true --cap-drop ALL`.
Docker 29.8, pnpm 12.4.1. Збірки — по одній. Заглушки й образи знесено.

| форма | збірка | образ | healthy від старту | процес | тіло проби |
|---|---|---|---|---|---|
| F1 | 31 с | 74 МБ | 2,1 с | 101 nginx | `version` = коміт, `checks.build: ok` |
| F2 | 136 с | 393 МБ | 2,3 с | 1000 node | `version` = коміт |
| F3 | 21 с¹ | 390 МБ | 2,6 с | 1000 node | `version` = коміт |
| F4 | 149 с² | 1261 МБ | 2,9 с | 1000 node | `version` = коміт, `checks.prisma` |
| F5 | 16 с¹ | 330 МБ | 2,7 с | 1000 node | серцебиття з `version` |
| F6 | 19 с | 211 МБ | 3,2 с | 1000:1001 app:srv | `version` = коміт, `checks.data: ok` |
| F7 | 12 с | 204 МБ | 2,7 с | 10020 | `version` = коміт |

¹ шари залежностей уже лежали в кеші від сусідньої форми тієї ж заглушки.
² перезбірка після правки `--chown` (див. F4 нижче).

Healthy за 2–3 с, а не за `interval` 30 с, дає `--start-interval` у самому
Dockerfile, без жодного compose.

Що ще перевірено — кожен пункт є твердженням у файлі архетипу:

- **F1.** З `--read-only` nginx падає на старті: `mkdir() "/tmp/proxy_temp" failed
  (30: Read-only file system)` — одна з причин, чому `read_only` не в архетипі.
- **F2.** `GET /` → 200 від node; `server.js` — root, `.next/cache` — node; EACCES у
  лозі 0; standalone кладе сервер у `apps/console/server.js`, як і в teamself.
- **F3.** У рантаймі `node_modules` 15 МБ, 51 запис `.pnpm`, dev-пакетів 0;
  `dbmate 2.35.1` запускається від node. **Від'ємний:** та сама стадія `prod-deps`
  без `rm -rf node_modules` — 61 МБ, 68 записів, typescript, esbuild і vite у
  рантаймі. Пастка, знайдена exoanima на pnpm 11, жива і на 12.4.1.
- **F4.** Код root-овий (`touch package.json` → Permission denied), `.next/cache` —
  node; `GET /` → 200; згенерований клієнт Prisma пережив `npm prune`;
  `npx --no-install prisma migrate status` від node з `--network none` читає
  конфіг і схему й доходить до `P1001` — рантайму нічого не треба завантажувати.
  **Перша збірка зловила дві неправди в самому архетипі:** без `--chown=root:root`
  `COPY --from` зберіг власника node зі стадії збірки, а `typescript` пережив
  `--omit=dev` як `devOptional` (опційний peer `@prisma/client`). Обидва тепер
  записані у файлі.
- **F5.** У рантаймі `node_modules` 44 КБ (picocolors і порожня тека `@types`);
  файл серцебиття несе `version`.
- **F6.** umask процесу 0002; pytest у рантаймі немає; 325 `.pyc` у venv; `/data` —
  app:srv 2775. Томи: root:root 755 — запис неможливий; root:srv 2775 з g+w — новий
  файл пишеться, чужий дописується, а `chmod` чужого файла дає
  `Operation not permitted`: урок ESP-IDF exoanima відтворено без ESP-IDF.
  **Від'ємний:** тест, що падає, з `COPY --from=test` — збірка rc=1; той самий коміт
  без цього рядка — rc=0, BuildKit стадію пропустив.
- **F7.** pip на збірці скомпілював 46 `.pyc` для anyio. **Від'ємний:** лок без
  транзитивного `idna` → `ERROR: In --require-hashes mode, all requirements must
  have their versions pinned with ==. These do not: idna>=2.8 … (from
  anyio==4.15.1)`.
- **`compose-service.yml`** над образом F3 через `docker compose up` (мережі й
  мітки прибрані — вони продуктові): healthy за 2,4 с від `up`; `User=1000:1000`,
  `Memory=134217728`, json-file 10m×3, `SecurityOpt=[no-new-privileges:true]`,
  `CapDrop=[ALL]`, `StartPeriod=30s`, `StartInterval=2s`. Шлях до `memory.peak`,
  записаний у коментарі архетипу, існує (44 МіБ на простої, `oom_kill 0`).
  `128m` там — не замір.

## Чого це НЕ доводить

- Що продукти перейдуть на архетипи без болю: у заглушок немає нативних модулів,
  плагінів Next, git-піна `@exo/kit`, живих томів і навантаження.
- F2 з пакетами робочих областей, які Next транспілює (`transpilePackages` у
  teamself), — не перевірено.
- Жодне число `mem_limit`: заглушки не навантажувались.
