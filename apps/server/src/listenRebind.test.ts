// @effect-diagnostics nodeBuiltinImport:off
// Fork-only (ADR 0003, Amendment 1). The listener set moves in place: new
// addresses bind first, surviving addresses are never touched, and a refused
// bind leaves the previous set serving.
import { describe, expect, it } from "@effect/vitest";
import { normalizeListenInterfaces } from "@t3tools/contracts";
import { isTailscaleIpv4Address } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import type { NetworkInterfacesMap } from "./listenAddress.ts";
import { startListenHarness } from "./testUtils/listenHarness.ts";

const ipv4 = (address: string, internal: boolean) => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4" as const,
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});

// A rebind resolves against the machine's real interface table, so the
// multi-address cases use an address the runner actually owns and skip when it
// has none. The startup table is injected to match, so the two agree.
const runnerLan = Object.values(NodeOS.networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .filter((entry) => entry.family === "IPv4" && !entry.internal)
  .map((entry) => entry.address)
  .find((address) => !isTailscaleIpv4Address(address));

const withRunnerLan: NetworkInterfacesMap = {
  lo0: [ipv4("127.0.0.1", true)],
  en0: [ipv4(runnerLan ?? "127.0.0.1", false)],
};

const loopbackOnly = normalizeListenInterfaces({ kinds: ["loopback"] });
const loopbackAndRunnerLan = normalizeListenInterfaces({
  kinds: ["loopback"],
  addresses: [runnerLan ?? "127.0.0.1"],
});

/** A port nobody holds right now, for the "move to a different port" cases. */
const reservePort = Effect.callback<number>((resume) => {
  const server = NodeNet.createServer();
  server.once("error", (error) => resume(Effect.die(error)));
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const { port } = server.address() as NodeNet.AddressInfo;
    server.close(() => resume(Effect.succeed(port)));
  });
  return Effect.sync(() => {
    server.close();
  });
});

/** A port held by something that is not us, released when the scope closes. */
const occupiedPort = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.once("error", (error) => resume(Effect.die(error)));
    server.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.succeed(server)));
    return Effect.sync(() => {
      server.close();
    });
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

/** Whether this process can take `address:port`, which proves it was released. */
const canBind = (address: string, port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const server = NodeNet.createServer();
    server.once("error", () => resume(Effect.succeed(false)));
    server.listen({ host: address, port }, () => {
      server.close(() => resume(Effect.succeed(true)));
    });
    return Effect.sync(() => {
      server.close();
    });
  });

/** A connected socket that outlives the rebind, so a survivor can be proven. */
const connectedSocket = (host: string, port: number) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Socket>((resume) => {
      const socket = NodeNet.connect({ host, port });
      socket.once("error", (error) => resume(Effect.die(error)));
      socket.once("connect", () => resume(Effect.succeed(socket)));
      return Effect.void;
    }),
    (socket) =>
      Effect.sync(() => {
        socket.destroy();
      }),
  );

/**
 * Resolves when the peer closes the socket. Node finishes `close()` over a
 * turn or two, so reading `socket.destroyed` straight after a rebind races it;
 * waiting on the event the close actually emits does not.
 */
const awaitClose = (socket: NodeNet.Socket): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (socket.destroyed) {
      resume(Effect.void);
      return;
    }
    socket.once("close", () => resume(Effect.void));
  });

const getSession = "GET /api/auth/session HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";

/** Everything the server sends back on an already-open socket, until it closes. */
const exchangeOn = (socket: NodeNet.Socket, request: string): Effect.Effect<string> =>
  Effect.callback<string>((resume) => {
    const chunks: Array<Buffer> = [];
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(Buffer.concat(chunks).toString("utf8")));
    };
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", settle);
    socket.once("close", settle);
    socket.write(request);
    return Effect.void;
  });

const readRuntimeState = (path: string) =>
  Effect.promise(() => NodeFSP.readFile(path, "utf8")).pipe(
    Effect.map((raw) => JSON.parse(raw) as { port: number; addresses?: ReadonlyArray<string> }),
  );

// `it.live`, not `it.effect`: real listeners, real sqlite migrations, and the
// rebind's own socket grace all need the real clock.
describe("live rebind (case A: the set moves)", () => {
  it.live("moves to a new port: the old one stops accepting, the new one serves", () =>
    Effect.gen(function* () {
      const harness = yield* startListenHarness({ host: "loopback" });
      const target = yield* reservePort;

      const result = yield* harness.rebind({
        listenInterfaces: loopbackOnly,
        port: target,
      });

      expect(result.port).toBe(target);
      expect(result.addresses).toEqual(["127.0.0.1"]);
      expect(result.tailscaleServeRepointed).toBe(false);
      // What the "server moved" announcement is built from: a different port
      // means every listener was retired, so every client is being dropped.
      expect(result.previousPort).toBe(harness.port);

      expect((yield* harness.probe("127.0.0.1", harness.port)).outcome).toBe("refuse");
      expect(yield* harness.probe("127.0.0.1", target)).toEqual({ outcome: "accept" });
      expect(yield* harness.readAuthPolicyAt("127.0.0.1", target)).toBe("loopback-browser");

      // Stale runtime state is how a local CLI dials a port nobody is on.
      const state = yield* readRuntimeState(harness.serverRuntimeStatePath);
      expect(state.port).toBe(target);
      expect(state.addresses).toEqual(["127.0.0.1"]);
    }).pipe(Effect.scoped),
  );

  it.live("leaves an address that is in both sets bound, serving, and uninterrupted", () =>
    Effect.gen(function* () {
      if (runnerLan === undefined) return;
      const harness = yield* startListenHarness({
        host: "loopback",
        interfaces: withRunnerLan,
      });
      // Opened before the move and used after it: a socket on a surviving
      // address must never notice that anything happened.
      const survivor = yield* connectedSocket("127.0.0.1", harness.port);

      const result = yield* harness.rebind({ listenInterfaces: loopbackAndRunnerLan });

      expect(result.port).toBe(harness.port);
      expect(result.addresses).toEqual(["127.0.0.1", runnerLan]);
      // Interface-only: the port did not move, so a connected client is not
      // told anything and its socket keeps working.
      expect(result.previousPort).toBe(harness.port);
      expect(yield* exchangeOn(survivor, getSession)).toContain("HTTP/1.1 200");

      // The address that joined serves the same routes the original one does.
      // The advertised auth policy is the one the server launched with, on
      // purpose: reissuing credentials on a rebind is out of scope, so
      // `ListenAddress` keeps its startup resolution.
      expect(yield* harness.readAuthPolicyAt(runnerLan)).toBe("loopback-browser");
      expect(yield* harness.readAuthPolicyAt("127.0.0.1")).toBe("loopback-browser");
    }).pipe(Effect.scoped),
  );

  it.live("releases an address that left the set while the rest keep serving", () =>
    Effect.gen(function* () {
      if (runnerLan === undefined) return;
      const harness = yield* startListenHarness({
        host: `loopback,${runnerLan}`,
        interfaces: withRunnerLan,
      });
      expect(harness.listen.bindHosts).toEqual(["127.0.0.1", runnerLan]);
      const doomed = yield* connectedSocket(runnerLan, harness.port);

      yield* harness.rebind({ listenInterfaces: loopbackOnly });

      // An idle keep-alive socket goes with the listener: Node's `close()`
      // drops the connections that are not mid-request, which is what proves
      // the retired listener really shut down rather than lingering. The ones
      // still carrying a request are what the grace is for.
      yield* awaitClose(doomed);

      // A connect to a closed port on a LAN address is dropped rather than
      // refused, so taking the address for ourselves is the probe that
      // terminates.
      expect(yield* canBind(runnerLan, harness.port)).toBe(true);
      expect(yield* harness.readAuthPolicyAt("127.0.0.1")).toBe("remote-reachable");
    }).pipe(Effect.scoped),
  );
});

describe("live rebind (case B: a refused bind changes nothing)", () => {
  it.live("fails with the address and OS code, and the previous set still serves", () =>
    Effect.gen(function* () {
      const harness = yield* startListenHarness({ host: "loopback" });
      const taken = yield* occupiedPort;

      const error = yield* Effect.flip(
        harness.rebind({ listenInterfaces: loopbackOnly, port: taken }),
      );

      expect(error.address).toBe("127.0.0.1");
      expect(error.port).toBe(taken);
      expect(error.errorCode).toBe("EADDRINUSE");

      expect(yield* harness.probe("127.0.0.1")).toEqual({ outcome: "accept" });
      expect(yield* harness.readAuthPolicy).toBe("loopback-browser");
    }).pipe(Effect.scoped),
  );
});
