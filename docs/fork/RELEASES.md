# Fork releases

## Unreleased

### Features

**Claude's first-party remote features are off by default.** Claude Code
registers sessions with claude.ai for Remote Control and auto-loads that
account's connectors, which hands everyone who shares the account a way into
this machine. A new per-instance switch, **Allow Claude's first-party remote
features**, is off on every instance including existing ones. While it is off,
threads, text generation and the provider probes run under a policy that refuses
Remote Control and claude.ai connectors, and terminals on that instance refuse
connectors. A `claude` started by hand in a terminal still offers Remote
Control — Claude Code has no environment variable for it — so the instance card
and [Providers > Claude](../user/providers-claude.md#keep-claudeai-out-of-this-machine)
say so and name the fallback. Routing through pxpipe already closed both gates;
the card says that too. Mobile shows each Claude instance's gate read-only under
**Settings > pxpipe**.

## v0.0.42-fork.1

Built on upstream `v0.0.42`.

### What this fork is

[Khang5687/t3code](https://github.com/Khang5687/t3code) is a fork of
[pingdotgg/t3code](https://github.com/pingdotgg/t3code) that carries a few
features upstream does not have yet. The fork's `main` is a pristine mirror of
upstream. Everything fork-only lives on `fork-main`, as one squashed commit per
project rebased onto an upstream release tag, so a fork build is upstream's
release plus a readable stack of additions rather than a divergent history
([ADR 0001](../adr/0001-fork-main-feature-commit-stack.md)). Tags are
`vX.Y.Z-fork.N`, where `vX.Y.Z` is the upstream release it was rebased onto.

### Features

**Exposure is a set of interfaces.** Upstream offers loopback or everything.
This build lets you pick which interfaces the server listens on and opens one
socket per interface, so "Tailscale only" really means the kernel never opened a
LAN listener. In the desktop app it is **Settings > Connections > Exposure**,
with **Local only**, **Tailscale only**, **LAN**, and **Custom** presets;
widening asks first. On the CLI, `t3 serve --host tailnet`, `--host lan`, or
`--host tailnet,lan` name the interfaces instead of making you look up an
address. Ask for the tailnet while Tailscale is down and the server starts on
loopback and says so. See
[Remote access](../user/remote-access.md#pair-over-a-lan-or-private-network) and
[ADR 0003](../adr/0003-exposure-is-a-set-of-listen-interfaces.md).

**pxpipe sidecar.** pxpipe is a local proxy for the Anthropic Messages API that
compresses requests to cut input tokens. The environment installs a pinned copy
on first start, supervises it, and reports its health. Turn it on under
**Settings > Sidecars > pxpipe** on web or desktop, then route individual Claude
instances through it with **Route through pxpipe** on the instance. Mobile shows
each environment's sidecar status read-only under **Settings > pxpipe** and can
flip the per-instance routing switch. Full guide:
[pxpipe sidecar](../user/pxpipe-sidecar.md),
[ADR 0004](../adr/0004-pxpipe-managed-sidecar.md).

**Skills.** Three related additions:

- _Disabled-skill fold._ A new **Skills** section under **Settings > Providers**
  lists every skill your providers report and lets you switch one off. A
  disabled skill disappears from the composer pickers and its `$name` is sent as
  plain prose instead of dispatching.
- _Provenance in the pickers._ Composer skill rows carry a short source label
  (Project, Personal, System, Other) on both web and mobile, so a Personal
  `review` and a Project `review` are tellable apart.
- _Project scoping._ A project can override the environment's disabled list.
  The settings header says which one is in effect: "Using the environment list"
  or "Overriding for this project". The override replaces the environment list
  rather than merging with it.

Details and the identity rules: [ADR
0002](../adr/0002-skill-identity-and-t3-only-disable.md).

### Upstream-bound changes

One fix in this build is written against upstream and is waiting on upstream,
not on the fork:

- [#10358](https://github.com/pingdotgg/t3code/pull/10358) — the WSL backend
  binds the exposure host you picked instead of `0.0.0.0`. Open.

The skills work was first drafted as six upstream PRs
([#12120](https://github.com/pingdotgg/t3code/pull/12120),
[#12124](https://github.com/pingdotgg/t3code/pull/12124),
[#12132](https://github.com/pingdotgg/t3code/pull/12132),
[#12193](https://github.com/pingdotgg/t3code/pull/12193),
[#12194](https://github.com/pingdotgg/t3code/pull/12194),
[#12195](https://github.com/pingdotgg/t3code/pull/12195)). All six drafts are
closed, so that work ships here only.

### Platforms

No CI built this tag. Both artifacts were built by hand on the maintainer's
machine from commit `2cbac8513d`, so verify them before you install:

```
81b991de110e5fd047cfff1ab618693869a47d9543bd8c7707def38ef41affd7  T3-Code-0.0.42-fork.1-2cbac8513d-arm64.dmg
ec65cf2c46834e45e6696f77446658d82b21c0c4f02daaac5fe1842353fb0039  T3-Code-0.0.42-fork.1-2cbac8513d-arm64.zip
0a80560389e7354795bac46549a5241f074ad016e57f185e7da36c53051b0f1b  t3code-mobile-preview-arm64-v8a-2cbac8513d.apk
```

**macOS arm64 desktop**, ad-hoc signed and not notarized. Gatekeeper quarantines
it on first open. Right-click the app and pick Open, or run
`xattr -dr com.apple.quarantine` on it.

**Android**, package `com.t3tools.t3code.preview`, versionCode 1, built with
`APP_VARIANT=preview`. Signed with the throwaway debug keystore `expo prebuild`
generates, so it is not store-installable and Android refuses to install it over
a copy signed with a different key. Uninstall that copy first.

Windows, Linux, and iOS are not built for this tag. They build from source the
same way upstream does.

### Known gaps

- Exposure has no peer allowlist. Choosing an interface means every peer that
  can reach it can reach the server.
- Inside WSL, the interface selection resolves against the distro's interfaces,
  not Windows'. Under WSL2's default NAT networking `lan` binds an address on
  the WSL virtual network rather than the real LAN, and `tailnet` resolves to
  nothing unless Tailscale runs in the distro. The WSL path is untested on a
  real WSL machine.
- Disabling a skill changes T3 Code only. T3 Code never writes provider config,
  so a provider can still auto-invoke a skill you disabled.
- Skill identity is `{source, name}`, so same-named skills in two roots of the
  same kind go off together, and a skill two providers both see goes off for
  both.
- A routed Claude instance loses Claude Code's first-party client features:
  `/remote-control` and claude.ai connectors stop working. It can also lose
  prompt-cache hits, because pxpipe rewrites request bodies.
- A routed turn never falls back to Anthropic directly. If the sidecar is
  unhealthy the turn fails and the thread records the status and last error.
- An instance that sets its own `ANTHROPIC_BASE_URL` keeps it and is never
  routed; its card reads "Routing inactive".
- Mobile cannot start, stop, or configure a sidecar.
- The first pxpipe start needs network access to install the pinned version.
  Later starts work offline.

### Updating from upstream

The rebase, tagging, and nightly-sync commands live in
[WORKFLOW.md](./WORKFLOW.md).
