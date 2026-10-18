#!/usr/bin/env bash
# Builds the site from a clean, up-to-date `main` and publishes dist/ to `origin gh-pages` as a single
# orphan commit (force-pushed), like peaceiris/actions-gh-pages with force_orphan did. GitHub Pages
# serves that branch. The working tree, the index and `main` are never modified.
# Usage: pnpm run deploy:pages   (REMOTE=origin BRANCH=gh-pages can be overridden for testing)
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE=${REMOTE:-origin}
BRANCH=${BRANCH:-gh-pages}

current=$(git rev-parse --abbrev-ref HEAD)
if [[ $current != main ]]; then
  echo "deploy-pages: must run on main (current branch: $current)" >&2
  exit 1
fi
if [[ -n $(git status --porcelain) ]]; then
  echo "deploy-pages: working tree is dirty; commit or stash first" >&2
  exit 1
fi
git fetch --quiet "$REMOTE" main
if [[ $(git rev-parse HEAD) != $(git rev-parse "$REMOTE/main") ]]; then
  echo "deploy-pages: local main differs from $REMOTE/main; run 'git pull' (or push) first" >&2
  exit 1
fi

sha=$(git rev-parse HEAD)

pnpm install --frozen-lockfile
pnpm build
touch dist/.nojekyll

# Build the orphan commit with plumbing: a throwaway index over dist/, no checkout, no parent.
# HEAD, main, the index and the working tree stay untouched; the repo's remote and credentials apply.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export GIT_INDEX_FILE=$tmp/index
git --work-tree=dist add --all --force -- .
tree=$(git write-tree)
unset GIT_INDEX_FILE
commit=$(git commit-tree "$tree" -m "deploy: $sha")
git push --force "$REMOTE" "$commit:refs/heads/$BRANCH"
echo "deploy-pages: published $sha to $REMOTE/$BRANCH ($commit)"
