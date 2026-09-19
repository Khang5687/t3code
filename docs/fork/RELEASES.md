# Fork releases

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

**Peer allowlist.** Binding an interface used to mean every peer that could
reach it could reach the server. Now you can name who may connect: `--allow-peer
10.0.0.0/8` on the CLI, `T3CODE_ALLOWED_PEERS` in the environment, or **Restrict
who may connect** in the desktop exposure panel. Entries are IPv4 or IPv6
addresses or CIDRs. The allowlist only narrows: loopback is always allowed, and a
bind on a wildcard address with no allowlist is called out as such. Rejected
connections are destroyed before any HTTP byte and logged once per peer per
minute. Under WSL, `lan` and `tailnet` now warn at startup and in the exposure
panel when the bind cannot reach what it claims (WSL2 NAT hides the real LAN;
`tailnet` needs Tailscale in the distro), and WSL1 is no longer told to switch a
networking mode it does not have.

**pxpipe sidecar.** pxpipe is a local proxy for the Anthropic Messages API that
compresses requests to cut input tokens. The environment installs a pinned copy
on first start, supervises it, and reports its health. Turn it on under
**Settings > Sidecars > pxpipe** on web or desktop, then route individual Claude
instances through it with **Route through pxpipe** on the instance. Mobile shows
each environment's sidecar status read-only under **Settings > pxpipe** and can
flip the per-instance routing switch. Routing does not cost prompt-cache hits:
pxpipe's rewrite is deterministic and the cached prefix stays byte-stable, so
you pay one cache write on the turn after you flip the switch. Full guide:
[pxpipe sidecar](../user/pxpipe-sidecar.md),
[ADR 0004](../adr/0004-pxpipe-managed-sidecar.md).

**Claude's first-party remote features are off by default.** Claude Code
registers sessions with claude.ai for Remote Control and auto-loads that
account's connectors, which hands everyone who shares the account a way into
this machine. A per-instance switch, **Allow Claude's first-party remote
features**, is off on every instance including existing ones. While it is off,
threads, text generation and the provider probes run under a policy that refuses
Remote Control and claude.ai connectors, and terminals on that instance refuse
connectors. A `claude` started by hand in a terminal still offers Remote
Control, Claude Code has no environment variable for it, so the instance card
and [Providers > Claude](../user/providers-claude.md#keep-claudeai-out-of-this-machine)
say so and name the fallback. On a machine an IT department manages, Claude Code
drops T3 Code's policy whole and Remote Control stays available; the card and the
guide say that too rather than drawing a gate that is not closed. Routing through
pxpipe already closed both gates. Mobile shows each Claude instance's gate
read-only under **Settings > pxpipe**.

**Skills.** Three related additions:

- _Disabled-skill fold._ A new **Skills** section under **Settings > Providers**
  lists every skill your providers report and lets you switch one off. A
  disabled skill disappears from the composer pickers and its `$name` is sent as
  plain prose instead of dispatching. The switch reads "Show `name` in T3 Code"
  because that is all it does: T3 Code never writes provider config, so the
  provider can still auto-invoke a hidden skill, and each row says so. Rows also
  name the other folders a switch covers when two roots share a skill name.
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

- Inside WSL, the interface selection resolves against the distro's interfaces,
  not Windows'. The server warns when a `lan` or `tailnet` bind cannot reach
  what it claims, but the whole WSL path is untested on a real WSL machine.
- Hiding a skill changes T3 Code only. The provider can still auto-invoke it;
  the only real off switch is the provider's own config.
- Skill identity is `{source, name}`, so same-named skills in two roots of the
  same kind go off together, and a skill two providers both see goes off for
  both.
- The first-party gate covers what T3 Code spawns. A `claude` you start by hand
  in a terminal still offers Remote Control, and IT-managed Claude settings
  override the gate entirely; the instance card says which case applies.
- A routed Claude instance loses Claude Code's first-party client features
  (Remote Control, claude.ai connectors) whatever the gate says.
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
