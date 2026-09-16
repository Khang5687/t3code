// Fork-only (Khang5687/t3code #3, #6). Seam 1 characterization: what the real
// listener binds and what auth policy it advertises, per `--host`.
import { describe, expect, it } from "@effect/vitest";
import { isTailscaleIpv4Address } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";

import type { NetworkInterfacesMap } from "./listenAddress.ts";
import * as NodeNet from "node:net";

import { startListenHarness } from "./testUtils/listenHarness.ts";

/**
 * Whether this process can take `address:port` for itself. After the harness
 * scope closes every listener must be released, and binding is a deterministic
 * way to prove that: a connect to a closed port on a LAN address is silently
 * dropped rather than refused, so it would only ever hang.
 */
const canBind = (address: string, port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const server = NodeNet.createServer();
    server.once("error", () => resume(Effect.succeed(false)));
    server.listen({ host: address, port }, () => {
      server.close(() => resume(Effect.succeed(true)));
    });
    return Effect.sync(() => server.close());
  });

const ipv4 = (address: string, internal: boolean) => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4" as const,
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});

// A machine on a LAN with Tailscale down: no CGNAT address anywhere.
const tailscaleDownInterfaces: NetworkInterfacesMap = {
  lo0: [ipv4("127.0.0.1", true)],
  en0: [ipv4("192.168.1.42", false)],
};

// Binding a non-loopback address only works if the runner really owns it, so
// the multi-bind cases inject the runner's own addresses rather than fake ones
// and skip when it has none.
const runnerExternalIpv4 = Object.values(NodeOS.networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .filter((entry) => entry.family === "IPv4" && !entry.internal)
  .map((entry) => entry.address);

const runnerLan = runnerExternalIpv4.find((address) => !isTailscaleIpv4Address(address));
const runnerTailnet = runnerExternalIpv4.find(isTailscaleIpv4Address);

const withRunnerAddress = (address: string): NetworkInterfacesMap => ({
  lo0: [ipv4("127.0.0.1", true)],
  en0: [ipv4(address, false)],
});

// `it.live`, not `it.effect`: the harness boots a real listener and sqlite
// migrations; under `it.effect`'s TestClock the boot self-interrupts.
describe("listen harness (Seam 1)", () => {
  it.live(
    "default config binds loopback: 127.0.0.1 accepts, [::1] refused, policy loopback-browser",
    () =>
      Effect.gen(function* () {
        const harness = yield* startListenHarness();

        expect(harness.listen.kind).toBe("loopback");
        expect(harness.listen.bindHosts).toEqual(["127.0.0.1"]);
        expect(harness.port).toBeGreaterThan(0);

        expect(yield* harness.probe("127.0.0.1")).toEqual({ outcome: "accept" });
        expect((yield* harness.probe("::1")).outcome).toBe("refuse");
        expect(yield* harness.readAuthPolicy).toBe("loopback-browser");
      }).pipe(Effect.scoped),
  );

  it.live("explicit --host 0.0.0.0 binds a single wildcard listener", () =>
    Effect.gen(function* () {
      const harness = yield* startListenHarness({ host: "0.0.0.0" });

      expect(harness.listen.kind).toBe("wildcard");
      expect(harness.listen.bindHosts).toEqual(["0.0.0.0"]);
      expect(harness.listen.remoteReachable).toBe(true);

      expect(yield* harness.probe("127.0.0.1")).toEqual({ outcome: "accept" });
      expect(yield* harness.readAuthPolicy).toBe("remote-reachable");
    }).pipe(Effect.scoped),
  );

  it.live("--host loopback binds 127.0.0.1 only and stays loopback-browser", () =>
    Effect.gen(function* () {
      const harness = yield* startListenHarness({
        host: "loopback",
        interfaces: tailscaleDownInterfaces,
      });

      expect(harness.listen.kind).toBe("loopback");
      expect(harness.listen.bindHosts).toEqual(["127.0.0.1"]);
      expect(harness.listen.remoteReachable).toBe(false);
      expect(harness.listen.warnings).toEqual([]);

      expect(yield* harness.probe("127.0.0.1")).toEqual({ outcome: "accept" });
      expect((yield* harness.probe("::1")).outcome).toBe("refuse");
      expect(yield* harness.readAuthPolicy).toBe("loopback-browser");
    }).pipe(Effect.scoped),
  );

  it.live("--host tailnet with Tailscale down binds loopback only and warns", () =>
    Effect.gen(function* () {
      const harness = yield* startListenHarness({
        host: "tailnet",
        interfaces: tailscaleDownInterfaces,
      });

      expect(harness.listen.kind).toBe("loopback");
      expect(harness.listen.bindHosts).toEqual(["127.0.0.1"]);
      expect(harness.listen.remoteReachable).toBe(false);
      expect(harness.listen.configuredHost).toBe("tailnet");

      expect(yield* harness.probe("127.0.0.1")).toEqual({ outcome: "accept" });

      expect(harness.listen.warnings.some((warning) => /tailscale address/i.test(warning))).toBe(
        true,
      );
      expect(harness.listen.warnings.some((warning) => /loopback only/i.test(warning))).toBe(true);
      expect(yield* harness.readAuthPolicy).toBe("loopback-browser");
    }).pipe(Effect.scoped),
  );

  it.live("an explicit address on no interface is skipped by name and the rest still bind", () =>
    Effect.gen(function* () {
      const harness = yield* startListenHarness({
        host: "loopback,203.0.113.7",
        interfaces: tailscaleDownInterfaces,
      });

      expect(harness.listen.bindHosts).toEqual(["127.0.0.1"]);
      expect(harness.listen.warnings.some((warning) => warning.includes("203.0.113.7"))).toBe(true);
      expect(yield* harness.probe("127.0.0.1")).toEqual({ outcome: "accept" });
      // An address that resolved to nothing must not widen the policy.
      expect(yield* harness.readAuthPolicy).toBe("loopback-browser");
    }).pipe(Effect.scoped),
  );
});

describe.skipIf(runnerLan === undefined)(
  "listen harness multi-bind over the runner's LAN address (skipped: no non-internal IPv4 here)",
  () => {
    it.live("--host lan binds loopback and the LAN address, both serving HTTP", () =>
      Effect.gen(function* () {
        const harness = yield* startListenHarness({
          host: "lan",
          interfaces: withRunnerAddress(runnerLan!),
        });

        expect(harness.listen.bindHosts).toEqual(["127.0.0.1", runnerLan]);
        expect(harness.listen.remoteReachable).toBe(true);

        expect(yield* harness.probe("127.0.0.1")).toEqual({ outcome: "accept" });
        expect(yield* harness.probe(runnerLan!)).toEqual({ outcome: "accept" });
        // Reading the real route over each address is what separates a true
        // per-address bind from one listener that merely accepts on both.
        expect(yield* harness.readAuthPolicyAt("127.0.0.1")).toBe("remote-reachable");
        expect(yield* harness.readAuthPolicyAt(runnerLan!)).toBe("remote-reachable");
      }).pipe(Effect.scoped),
    );

    it.live("skips an explicit address on no interface while the rest still serve", () =>
      Effect.gen(function* () {
        const harness = yield* startListenHarness({
          host: "lan,203.0.113.7",
          interfaces: withRunnerAddress(runnerLan!),
        });

        expect(harness.listen.bindHosts).toEqual(["127.0.0.1", runnerLan]);
        expect(harness.listen.warnings.some((warning) => warning.includes("203.0.113.7"))).toBe(
          true,
        );
        expect(yield* harness.readAuthPolicyAt(runnerLan!)).toBe("remote-reachable");
      }).pipe(Effect.scoped),
    );

    it.live("closes every listener when the scope closes", () =>
      Effect.gen(function* () {
        const port = yield* Effect.gen(function* () {
          const harness = yield* startListenHarness({
            host: "lan",
            interfaces: withRunnerAddress(runnerLan!),
          });
          expect(yield* harness.probe("127.0.0.1")).toEqual({ outcome: "accept" });
          expect(yield* harness.probe(runnerLan!)).toEqual({ outcome: "accept" });
          return harness.port;
        }).pipe(Effect.scoped);

        // Shutdown has to take every listener down, not just the primary.
        expect(yield* canBind("127.0.0.1", port)).toBe(true);
        expect(yield* canBind(runnerLan!, port)).toBe(true);
      }),
    );
  },
);

describe.skipIf(runnerTailnet === undefined)(
  "listen harness multi-bind over the runner's tailnet address (skipped: no Tailscale address here)",
  () => {
    it.live("--host tailnet binds loopback and the tailnet address, both accepting", () =>
      Effect.gen(function* () {
        const harness = yield* startListenHarness({
          host: "tailnet",
          interfaces: withRunnerAddress(runnerTailnet!),
        });

        expect(harness.listen.bindHosts).toEqual(["127.0.0.1", runnerTailnet]);
        expect(harness.listen.remoteReachable).toBe(true);

        expect(yield* harness.probe("127.0.0.1")).toEqual({ outcome: "accept" });
        expect(yield* harness.probe(runnerTailnet!)).toEqual({ outcome: "accept" });
        // The pinned comment on #6 requires loopback to serve alongside the
        // tailnet address, not merely to be listed.
        expect(yield* harness.readAuthPolicyAt("127.0.0.1")).toBe("remote-reachable");
        expect(yield* harness.readAuthPolicyAt(runnerTailnet!)).toBe("remote-reachable");
      }).pipe(Effect.scoped),
    );
  },
);
