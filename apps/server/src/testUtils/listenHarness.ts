// Fork-only (Khang5687/t3code #3, Seam 1). Boots the real listen path in
// process: `ServerConfig` -> `ListenAddress` -> `HttpServerLive` -> the real
// `auth` HTTP group, with an injectable network-interface map. Tests then
// probe the bound socket over raw TCP and read the auth policy from the
// public `/api/auth/session` descriptor, the same route clients use.
//
// Only the `auth` and `listen` groups are served. `HttpApiBuilder.layer`
// demands a handler for every group on the api it is given, so a trimmed
// `HttpApi` carrying just those two lets the production `authHttpApiLayer` and
// `listenHttpApiLayer` mount unchanged (group services key on api id + group
// id, both preserved).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi, EnvironmentId } from "@t3tools/contracts";
import type { ServerAuthPolicy } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as NodeNet from "node:net";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ListenAddress from "../listenAddress.ts";
import { listenHttpApiLayer } from "../listenHttp.ts";
import * as ListenRebind from "../listenRebind.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import { HttpServerLive } from "../server.ts";

export interface ListenHarnessOptions {
  /** Mirrors `--host`. Undefined is the CLI default. */
  readonly host?: string | undefined;
  /** Injected interface table; `{}` means "no NICs" and is the deterministic default. */
  readonly interfaces?: ListenAddress.NetworkInterfacesMap;
  readonly config?: Partial<ServerConfig.ServerConfig["Service"]>;
  /**
   * Replaces the resolved allowlist after `--host` has been read. Tests run over
   * loopback, which the resolver always allows, so proving the rejection path
   * needs a list that loopback is not on -- which no real selection produces.
   */
  readonly allowedPeersOverride?: ReadonlyArray<string>;
}

export type TcpProbeOutcome =
  | { readonly outcome: "accept" }
  | { readonly outcome: "refuse"; readonly code: string };

class ListenHarnessError extends Data.TaggedError("ListenHarnessError")<{
  readonly cause: unknown;
}> {}

export interface ListenHarness {
  readonly listen: ListenAddress.ResolvedListenAddress;
  /** Ephemeral port the server actually bound. */
  readonly port: number;
  /** Real TCP connect to `address:port`; never resolves hostnames. */
  readonly probe: (address: string, port?: number) => Effect.Effect<TcpProbeOutcome>;
  /** Policy as served by the unauthenticated `/api/auth/session` descriptor, over loopback. */
  readonly readAuthPolicy: Effect.Effect<ServerAuthPolicy, ListenHarnessError>;
  /**
   * The same descriptor read over one specific bound address. A TCP probe only
   * proves the socket is open; this proves that address serves the real routes,
   * which is what distinguishes a true per-address bind from a single listener.
   */
  readonly readAuthPolicyAt: (
    address: string,
    port?: number,
  ) => Effect.Effect<ServerAuthPolicy, ListenHarnessError>;
  /**
   * The live rebind, driven at the service the authenticated
   * `POST /api/listen/interfaces` handler calls. The route itself is mounted
   * below, so a contract break still shows up here, but a test does not have to
   * mint an `access:write` token to exercise the socket moves.
   */
  readonly rebind: ListenRebind.ListenRebind["Service"]["rebind"];
  /** Where this harness writes its runtime state, which a rebind rewrites. */
  readonly serverRuntimeStatePath: string;
}

const harnessApi = HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.listen);

const harnessRoutes = HttpApiBuilder.layer(harnessApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(listenHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  // The route announces a move on the lifecycle stream; nothing in the harness
  // subscribes, so this only has to exist.
  Layer.provide(ServerLifecycleEvents.layer),
);

const harnessAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-listen-harness")),
    }),
  ),
);

const listenAddressLayer = (options: ListenHarnessOptions) => {
  const base = ListenAddress.layer({ interfaces: options.interfaces ?? {} });
  return options.allowedPeersOverride === undefined
    ? base
    : Layer.effect(
        ListenAddress.ListenAddress,
        Effect.gen(function* () {
          const listen = yield* ListenAddress.ListenAddress;
          return { ...listen, allowedPeers: options.allowedPeersOverride };
        }),
      ).pipe(Layer.provide(base));
};

const harnessConfigLayer = (options: ListenHarnessOptions) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const base = yield* ServerConfig.ServerConfig;
      return ServerConfig.make({
        ...base,
        host: options.host,
        port: 0,
        noBrowser: true,
        ...options.config,
      });
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-listen-harness-" })));

// A refused connect and an unreachable loopback family (no ::1 on the host)
// both mean "this address does not reach the server"; the code is kept so a
// test can tell them apart when it matters.
const refusalCodes = new Set(["ECONNREFUSED", "EADDRNOTAVAIL", "ENETUNREACH", "EHOSTUNREACH"]);

const tcpProbe = (address: string, port: number): Effect.Effect<TcpProbeOutcome> =>
  Effect.callback<TcpProbeOutcome>((resume) => {
    const socket = NodeNet.connect({ host: address, port });
    socket.once("connect", () => {
      // Close politely and wait for the socket to finish closing: a `destroy()`
      // here leaves the server reaping a half-open connection, which races the
      // scope teardown at the end of the test.
      socket.once("close", () => resume(Effect.succeed({ outcome: "accept" })));
      socket.end();
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      const code = error.code ?? "UNKNOWN";
      if (refusalCodes.has(code)) {
        resume(Effect.succeed({ outcome: "refuse", code }));
      } else {
        resume(Effect.die(error));
      }
    });
    return Effect.sync(() => socket.destroy());
  });

const readSessionPolicy = (
  address: string,
  port: number,
): Effect.Effect<ServerAuthPolicy, ListenHarnessError> =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.get(
        `http://${ListenAddress.formatHostForUrl(address)}:${port}/api/auth/session`,
      ),
    ).pipe(Effect.mapError((cause) => new ListenHarnessError({ cause })));
    if (response.status !== 200) {
      return yield* Effect.fail(
        new ListenHarnessError({ cause: `session descriptor returned ${response.status}` }),
      );
    }
    const json = yield* response.json.pipe(
      Effect.mapError((cause) => new ListenHarnessError({ cause })),
    );
    return (json as { readonly auth: { readonly policy: ServerAuthPolicy } }).auth.policy;
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer));

/** Boots the listener inside the current `Scope`; closing the scope stops it. */
export const startListenHarness = (
  options: ListenHarnessOptions = {},
): Effect.Effect<ListenHarness, never, Scope.Scope> =>
  Effect.gen(function* () {
    const layer = HttpRouter.serve(harnessRoutes, { disableLogger: true }).pipe(
      Layer.provideMerge(HttpServerLive),
      Layer.provide(harnessAuthLayer),
      Layer.provideMerge(
        listenAddressLayer(options).pipe(
          Layer.provide(harnessConfigLayer(options)),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(harnessConfigLayer(options)),
      Layer.provideMerge(NodeServices.layer),
    );
    const context = yield* Layer.build(layer).pipe(Effect.orDie);
    const server = Context.get(context, HttpServer.HttpServer);
    const listen = Context.get(context, ListenAddress.ListenAddress);
    const rebind = Context.get(context, ListenRebind.ListenRebind);
    const config = Context.get(context, ServerConfig.ServerConfig);
    const address = server.address as HttpServer.TcpAddress;
    const port = address.port;

    return {
      listen,
      port,
      probe: (target, targetPort) => tcpProbe(target, targetPort ?? port),
      readAuthPolicy: readSessionPolicy("127.0.0.1", port),
      readAuthPolicyAt: (address, targetPort) => readSessionPolicy(address, targetPort ?? port),
      rebind: rebind.rebind,
      serverRuntimeStatePath: config.serverRuntimeStatePath,
    } satisfies ListenHarness;
  });
