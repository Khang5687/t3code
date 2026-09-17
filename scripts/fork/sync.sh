#!/usr/bin/env bash
# Rebase fork-main onto an upstream ref and typecheck the result.
# Usage: scripts/fork/sync.sh [upstream-ref]     default: origin/main
#        scripts/fork/sync.sh v1.4.0
# On conflict it prints the conflicting files, aborts, and leaves fork-main alone.
set -euo pipefail

target="${1:-origin/main}"
cd "$(git rev-parse --show-toplevel)"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "fork-main" ]; then
  echo "checkout fork-main first (currently on $branch)" >&2
  exit 1
fi

if ! git diff --quiet HEAD; then
  echo "working tree is dirty; commit or set the changes aside first" >&2
  exit 1
fi

git fetch --tags origin
git fetch fork

if ! git rev-parse --verify --quiet "${target}^{commit}" >/dev/null; then
  echo "unknown upstream ref: $target" >&2
  exit 1
fi

echo "rebasing fork-main onto $target ($(git rev-parse --short "$target"))"
if ! git rebase "$target"; then
  echo "conflicts:" >&2
  git diff --name-only --diff-filter=U >&2
  git rebase --abort
  echo "rebase aborted; fork-main is unchanged" >&2
  exit 1
fi

# ponytail: the server package is the cheapest typecheck that covers the
# orchestration code most fork commits touch. Run `vp run -r typecheck` before
# tagging a release.
vp run --filter t3 typecheck

echo "fork-main is rebased onto $target and typechecks."
echo "push it with: git push --force-with-lease fork fork-main"
