import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";

it.effect(
  "publishes lifecycle events without subscribers and snapshots the latest welcome/ready",
  () =>
    Effect.gen(function* () {
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const environment = {
        environmentId: EnvironmentId.make("environment-test"),
        label: "Test environment",
        platform: { os: "darwin" as const, arch: "arm64" as const },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      };

      const welcome = yield* lifecycleEvents
        .publish({
          version: 1,
          type: "welcome",
          payload: {
            environment,
            cwd: "/tmp/project",
            projectName: "project",
          },
        })
        .pipe(Effect.timeoutOption("50 millis"));
      assertTrue(Option.isSome(welcome));
      assert.equal(welcome.value.sequence, 1);

      const ready = yield* lifecycleEvents
        .publish({
          version: 1,
          type: "ready",
          payload: {
            at: "2026-01-01T00:00:00.000Z",
            environment,
          },
        })
        .pipe(Effect.timeoutOption("50 millis"));
      assertTrue(Option.isSome(ready));
      assert.equal(ready.value.sequence, 2);

      const snapshot = yield* lifecycleEvents.snapshot;
      assert.equal(snapshot.sequence, 2);
      assert.deepEqual(snapshot.events.map((event) => event.type).toSorted(), ["ready", "welcome"]);
    }).pipe(Effect.provide(ServerLifecycleEvents.layer)),
);

it.effect("never replays a move to a later subscriber", () =>
  Effect.gen(function* () {
    const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;

    const moved = yield* lifecycleEvents.publish({
      version: 1,
      type: "moved",
      payload: { port: 4180, portChanged: true },
    });

    const snapshot = yield* lifecycleEvents.snapshot;
    // A snapshot is replayed to every new subscriber, so a retained move would
    // fire the "server moved" toast on every reconnect from then on.
    assert.deepEqual(
      snapshot.events.map((event) => event.type),
      [],
    );
    // The sequence still advances, so the live filter a subscriber applies
    // (`sequence > snapshot.sequence`) cannot swallow the next real event.
    assert.equal(moved.sequence, 1);
    assert.equal(snapshot.sequence, 1);
  }).pipe(Effect.provide(ServerLifecycleEvents.layer)),
);
