#!/usr/bin/env bash
# Реліз @exo/kit: скан → тести → збірка dist/ → коміт → тег vX.Y.Z → push.
#
# Порядок не випадковий. Скан іде ПЕРШИМ: у публічному репозиторії секрет,
# який доїхав до push, уже засвічений, і жоден наступний коміт цього не
# скасує. Збірка йде ПІСЛЯ тестів, бо dist/ комітиться, і комітити артефакт
# із незеленого дерева — це покласти в реліз те, чого ніхто не перевіряв.
#
#   ./scripts/release.sh 0.1.0
#
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Вжиток: $0 X.Y.Z" >&2
  exit 1
fi
TAG="v$VERSION"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Тег $TAG уже існує. Версія — це те, на що посилаються продукти: не переставляти." >&2
  exit 1
fi

# Робоче дерево має бути чистим, крім того, що змінює сам реліз (package.json,
# CHANGELOG.md, dist/). Інакше в тег поїде щось, чого автор релізу не бачив.
if ! git diff --quiet -- ':!package.json' ':!CHANGELOG.md' ':!dist' ||
   ! git diff --cached --quiet; then
  echo "Робоче дерево брудне поза package.json / CHANGELOG.md / dist/." >&2
  git status --short >&2
  exit 1
fi

if ! grep -q "^## $TAG" CHANGELOG.md; then
  echo "У CHANGELOG.md немає розділу '## $TAG'. Реліз без запису — це тег, про який нічого не відомо." >&2
  exit 1
fi

GITLEAKS="${GITLEAKS:-$(command -v gitleaks || echo /srv/shared/bin/gitleaks)}"
if [ ! -x "$GITLEAKS" ]; then
  echo "gitleaks не знайдено ($GITLEAKS) — реліз зупинено." >&2
  exit 1
fi

echo "── 1/5 скан на секрети ──"
"$GITLEAKS" dir . --redact --no-banner --config .gitleaks.toml

echo "── 2/5 типи і тести ──"
npm run typecheck
npm test

echo "── 3/5 збірка dist/ ──"
npm run build
test -f dist/index.js || { echo "dist/ порожній після збірки" >&2; exit 1; }

echo "── 4/5 версія і коміт ──"
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
git add package.json CHANGELOG.md dist
git commit -m "Реліз $TAG"
git tag -a "$TAG" -m "@exo/kit $TAG"

echo "── 5/5 push ──"
git push origin HEAD
git push origin "$TAG"

echo
echo "Готово. Продукт підключає так:"
echo "  npm i github:eXocriador/exo-kit#$TAG"
