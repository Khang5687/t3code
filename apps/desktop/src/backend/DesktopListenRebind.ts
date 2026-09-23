import type { ListenInterfaces, ListenRebindResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Tag only, deliberately. The implementation reaches the running backend, and
// the backend's own layers are built on top of `DesktopServerExposure`, so the
// adapter lives in `DesktopListenRebindHttp.ts` and this module stays a leaf.

/**
 * The backend kept its previous listener set, so whatever asked for the move
 * has to leave its own state alone too. `reason` is what the panel shows, so it
 * carries the backend's own wording (which address, which OS error code).
 */
export class DesktopListenRebindFailedError extends Schema.TaggedError<DesktopListenRebindFailedError>()(
  "DesktopListenRebindFailedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class DesktopListenRebind extends Context.Service<
  DesktopListenRebind,
  {
    /** Moves the running backend's listener set, or fails leaving it as it was. */
    readonly rebind: (input: {
      readonly httpBaseUrl: URL;
      readonly listenInterfaces: ListenInterfaces;
    }) => Effect.Effect<ListenRebindResult, DesktopListenRebindFailedError>;
  }
>()("@t3tools/desktop/backend/DesktopListenRebind") {}
