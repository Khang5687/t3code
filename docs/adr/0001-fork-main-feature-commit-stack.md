# Carry fork-only work as one squashed feature commit per project, rebased onto upstream release tags

This fork tracks a fast-moving upstream (`pingdotgg/t3code`) while carrying a handful of fork-only projects. `fork-main` is always `origin/main` + upstream-bound cherry-picks (`[upstream-bound] …`, directly above `origin/main`, kept only until the upstream PR merges) + one squashed `[fork] …` feature commit per project; fixups are squashed into their feature commit before every rebase. We rebase onto upstream release tags (and on demand), tag the result `vX.Y.Z-fork.N`, and keep the fork's `main` as a pristine mirror. Upstream-bound work is authored on `ub/<slug>` branches off `origin/main` so it stays PR-able.

We chose this over merge-based integration (conflicts resurface across many commits and the history stops being readable against upstream) and over one long-lived branch per project (nothing ever integrates them). Consequences: `fork-main` is force-pushed on every rebase, and CI must be enabled for it explicitly — upstream's `ci.yml` only runs on `main`.

## Amendment 1 (v0.0.42-fork.3)

Projects that were built in parallel and integrated by merge (their commits interleave and a merge carries a hand-resolved hunk) cannot be re-split into one commit each without re-resolving conflicts. In that case the release carries **one squashed `[fork]` commit for the whole batch**, built from the integrated tree (`git commit-tree`) so it is byte-identical to what was tested; the commit body lists each project. The one-commit-per-project rule still applies to work done serially, and to the next rebase: split then only if a project needs to be dropped or upstreamed on its own.
