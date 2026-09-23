# Spec: live rebind of listen interfaces and port

Status: implemented (01 5f35281398 / 02 23b7d58212 / 03 4443559912). Grilled 2026-09-22; frontier empty.
Amends ADR-0003 (see `docs/adr/0003-exposure-is-a-set-of-listen-interfaces.md`, "Amendment 1").

## Problem Statement

Switching Settings → Connections while agents are running (LAN only → Tailscale only, or changing the port) restarts the whole desktop backend. Every running turn errors with `ORPHANED_PROVIDER_SESSION_ERROR`, the thread flips to "error", and the user has to send "continue". Thread `8342f74e-6eb3-43f2-940b-48aa4dd19660` shows exactly this: the user changed the listen set mid-turn, the server restarted, and both running agents died.

## Solution

Changing the listen interface set or the port rebinds the HTTP/WS listeners in place. The backend process, provider sessions, and running turns all survive. Clients briefly reconnect and are told why. If the new set cannot be bound, nothing changes and the user sees why.

## User Stories

1. As a desktop user, I want to switch LAN → Tailscale while agents are running, so that my turns keep going.
2. As a desktop user, I want to switch Tailscale → LAN while agents are running, so that my turns keep going.
3. As a desktop user, I want to change the port while agents are running, so that I don't have to wait for turns to finish.
4. As a desktop user, I want the change to fail cleanly if the new port is busy, so that I never lose my current listeners.
5. As a desktop user, I want a toast telling me the server moved (interface or port), so that I know why the client reconnected.
6. As a phone user connected over Tailscale, I want a short grace window and a "reconnect to :NEW" hint when the port changes, so that I am not silently cut off.
7. As a desktop user, I want the peer allowlist to follow the new interface set automatically, so that I do not have to reconfigure access.
8. As a desktop user with Tailscale Serve enabled, I want Serve re-pointed to the new port, so that my public URL keeps working.
9. As a desktop user, I want a Serve re-point failure to be a warning not a rollback, so that a Tailscale hiccup does not undo a valid listen change.
10. As a developer, I want the rebind path to be the only path for connection changes, so that "requiresBackendRelaunch" never fires for listen/port changes.
11. As a developer, I want a plain reconnect (network blip) to not show the "server moved" toast, so that the toast means something.
12. As a developer, I want provider session ids unchanged across a rebind, so that continuation logic is untouched.

## Implementation Decisions

- **Unit of change is the listener set** `{host, port}[]`. Interface set and port are two dimensions of one diff; there is no separate port code path.
- **Apply is atomic.** Probe-bind every new `{host, port}` first. Only after all succeed, close listeners that are no longer in the set. On any bind failure: close the probes, keep the old set, return a typed error over IPC. Never fall back to a restart.
- **Server-side:** the HTTP server layer holds its bound listeners in a mutable ref and exposes a `setListenInterfaces(input)` RPC that performs the diff. The WS layer keeps its upgrade handler attached to whichever `http.Server` instances are live; open sockets on removed listeners are closed with a "server moved" close reason.
- **Grace for removed listeners:** removed listeners stop accepting immediately but keep existing sockets open for `HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS`, after pushing a `server.moved` message carrying the new advertised endpoints.
- **Desktop-side:** `DesktopServerExposure` computes the new listener set from the selection + port, calls the RPC, and updates advertised endpoints on success. `requiresBackendRelaunch` returns false for interface/port changes. Tailscale Serve is re-pointed only if Serve is enabled; failure there is logged and surfaced as a warning.
- **Peer allowlist** is recomputed from the new interface set inside the same apply; there is no separate setting.
- **Client:** on a `server.moved` message (or a close with that reason), reconnect to the first advertised endpoint that matches its current transport. Show a toast only when a moved message was received; a plain reconnect shows nothing. If the port changed, the toast has a "Reconnect to :NEW" action.
- **Startup unchanged.** The initial bind still comes from the persisted selection; this spec only changes what happens on edit.

## Testing Decisions

- Good test = drive the public surface (RPC / IPC), assert on observable sockets and messages, never on internal refs.
- **Single seam: server RPC.** In the server test suite: start on set X, call `setListenInterfaces` with set Y (different hosts and/or port); assert old ports refuse connections after grace, new ports accept, WS clients got `server.moved`, provider session ids unchanged. Second case: new port is pre-occupied by a dummy listener; assert the RPC errors and set X is still fully bound.
- Desktop: one unit test that interface and port changes no longer mark `requiresBackendRelaunch`.
- Prior art: existing server startup/bind tests in the server test suite and the exposure change tests in the desktop backend.
- No Electron or end-to-end test.

## Out of Scope

- Changing the auth/token scheme on rebind.
- Rebinding when the selected Tailscale interface does not exist yet (still an error, same as startup).
- WSL2 mirrored-mode quirks (ADR-0003 already covers them; unchanged).
- Mobile client UI beyond showing the toast.

## Further Notes

Root cause detail from the analysis of thread `8342f74e-…`: the restart was triggered by the desktop exposure change path, not by the provider. The provider continuation marker (`markRunningProviderSessionsForContinuation`) is a mitigation for genuine restarts and stays as-is.
