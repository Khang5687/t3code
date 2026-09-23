# Fork releases

## v0.0.42-fork.3

Built on upstream `v0.0.42`. Adds five features on top of `v0.0.42-fork.2`;
everything in that release is still here. The five land as one squashed
`[fork]` commit (they were built in parallel and integrated by merge — see
[ADR 0001](../adr/0001-fork-main-feature-commit-stack.md), Amendment 1).

### Features

**Fork a thread from a past user message.** "Edit from here" rewinds a thread
and throws the rest away. Forking keeps the original: pick any of your earlier
messages, and a new thread starts with the history up to that point and your
message pre-filled in the composer. Fork into the same workspace, or, when the
source turn has a checkpoint, into a new worktree that is restored to that
checkpoint and runs the project setup script (the checkout shows as a setup
card; a failed one can be retried). The fork's provider session is resolved on
its first send; Codex forks get a native thread, and if a session cannot be
resumed the fork carries on from its copied history with a warning. Forking
works while the source is still running. **Settings > General > After forking**
chooses between opening the fork and staying put. Web, desktop, and mobile
(touch and hold a message). See [Forking](../user/forking.md).

**Copy a message's ID.** For debugging: hover a timeline row on web (long-press
on mobile) and copy its bare ID, or a `thread=…;turn=…;message=…` reference that
matches the event log.

**`/` opens the skill menu mid-prompt.** A `/` after whitespace opens the skill
menu anywhere in the prompt, not only at the start of a line. Paths and URLs
(`/usr/bin`, `https://`) never trigger it. Web and mobile.

**Agents panel sorted by status.** Direct spawns group into Working, Waiting,
and Settled; rows move only on a status change, Settled collapses past five,
and the sort choice is remembered.

**Exposure changes apply live.** Changing interfaces or port in
**Settings > Connections** now rebinds the running server in place instead of
relaunching the app. Connected clients are told the server moved; a port change
shows a "Reconnect" action. A bind that fails rolls back to the old listener set
([ADR 0003](../adr/0003-exposure-is-a-set-of-listen-interfaces.md), Amendment 1).

### Known gaps

- Mobile was verified by tests and typecheck only; the device pass is the
  checklist in [MOBILE-VERIFICATION.md](./MOBILE-VERIFICATION.md).
- Cursor, Grok, and Antigravity threads offer no fork action (they do not
  support conversation rollback).
- Under WSL, a live rebind narrowing to loopback leaves the WSL backend bound
  on its previous address until the app is restarted.

## v0.0.42-fork.2

Built on upstream `v0.0.42`. Supersedes the `v0.0.42-fork.1` draft, which was
never published.

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

**Queue and steer are two different things.** Upstream's queue held a message
in the web client until the agent's next tool call and then sent it as a steer,
so Queue and Steer were the same thing one tool call apart, and the queue died
on reload or thread switch. Now a queued message is server state: it waits as a
dashed bubble at the end of the thread, starts a turn of its own once the
running turn ends, and several queued messages run one after another, one turn
each, in order. It survives a reload, a thread switch, and a closed tab, and
every client on the thread shows the same rows. Steer sends into the running
turn at once. Enter queues, `mod+Enter` steers, and **Settings > General >
Follow-up behavior** flips the default. Stop, a failed turn, and a pending
approval or question hold the queue; held rows wait for **Send now**, so a queue
never fires into a session that needs you first. **Remove** puts the text back
in the composer. Mobile shows the rows and can remove them. Provider adapters
are untouched. See [Composer](../user/composer.md#send-while-the-agent-is-working).

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

No CI builds this tag. The artifacts are built by hand on the maintainer's
machine and attached to the release with a `SHA256SUMS` file; the commit they
were built from is in each file name. Verify against `SHA256SUMS` before you
install. Do not reuse the `fork.1` draft's builds, they are from `2cbac8513d`
and predate everything in this release.

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
- Removing a queued message restores its attachments only on the client that
  queued it; from another client or after a reload you get the text back and a
  note that the attachments stayed behind.
- Mobile can see and remove queued messages but cannot send one early.
- A queued message runs under whatever model and mode the thread has when it
  drains, not what was selected when it was queued.

### Updating from upstream

The rebase, tagging, and nightly-sync commands live in
[WORKFLOW.md](./WORKFLOW.md).
