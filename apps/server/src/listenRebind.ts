// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  formatListenInterfaces,
  type ListenInterfaces,
  type ListenRebindResult,
} from "@t3tools/contracts";
import { ensureTailscaleServe } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HttpServer } from "effect/unstable/http";
import type { ServeError } from "effect/unstable/http/HttpServerError";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "./config.ts";
import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";
import * as ListenAddress from "./listenAddress.ts";
import { guardPeerAllowlist } from "./peerAllowlist.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  readPersistedServerRuntimeState,
} from "./serverRuntimeState.ts";

// Effect's default preemptive shutdown waits 20s before finalizing request
// scopes. T3's primary transport is long-lived WebSocket RPC, whose Effect
// scope finalizer already closes the websocket gracefully. Do not add an
// artificial drain before those finalizers get a chance to run.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;

/**
 * How long a listener that left the set keeps the sockets still doing work.
 *
 * Node's own `close()` already drops the idle keep-alive connections, so this
 * covers the two it does not: a socket mid-request, and a socket that upgraded
 * to WebSocket. One of those is usually the very socket carrying the response
 * to the rebind request, so closing at once would mean the caller never learns
 * the move succeeded; the rest of the wait is the window a connected client
 * gets to notice and move to a surviving address.
 *
 * Deliberately not `HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS`, which is zero because
 * process shutdown tears every scope down anyway and a drain there only slows
 * the exit. Here the process keeps running.
 */
const REBIND_SOCKET_GRACE_MS = 1_000;

/** A new address refused its bind, so nothing moved. */
export class ListenBindRefusedError extends Data.TaggedError("ListenBindRefusedError")<{
  readonly address: string;
  readonly port: number;
  /** The OS error code the bind refused with, for example `EADDRINUSE`. */
  readonly errorCode: string;
}> {}

/**
 * Exactly what `HttpRouter.serve` handed us, replayed onto listeners opened
 * later. Read off `HttpServer.make`'s option, not off the service's `serve`:
 * the service type is overloaded and `Parameters` there resolves the generic
 * overload with `unknown` for both `E` and `R`.
 */
type ServeArgs = Parameters<Parameters<typeof HttpServer.make>[0]["serve"]>;

interface Listener {
  readonly host: string;
  readonly port: number;
  readonly node: NodeHttp.Server;
  /** Live WebSocket sockets on this listener; see `createNodeServer`. */
  readonly upgraded: ReadonlySet<NodeNet.Socket>;
  /** Closing this closes the platform server, its ws server, and its handlers. */
  readonly scope: Scope.Closeable;
  readonly server: HttpServer.HttpServer["Service"];
}

export interface ListenRebindInput {
  readonly listenInterfaces: ListenInterfaces;
  /** Absent keeps the port the server is already on. */
  readonly port?: number | undefined;
}

/**
 * The HTTP result plus what only the apply can know. `previousPort` stays off
 * the wire: it exists so the caller can tell a port change, which retires every
 * listener, from an interface-only change, which leaves the sockets on the
 * addresses that stayed.
 */
export interface ListenRebindOutcome extends ListenRebindResult {
  readonly previousPort: number;
}

export class ListenRebind extends Context.Service<
  ListenRebind,
  {
    /** Moves the listener set, or fails leaving the previous set fully bound. */
    readonly rebind: (
      input: ListenRebindInput,
    ) => Effect.Effect<ListenRebindOutcome, ListenBindRefusedError>;
  }
>()("t3/listenRebind") {}

const errorCodeOf = (error: ServeError): string => {
  const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
};

const addressKey = (host: string, port: number) => `${host}:${port}`;

/**
 * One listening socket per resolved address (ADR 0003), held in a mutable set
 * so the selection can move without restarting the process (Amendment 1).
 * Nothing binds a wildcard unless a wildcard was asked for, and the first bind
 * fixes the port, which keeps `--port 0` landing every address on one ephemeral
 * port.
 *
 * `serve` is called once, by `HttpRouter.serve` at layer build. The request
 * handler it hands over is captured here, so a listener opened later serves the
 * identical application.
 */
export const makeListenerSet = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const startup = yield* ListenAddress.ListenAddress;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const layerScope = yield* Effect.scope;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  // The live reading of the selection. `ListenAddress` deliberately keeps the
  // startup one; see the comment on that service.
  let listen = startup;
  let allowedPeers = startup.allowedPeers;
  let served: ServeArgs | undefined;
  const listeners: Array<Listener> = [];
  const openScopes = new Set<Scope.Closeable>();

  /**
   * The Node server plus the sockets that left HTTP for the WebSocket protocol.
   * An upgrade detaches the socket from the server's connection tracking, so
   * `closeAllConnections()` does not touch it (verified against Node 24). T3's
   * primary transport is WebSocket RPC, so without this set a retired address
   * would keep serving its existing clients forever and the ws server's own
   * close would park waiting for them to drain.
   */
  const createNodeServer = () => {
    const node = guardPeerAllowlist(
      guardHttpResponseWriteErrors(NodeHttp.createServer()),
      () => allowedPeers,
      (address) => {
        runFork(
          Effect.logWarning(
            `rejected connection from ${address}: not in the peer allowlist (${(allowedPeers ?? []).join(", ")})`,
          ),
        );
      },
    );
    const upgraded = new Set<NodeNet.Socket>();
    node.on("upgrade", (_request, socket: NodeNet.Socket) => {
      upgraded.add(socket);
      socket.once("close", () => upgraded.delete(socket));
    });
    return { node, upgraded };
  };

  /** Closes a listener's scope and stops tracking it for shutdown. */
  const discardScope = (scope: Scope.Closeable) =>
    Effect.sync(() => openScopes.delete(scope)).pipe(Effect.andThen(Scope.close(scope, Exit.void)));

  const closeListener = (listener: Listener) => discardScope(listener.scope);

  const openListener = (host: string, port: number) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      openScopes.add(scope);
      const { node, upgraded } = createNodeServer();
      const server = yield* NodeHttpServer.make(() => node, {
        host,
        port,
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
        // Negotiate permessage-deflate with clients that offer it; clients
        // that don't still get uncompressed frames on their connection.
        // Context takeover stays enabled (ws default) so the compression
        // window is shared across frames — that also makes small frames cheap
        // to compress, so no size threshold is set (ws only honors
        // `threshold` when context takeover is disabled).
        websocket: { perMessageDeflate: true },
      }).pipe(
        Scope.provide(scope),
        Effect.tapError(() => discardScope(scope)),
      );
      const address = server.address;
      const listener: Listener = {
        // Only a TCP bind reports a port; a Unix socket keeps the configured one.
        port: address._tag === "TcpAddress" ? address.port : port,
        host,
        node,
        upgraded,
        scope,
        server,
      };
      if (served !== undefined) {
        // `HttpServer.make` types the served effect with `unknown` in its error
        // channel, and installing it on one more listener cannot narrow that.
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off
        yield* server.serve(served[0], served[1]!).pipe(Scope.provide(scope));
      }
      return listener;
    });

  /**
   * Binds every host in order and hands back what it opened; on the first
   * refusal it closes what it already opened and fails. Binding for real is the
   * probe the atomic apply needs -- a new address never collides with a
   * surviving one, so nothing else proves the address is free.
   */
  const openAll = (hosts: ReadonlyArray<string>, port: number) =>
    Effect.gen(function* () {
      const opened: Array<Listener> = [];
      let current = port;
      yield* Effect.onError(
        Effect.gen(function* () {
          for (const host of hosts) {
            const listener = yield* openListener(host, current).pipe(
              Effect.mapError(
                (error) =>
                  new ListenBindRefusedError({
                    address: host,
                    port: current,
                    errorCode: errorCodeOf(error),
                  }),
              ),
            );
            opened.push(listener);
            current = listener.port;
          }
        }),
        () => Effect.forEach(opened, closeListener, { discard: true, concurrency: "unbounded" }),
      );
      return opened;
    });

  /**
   * Retiring is two steps on purpose. `close()` drops the listening socket, so
   * the address stops accepting the moment the new set is in place. The sockets
   * already up are closed separately, at the very end of the apply, because the
   * request that asked for the rebind is usually riding one of them and the
   * steps in between (a filesystem write, a `tailscale` spawn) can outlast the
   * grace on their own.
   */
  const stopAccepting = (listener: Listener) =>
    Effect.sync(() => {
      listener.node.close();
    });

  const closeSocketsAfterGrace = (listener: Listener) =>
    Effect.sleep(REBIND_SOCKET_GRACE_MS).pipe(
      Effect.andThen(
        Effect.sync(() => {
          listener.node.closeAllConnections();
          for (const socket of listener.upgraded) {
            socket.destroy();
          }
        }),
      ),
      Effect.andThen(closeListener(listener)),
      Effect.forkIn(layerScope),
      Effect.asVoid,
    );

  listeners.push(...(yield* openAll(listen.bindHosts, config.port)));

  const primary = () => {
    const first = listeners[0];
    if (first === undefined) {
      // A selection always resolves to at least one address, and a rebind only
      // retires listeners once their replacements are bound.
      throw new Error("A listen selection always resolves to one address");
    }
    return first;
  };

  const server = HttpServer.make({
    // A getter, not a snapshot: everything that reads `server.address` after a
    // rebind -- runtime state, Tailscale Serve, the cloud link -- has to see
    // the port the server is actually on.
    get address() {
      return primary().server.address;
    },
    // The served effect's `unknown` error channel, restated for the fan-out.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    serve: (httpEffect, middleware) =>
      Effect.gen(function* () {
        // The captured effect keeps `unknown` in its error channel; storing it
        // cannot narrow that any more than fanning it out can.
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off
        served = [httpEffect, middleware];
        yield* Effect.forEach(
          listeners,
          (listener) =>
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off
            listener.server.serve(httpEffect, middleware!).pipe(Scope.provide(listener.scope)),
          { discard: true },
        );
      }),
  });

  const rewriteRuntimeState = (port: number) =>
    Effect.gen(function* () {
      // Whether a launcher supervises this process is settled at startup and
      // cannot change under it, so it is read back rather than re-derived from
      // a service this layer has no other reason to depend on.
      const previous = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      const serviceManaged = Option.isSome(previous) && previous.value.serviceManaged === true;
      const state = yield* makePersistedServerRuntimeState({
        listen,
        devUrl: config.devUrl,
        port,
        ...(serviceManaged ? { serviceManaged: true } : {}),
      });
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        // The process did not restart, so it did not start again either; a
        // fresh `startedAt` would make uptime lie.
        state: Option.isSome(previous) ? { ...state, startedAt: previous.value.startedAt } : state,
      });
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to rewrite server runtime state after a rebind", { cause }),
      ),
    );

  /**
   * Only when Serve is on and the port actually moved: Serve points at a local
   * port, so a selection that kept its port has nothing to re-point, and
   * shelling out to `tailscale` for a no-op is a process nobody asked for.
   */
  const repointTailscaleServe = (port: number, movedFrom: number) =>
    config.tailscaleServeEnabled && port !== movedFrom
      ? ensureTailscaleServe({
          localPort: port,
          servePort: config.tailscaleServePort,
          localHost: "127.0.0.1",
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.as(true),
          // A Tailscale hiccup must not undo a listen change that worked.
          Effect.catch((cause) =>
            Effect.logWarning("Failed to re-point Tailscale Serve after a rebind", {
              cause,
              localPort: port,
              servePort: config.tailscaleServePort,
            }).pipe(Effect.as(false)),
          ),
        )
      : Effect.succeed(false);

  // One apply at a time. Two overlapping applies would interleave their reads
  // and writes of the listener set and could leave half of each set bound.
  const applying = yield* Semaphore.make(1);

  const rebind = (input: ListenRebindInput) =>
    applying.withPermits(1)(
      Effect.gen(function* () {
        // Resolved here, never by the caller: kinds and `allow:` entries mean
        // what this machine's interface table says they mean (ADR 0003).
        const resolved = ListenAddress.resolveListenAddress(
          formatListenInterfaces(input.listenInterfaces),
        );
        const previousPort = primary().port;
        const port = input.port ?? previousPort;
        const wanted = resolved.bindHosts;
        const surviving = new Map(
          listeners
            .filter((listener) => listener.port === port && wanted.includes(listener.host))
            .map((listener) => [addressKey(listener.host, listener.port), listener] as const),
        );
        const toRetire = listeners.filter(
          (listener) => surviving.get(addressKey(listener.host, listener.port)) !== listener,
        );

        const opened = yield* openAll(
          wanted.filter((host) => !surviving.has(addressKey(host, port))),
          port,
        );

        // Only now, so a refused bind leaves the surviving listeners enforcing
        // exactly the list they were enforcing before the call. The guard reads
        // this on every accept rather than capturing it, which is how a
        // surviving listener follows the new selection without being recreated.
        allowedPeers = resolved.allowedPeers;

        const fresh = new Map(
          opened.map((listener) => [addressKey(listener.host, listener.port), listener]),
        );
        listeners.length = 0;
        for (const host of wanted) {
          const listener =
            surviving.get(addressKey(host, port)) ?? fresh.get(addressKey(host, port));
          if (listener !== undefined) {
            listeners.push(listener);
          }
        }
        listen = resolved;

        yield* Effect.forEach(toRetire, stopAccepting, { discard: true });
        yield* rewriteRuntimeState(port);
        const tailscaleServeRepointed = yield* repointTailscaleServe(port, previousPort);

        // Last, so the grace covers the response to this very request rather
        // than the work above it.
        yield* Effect.forEach(toRetire, closeSocketsAfterGrace, { discard: true });

        yield* Effect.logInfo("Rebound the listener set", { addresses: wanted, port });
        return {
          addresses: wanted,
          port,
          previousPort,
          warnings: resolved.warnings,
          tailscaleServeRepointed,
        };
      }),
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...openScopes], (scope) => Scope.close(scope, Exit.void), {
      discard: true,
      concurrency: "unbounded",
    }),
  );

  return { server, listenRebind: ListenRebind.of({ rebind }) };
});
