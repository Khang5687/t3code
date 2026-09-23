import { useAtomValue } from "@effect/atom-react";
import { claimServerMoveAnnouncement } from "@t3tools/client-runtime/state/server";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";

const DISMISS_MS = 8_000;

/**
 * One connected environment's move, watched where it is published. Renders
 * nothing: the banner belongs to the host, so a move that lands while the phone
 * is on any screen still reaches the same place.
 */
function EnvironmentMoveWatcher(props: {
  readonly environmentId: EnvironmentId;
  readonly onMoved: (port: number) => void;
}) {
  const moved = useAtomValue(serverEnvironment.movedAtom(props.environmentId));
  const { onMoved } = props;

  useEffect(() => {
    const port = claimServerMoveAnnouncement(moved);
    if (port !== null) {
      onMoved(port);
    }
  }, [moved, onMoved]);

  return null;
}

/**
 * Tells the phone its server moved, so the reconnect that follows does not read
 * as a network blip. Mount once, at the app root.
 */
export function ServerMovedNoticeHost() {
  const { environments } = useEnvironments();
  const [movedPort, setMovedPort] = useState<number | null>(null);
  const insets = useSafeAreaInsets();
  const show = useCallback((port: number) => setMovedPort(port), []);

  useEffect(() => {
    if (movedPort === null) {
      return;
    }
    const timer = setTimeout(() => setMovedPort(null), DISMISS_MS);
    return () => clearTimeout(timer);
  }, [movedPort]);

  return (
    <>
      {environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => (
          <EnvironmentMoveWatcher
            key={environment.environmentId}
            environmentId={environment.environmentId}
            onMoved={show}
          />
        ))}
      {movedPort === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`The server moved to :${movedPort}. Tap to dismiss.`}
          className="absolute inset-x-4 rounded-2xl border border-border bg-card px-3.5 py-3"
          onPress={() => setMovedPort(null)}
          style={{ top: insets.top + 8 }}
        >
          <Text className="font-t3-medium text-sm">The server moved to :{movedPort}</Text>
        </Pressable>
      )}
    </>
  );
}
