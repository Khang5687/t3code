import {
  AuthAccessWriteScope,
  EnvironmentHttpApi,
  EnvironmentListenRebindFailedError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  currentEnvironmentTraceId,
  requireEnvironmentScope,
} from "./auth/http.ts";
import { ListenRebind } from "./listenRebind.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";

/**
 * Moving the listener set is an administrative change to how the machine is
 * reachable, so it takes the same scope as the rest of Connections settings.
 */
export const listenHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "listen",
  Effect.fnUntraced(function* (handlers) {
    const listen = yield* ListenRebind;
    const lifecycleEvents = yield* ServerLifecycleEvents;

    return handlers.handle(
      "interfaces",
      Effect.fn("environment.listen.interfaces")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthAccessWriteScope);
        return yield* listen.rebind(args.payload).pipe(
          // Told, not discovered: a client whose address was retired has only
          // the rebind grace before its socket goes away, and would otherwise
          // read the reconnect as a network blip. The apply starts that grace
          // last, so the event goes out well inside it.
          Effect.flatMap(({ previousPort, ...result }) =>
            lifecycleEvents
              .publish({
                version: 1,
                type: "moved",
                payload: { port: result.port, portChanged: previousPort !== result.port },
              })
              .pipe(Effect.as(result)),
          ),
          Effect.catch((refused) =>
            currentEnvironmentTraceId.pipe(
              Effect.flatMap((traceId) =>
                Effect.fail(
                  new EnvironmentListenRebindFailedError({
                    code: "listen_rebind_failed",
                    address: refused.address,
                    port: refused.port,
                    errorCode: refused.errorCode,
                    traceId,
                  }),
                ),
              ),
            ),
          ),
        );
      }),
    );
  }),
);
