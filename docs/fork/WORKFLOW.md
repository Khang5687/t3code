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

## Building releases on the fork

Every workflow on the release path runs on GitHub-hosted runners
(`ubuntu-latest`, `macos-latest`, `windows-latest`). The fork has no Blacksmith
org, so a `blacksmith-*` label queues forever. `deploy-relay.yml` still carries
one; the fork never deploys the relay.

Hosted runners are far smaller than the machines these jobs were tuned for:
`ubuntu-latest` gives 4 vCPU where `blacksmith-32vcpu-ubuntu-2404` gave 32. The
30-minute `timeout-minutes` on `release.yml`'s `build` job and on
`release-desktop.yml` was sized for the bigger machines, so raise it if a fork
build dies on the clock rather than on an error.

Dispatch a preview build:

```bash
gh workflow run release.yml -R Khang5687/t3code --ref fork-main -f channel=preview
```

Only the `preview` channel works from `fork-main`. `assertReleaseSource` in
`.github/scripts/check-nightly-release.cjs` refuses `stable` and `nightly`
dispatched from anything but the repository default branch, which is `main` on
the fork (the pristine upstream mirror). The `schedule` trigger also fires on
the default branch, so scheduled nightlies would build upstream's commit, not
the fork's. Point the fork's default branch at `fork-main` before using either.

### What each secret gates

`relay_public_config` runs before every build job and reads the production relay
state from Cloudflare, so nothing downstream starts without it.

| Secret / variable                                                                                                                                                                                                                     | Jobs that need it                                     | Without it                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `secrets.CLOUDFLARE_API_TOKEN`, `vars.CLOUDFLARE_ACCOUNT_ID`                                                                                                                                                                          | `relay_public_config`                                 | Whole release fails; no build job starts                  |
| `vars.RELAY_DOMAIN` or `vars.RELAY_API_ZONE_NAME`, `vars.CLERK_PUBLISHABLE_KEY`, `vars.CLERK_JWT_TEMPLATE`, `vars.CLERK_CLI_OAUTH_CLIENT_ID`                                                                                          | `relay_public_config`                                 | Same; the step fails on the explicit missing-config check |
| `secrets.CSC_LINK`, `secrets.CSC_KEY_PASSWORD`, `secrets.APPLE_API_KEY`, `secrets.APPLE_API_KEY_ID`, `secrets.APPLE_API_ISSUER`, `secrets.MACOS_PROVISIONING_PROFILE`, `vars.APPLE_TEAM_ID`                                           | `desktop_mac_*` via `release-desktop.yml`             | Unsigned, un-notarized DMG; the job still passes          |
| `secrets.AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` | `desktop_win_*` via `release-desktop.yml`             | Unsigned NSIS installer; the job still passes             |
| npm trusted publishing (OIDC, no secret)                                                                                                                                                                                              | `publish_cli`                                         | Fails the dry run; `release` never runs                   |
| `secrets.AUR_SSH_PRIVATE_KEY`                                                                                                                                                                                                         | `publish_aur` (stable and nightly only)               | Push to the AUR fails                                     |
| `secrets.VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`                                                                                                                                                                          | `deploy_web`, `deploy_marketing`, `web-preview.yml`   | Deploy fails                                              |
| `secrets.RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`                                                                                                                                                                                   | `finalize` (stable only), `mobile-eas-production.yml` | Token mint fails; the version bump is not pushed          |
| `secrets.DISCORD_RELEASE_WEBHOOK_URL`, `DISCORD_RELEASE_NIGHTLY_ROLE_ID`, `DISCORD_RELEASE_LATEST_ROLE_ID`                                                                                                                            | `announce_discord`                                    | Announcement fails                                        |
| `secrets.EXPO_TOKEN`                                                                                                                                                                                                                  | `mobile-eas-preview.yml`, `mobile-eas-production.yml` | EAS build fails                                           |

Signing degrades cleanly: `release-desktop.yml` checks for the whole set and
builds unsigned when any of it is missing. Supplying the Apple secrets but not
`APPLE_TEAM_ID` or `MACOS_PROVISIONING_PROFILE` is the one case that fails hard,
so set all seven or none.

To get a working fork release today, supply the relay config and let signing and
publishing fall away: the GitHub Release job uses `github.token` and needs no
secret, but `publish_cli` sits between the builds and it, so a fork that does not
own the `@t3code` npm packages has to drop that job to reach a published release.
