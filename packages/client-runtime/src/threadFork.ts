import {
  canForkIntoNewWorktree,
  hasThreadCheckpointForTurn,
  resolveForkBoundary,
  resolveForkCheckpointTurn,
  type MessageId,
  type OrchestrationCheckpointSummary,
  type OrchestrationMessage,
  type ScopedThreadRef,
  type ThreadForkOrigin,
} from "@t3tools/contracts";

/**
 * What a "Fork from here" press may offer for one message, in one derivation:
 * `null` when the message cannot be forked at all, and otherwise whether the
 * second location is on offer. `canForkIntoNewWorktree` runs the shared
 * contract gate the server runs before it prepares a checkout, so the option is
 * never rendered for a fork the server would refuse.
 */
export function resolveForkTarget(input: {
  readonly messages: ReadonlyArray<Pick<OrchestrationMessage, "id" | "role" | "turnId">>;
  readonly checkpoints: ReadonlyArray<
    Pick<OrchestrationCheckpointSummary, "turnId" | "checkpointTurnCount" | "status">
  >;
  readonly messageId: MessageId;
  readonly isGitProject: boolean;
}): { messageId: MessageId; canForkIntoNewWorktree: boolean } | null {
  const boundary = resolveForkBoundary(input.messages, input.messageId);
  if (!boundary) return null;
  const checkpointTurn = resolveForkCheckpointTurn(
    input.messages,
    input.checkpoints,
    boundary.index,
  );
  return {
    messageId: input.messageId,
    canForkIntoNewWorktree: canForkIntoNewWorktree(
      input.isGitProject,
      hasThreadCheckpointForTurn(input.checkpoints, checkpointTurn),
    ),
  };
}

/**
 * A fork's "Forked from" source. A live source shows its current title and
 * a link. A shell is missing both while shells are still loading and once the
 * source is deleted; only the second shows, so the line waits for the
 * bootstrap rather than flashing a deleted state. A deleted source falls back
 * to the title recorded at fork time, and `title: null` (older forks) reads as
 * "a deleted thread".
 */
export function resolveForkSource(
  sourceRef: ScopedThreadRef,
  origin: ThreadForkOrigin,
  sourceShell: { readonly title: string } | null,
  shellsBootstrapped: boolean,
): { title: string | null; sourceRef: ScopedThreadRef | null } | null {
  if (sourceShell !== null) return { title: sourceShell.title, sourceRef };
  if (!shellsBootstrapped) return null;
  return { title: origin.title ?? null, sourceRef: null };
}

/** The "Forked from" line's text for a `resolveForkSource` result. */
export function forkedFromLabel(source: { readonly title: string | null }): string {
  return `Forked from ${source.title ?? "a deleted thread"}`;
}
