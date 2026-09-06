// Fork-only (Khang5687/t3code #3). Seam 1 characterization: what the real
// listener binds and what auth policy it advertises, per `--host`.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { startListenHarness } from "./testUtils/listenHarness.ts";

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
});
