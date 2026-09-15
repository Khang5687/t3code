// Fork-only (Khang5687/t3code #3). Seam 1 characterization: what the real
// listener binds and what auth policy it advertises, per `--host`.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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

// A machine on a LAN with Tailscale down: no CGNAT address anywhere.
const tailscaleDownInterfaces: NetworkInterfacesMap = {
  lo0: [ipv4("127.0.0.1", true)],
  en0: [ipv4("192.168.1.42", false)],
};

// `it.live`, not `it.effect`: the harness boots a real listener and sqlite
// migrations; under `it.effect`'s TestClock the boot self-interrupts.
describe("listen harness (Seam 1)", () => {
  it.live(
    "default config binds loopback: 127.0.0.1 accepts, [::1] refused, policy loopback-browser",
    () =>
      Effect.gen(function* () {
        const harness = yield* startListenHarness();

        expect(harness.listen.kind).toBe("loopback");
        expect(harness.listen.bindHost).toBe("127.0.0.1");
        expect(harness.port).toBeGreaterThan(0);

        expect(yield* harness.probe("127.0.0.1")).toEqual({ outcome: "accept" });
        expect((yield* harness.probe("::1")).outcome).toBe("refuse");
        expect(yield* harness.readAuthPolicy).toBe("loopback-browser");
      }).pipe(Effect.scoped),
  );

  it.live("explicit --host 0.0.0.0 binds wildcard and advertises remote-reachable", () =>
    Effect.gen(function* () {
      const harness = yield* startListenHarness({ host: "0.0.0.0" });

      expect(harness.listen.kind).toBe("wildcard");
      expect(harness.listen.bindHost).toBe("0.0.0.0");
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
      expect(harness.listen.bindHost).toBe("127.0.0.1");
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
      expect(harness.listen.bindHost).toBe("127.0.0.1");
      expect(harness.listen.remoteReachable).toBe(false);
      expect(harness.listen.configuredHost).toBe("tailnet");

      // Only loopback is bound. The injected LAN address is not probed: it is
      // absent from this machine, so a connect to it hangs to ETIMEDOUT rather
      // than refusing, and `bindHost` already pins what the kernel opened.
      expect(yield* harness.probe("127.0.0.1")).toEqual({ outcome: "accept" });

      expect(harness.listen.warnings.some((warning) => /tailscale address/i.test(warning))).toBe(
        true,
      );
      expect(harness.listen.warnings.some((warning) => /loopback only/i.test(warning))).toBe(true);
      expect(yield* harness.readAuthPolicy).toBe("loopback-browser");
    }).pipe(Effect.scoped),
  );
});
