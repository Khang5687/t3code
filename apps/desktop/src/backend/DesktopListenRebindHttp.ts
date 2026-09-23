import { makeEnvironmentHttpApiGroupClient } from "@t3tools/client-runtime/rpc";
import type { ListenInterfaces } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { DesktopListenRebind, DesktopListenRebindFailedError } from "./DesktopListenRebind.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";

/**
 * Deliberately untimed. Every failure below means the backend kept its previous
 * listener set, and a timeout could not promise that: a slow apply that then
 * succeeds would leave the backend moved while the desktop rolled itself back.
 * The request is a loopback call to our own process, so a dead backend fails
 * the connection rather than hanging.
 *
 * The failures also explain themselves. The backend's 409 spells out the
 * address and the OS error code, and the auth and transport errors carry their
 * own message, so only a message-less one needs wording of our own.
 */
const describeFailure = (cause: { readonly message: string }): string =>
  cause.message.length > 0
    ? cause.message
    : `The backend refused to change its listen addresses (${String(cause)}).`;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const httpClient = yield* HttpClient.HttpClient;

  const rebind = Effect.fn("desktop.listenRebind.rebind")(
    function* (input: { readonly httpBaseUrl: URL; readonly listenInterfaces: ListenInterfaces }) {
      const bearerToken = yield* localAuth.getBearerToken;
      const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl.href, "listen");
      // The port stays where it is: the backend port has no user control, so
      // only the selection moves, and an absent `port` keeps the current one.
      return yield* client.interfaces({
        headers: { authorization: `Bearer ${bearerToken}` },
        payload: { listenInterfaces: input.listenInterfaces },
      });
    },
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.mapError(
      (cause) => new DesktopListenRebindFailedError({ reason: describeFailure(cause) }),
    ),
  );

  return DesktopListenRebind.of({ rebind });
});

export const layer = Layer.effect(DesktopListenRebind, make);
