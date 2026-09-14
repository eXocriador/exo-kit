#!/usr/bin/env bash
# <продукт> — накотити схему dbmate у одноразовому контейнері.
#
# ШАБЛОН @exo/kit (`templates/migrate.sh`). Копія лежить у
# /srv/products/<продукт>/migrate.sh; різняться лише п'ять змінних нижче.
# Контракт §4.11 плану модульності: точка входу — `./migrate.sh`, код
# повернення вирішує все, повторний запуск — no-op, окремий контейнер, а не
# старт сервера.
#
#   ./migrate.sh          накотити (dbmate up)
#   ./migrate.sh status   що застосовано, що чекає — і ЦЕ доказ переходу
#   MIGRATE_DATABASE_URL=postgresql://…/копія ./migrate.sh status
#                         те саме, але в ІНШУ базу — репетиція на копії
#
# Чому dbmate, а не раннер у коді продукту: п'ять продуктів мали п'ять
# раннерів, три з них — копії, що встигли розійтись, а шостий продукт на
# Python. Раннер мовою продукту — це раннер на кожну мову; контейнер — один на
# всю коробку (план §4.3).
#
# П'ять речей, доведених прогоном (аудит 2026-09-12, розділ 4), кожна коштує
# зламаного деплою:
#
#   1. dbmate читає ТІЛЬКИ DATABASE_URL. Канонічне ім'я змінної бази — теж
#      DATABASE_URL (план §5 C3, рішення контрольної сесії 2026-09-13), тож у
#      типовому продукті перекладати нічого. Продукт із префіксом
#      (EXOANIMA_DATABASE_URL) називає своє ім'я в DATABASE_VAR, а контейнер
#      однаково отримує DATABASE_URL.
#   2. `?sslmode=disable` обов'язковий, інакше `pq: SSL is not enabled`.
#   3. `--no-dump-schema` обов'язковий, інакше dbmate пише db/schema.sql у
#      змонтований каталог. Тут це неможливо і вдруге: монтування `:ro`.
#   4. При провалі dbmate спершу друкує `Applied: … in 11ms` і ЛИШЕ ПОТІМ
#      `Error:`. Текст виходу читати не можна — тільки код повернення; його
#      тримає `set -e`.
#   5. Кожен файл мусить мати і `-- migrate:up`, І `-- migrate:down`, інакше
#      dbmate відмовляється його котити (перевірено на 2.35.1). Наші історичні
#      міграції в down-блоці кидають виняток: forward-only лишається.
#
# І шоста, знайдена репетицією B2-exoanima: `set -a; . ./.env` ПЕРЕЗАПИСУЄ
# оточення. Змінна бази, експортована, щоб націлити прогін на копію, мовчки
# ставала живою базою з .env. Тому ціль репетиції — окреме ім'я,
# MIGRATE_DATABASE_URL, яке читається ДО .env і яке .env перебити не може.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="<продукт>-web"
IMAGE_WORKDIR="/app"
# Каталоги міграцій ВСЕРЕДИНІ образу, у порядку читання. Порядок накату
# визначає не він, а таймстамп у імені файла — наскрізно по всіх каталогах.
MIGRATION_DIRS=("apps/api/migrations/kit" "apps/api/migrations")
DBMATE="amacneil/dbmate:2.35.1"
# Ім'я змінної в .env, де лежить рядок бази. Канон — DATABASE_URL.
DATABASE_VAR="DATABASE_URL"

# До .env, і під ім'ям, якого в .env не буває: див. «шосту» вгорі.
_migrate_override_url="${MIGRATE_DATABASE_URL:-}"

if [ ! -f ./.env ]; then
  echo "немає .env — див. .env.example" >&2
  exit 1
fi
set -a; . ./.env; set +a

if [ -n "$_migrate_override_url" ]; then
  _migrate_url="$_migrate_override_url"
  _target="${_migrate_url##*@}"
  echo "УВАГА: MIGRATE_DATABASE_URL задано — котимо НЕ в базу з .env ($DATABASE_VAR), а в ${_target%%\?*}" >&2
else
  _migrate_url="${!DATABASE_VAR:-}"
  if [ -z "$_migrate_url" ]; then
    echo "$DATABASE_VAR не задано в .env — нема куди котити" >&2
    exit 1
  fi
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "образу $IMAGE немає — спершу ./deploy.sh build" >&2
  exit 1
fi

# Пастка 2: свій sslmode не чіпаємо, свого немає — додаємо.
case "$_migrate_url" in
  *sslmode=*) ;;
  *\?*) _migrate_url="${_migrate_url}&sslmode=disable" ;;
  *)    _migrate_url="${_migrate_url}?sslmode=disable" ;;
esac

# SQL береться з ОБРАЗУ, а не з робочого дерева. Так було й з раннером у коді:
# схема завжди та сама, що й код, і `./migrate.sh` після правки .sql без
# перезбірки не котить те, чого в проді ще немає. dbmate — окремий контейнер і
# в образ продукту зазирнути не може, тож файли виймаються сюди.
WORK="$(mktemp -d)"
CARRIER=""
cleanup() {
  [ -n "$CARRIER" ] && docker rm -f "$CARRIER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

CARRIER="$(docker create "$IMAGE" true)"
args=()
i=0
for dir in "${MIGRATION_DIRS[@]}"; do
  # Вкладені каталоги dbmate не обходить (перевірено), тож `migrations/kit`
  # усередині `migrations` не порахується двічі.
  docker cp "${CARRIER}:${IMAGE_WORKDIR}/${dir}" "${WORK}/${i}"
  args+=(-d "/db/${i}")
  i=$((i + 1))
done

docker run --rm \
  --name "$(basename "$PWD")-migrate" \
  --network internal \
  -v "${WORK}:/db:ro" \
  -u "$(id -u):$(id -g)" \
  -e DATABASE_URL="$_migrate_url" \
  "$DBMATE" "${args[@]}" --no-dump-schema "${1:-up}"
