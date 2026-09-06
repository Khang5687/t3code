# T3 Code fork

Fork of `pingdotgg/t3code` carrying fork-only projects on `fork-main`. Upstream vocabulary lives in
[docs/internals/glossary.md](./docs/internals/glossary.md) and is not repeated here; this file only
adds the terms the fork introduces.

## Language

### Fork workflow

**Fork-only**:
A change that lives only on `fork-main` and is never proposed upstream.
_Avoid_: custom, private, local patch

**Upstream-bound**:
A change authored for an upstream pull request and carried on `fork-main` only until it merges.
_Avoid_: contribution, backport

**Feature commit**:
The single squashed commit on `fork-main` that holds one fork-only project.
_Avoid_: patch, patch series

### Skills

**Skill**:
An instruction package a provider can run, which a user mentions as `$name` in the composer.
_Avoid_: command, slash command, plugin

**Skill source**:
Where a skill was discovered, classified by kind: Personal, Repo, Project, App, System, or Other
(upstream's `ProviderSkillSourceKind`, kept verbatim).
_Avoid_: scope, origin, location

**Skill key**:
The `{ source kind, name }` pair that identifies a skill across worktrees, providers, and provider
upgrades; the name is compared trimmed and case-insensitive.
_Avoid_: path, id, slug

**Personal skill**:
A skill discovered from the user's home configuration, visible in every project on the environment.
_Avoid_: user skill, global skill

**Project skill**:
A skill discovered under a project's workspace root or one of its worktrees.
_Avoid_: local skill, repo-local skill, workspace skill

**Disabled skill**:
A skill hidden from T3 Code's pickers and `$name` dispatch by T3 settings. The provider may still
auto-invoke it.
_Avoid_: blocked, removed, uninstalled

### Exposure

**Exposure**:
The set of listen interfaces an environment's server binds. Upstream's two-valued exposure mode
becomes a set.
_Avoid_: network access, bind host

**Listen interface**:
One interface kind the server opens a socket on: loopback (always), tailnet, or LAN.
_Avoid_: bind address, host

**Exposure preset**:
A named listen-interface set: local-only, tailscale-only, lan.
_Avoid_: mode

### Sidecars

**Sidecar**:
A helper process the environment starts, supervises, and stops alongside its server.
_Avoid_: daemon, helper, background service

**Routed instance**:
A Claude provider instance that opts into sending API traffic through the pxpipe sidecar.
_Avoid_: proxied instance, wrapped instance
