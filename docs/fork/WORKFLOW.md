# Fork workflow

How this fork tracks `pingdotgg/t3code` and carries its own work. The reasoning
lives in [ADR 0001](../adr/0001-fork-main-feature-commit-stack.md); this page is
the set of commands.

## Branches

| Branch      | Remote | What it holds                                                                      |
| ----------- | ------ | ---------------------------------------------------------------------------------- |
| `main`      | `fork` | Pristine mirror of upstream `main`. Only the nightly fast-forwards it.             |
| `fork-main` | `fork` | `origin/main` + `[upstream-bound]` cherry-picks + one `[fork]` commit per project. |
| `ub/<slug>` | `fork` | Upstream-bound work, branched off `origin/main` so it stays PR-able.               |

Remote names differ between your checkout and CI. Locally `origin` is upstream
and `fork` is ours. In Actions the checkout names the fork `origin`, so
`fork-sync.yml` adds upstream as a second remote called `upstream`.

Fixups get squashed into their `[fork]` commit before every rebase, so
`fork-main` is force-pushed each time. Always use `--force-with-lease`.

## Rebasing onto a new upstream release

```bash
git switch fork-main
scripts/fork/sync.sh v1.4.0        # or omit the ref to use origin/main
git push --force-with-lease fork fork-main
```

The script refuses to run on any other branch or with a dirty tree. It fetches
both remotes, rebases, and typechecks `apps/server`. On a conflict it prints the
conflicting paths, runs `git rebase --abort`, and exits non-zero, so `fork-main`
is never left mid-rebase.

Run the wider checks before you tag: `vp run -r typecheck` and `vp run -r test`.

## Cutting a fork tag

Tags are `vX.Y.Z-fork.N`, where `vX.Y.Z` is the upstream release you rebased
onto and `N` counts from 1 for each fork build on that release.

```bash
git tag -a v1.4.0-fork.1 -m "fork build 1 on upstream v1.4.0"
git push fork v1.4.0-fork.1
```

Bump `N` when you retag the same upstream release. Reset to 1 on the next
upstream release.

## The nightly sync

`.github/workflows/fork-sync.yml` runs at 09:17 UTC and on manual dispatch. It
does two things:

1. Fast-forwards the fork's `main` to upstream `main`. A plain `git push` is
   fast-forward only, so the mirror cannot diverge. Nothing is ever forced.
2. Rebases `fork-main` onto `upstream/main` in the runner's throwaway checkout
   as a dry run. It never pushes `fork-main`.

Trigger it by hand from the Actions tab, or with
`gh workflow run fork-sync.yml -R Khang5687/t3code`.

It needs `contents: write` to push the mirror and `issues: write` to file the
conflict issue. Both are declared in the workflow and satisfied by the default
`GITHUB_TOKEN`; no PAT or repo secret is involved. If the fork's Actions
settings are set to read-only token permissions, the mirror push fails with a 403. Fix it under Settings, Actions, General, Workflow permissions.

## When the nightly opens a conflict issue

The issue is titled `fork-main rebase conflict on upstream <short sha>` and
labelled `needs-triage`. It lists the files that conflicted at the first stopped
commit. Later commits in the stack may conflict too; the dry run stops at the
first one.

Resolve it locally. The nightly only reports.

```bash
git switch fork-main
scripts/fork/sync.sh                # confirm it still conflicts
git rebase origin/main              # then resolve by hand
# ... fix conflicts, git add, git rebase --continue ...
vp run --filter t3 typecheck
git push --force-with-lease fork fork-main
```

Close the issue once `fork-main` is pushed. A rerun on the same upstream commit
comments on the open issue instead of filing a duplicate, so an unresolved
conflict accumulates one thread rather than one issue per night.
