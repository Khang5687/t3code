import {
  CheckpointRef,
  EnvironmentId,
  MessageId,
  type OrchestrationCheckpointSummary,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { forkedFromLabel, resolveForkSource, resolveForkTarget } from "./threadFork.ts";

const now = "2026-03-29T00:00:00.000Z";

describe("resolveForkTarget", () => {
  const userMessage = (id: string, turnId: string) => ({
    id: MessageId.make(id),
    role: "user" as const,
    turnId: TurnId.make(turnId),
  });
  const assistantMessage = (id: string, turnId: string) => ({
    ...userMessage(id, turnId),
    role: "assistant" as const,
  });
  const checkpoint = (
    turnId: string,
    checkpointTurnCount: number,
    status: OrchestrationCheckpointSummary["status"] = "ready",
  ): OrchestrationCheckpointSummary => ({
    turnId: TurnId.make(turnId),
    checkpointTurnCount,
    checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/${checkpointTurnCount}`),
    status,
    files: [],
    assistantMessageId: null,
    completedAt: now,
  });

  // Two finished turns, so the second user message has a captured checkpoint
  // behind it and the first has only the pre-turn baseline.
  const messages = [
    userMessage("user-1", "turn-1"),
    assistantMessage("assistant-1", "turn-1"),
    userMessage("user-2", "turn-2"),
    assistantMessage("assistant-2", "turn-2"),
  ];
  const checkpoints = [checkpoint("turn-1", 1), checkpoint("turn-2", 2)];

  it("refuses a message that is not a user message of the thread", () => {
    expect(
      resolveForkTarget({
        messages,
        checkpoints,
        messageId: MessageId.make("assistant-1"),
        isGitProject: true,
      }),
    ).toBeNull();
    expect(
      resolveForkTarget({
        messages,
        checkpoints,
        messageId: MessageId.make("not-here"),
        isGitProject: true,
      }),
    ).toBeNull();
  });

  it("offers a worktree from the checkpoint captured before the boundary", () => {
    expect(
      resolveForkTarget({
        messages,
        checkpoints,
        messageId: MessageId.make("user-2"),
        isGitProject: true,
      }),
    ).toEqual({ messageId: MessageId.make("user-2"), canForkIntoNewWorktree: true });
  });

  it("offers a worktree at the first message from the pre-turn baseline", () => {
    expect(
      resolveForkTarget({
        messages,
        checkpoints,
        messageId: MessageId.make("user-1"),
        isGitProject: true,
      })?.canForkIntoNewWorktree,
    ).toBe(true);
  });

  it("withholds the worktree option when the boundary's capture is not ready", () => {
    expect(
      resolveForkTarget({
        messages,
        checkpoints: [checkpoint("turn-1", 1, "error")],
        messageId: MessageId.make("user-2"),
        isGitProject: true,
      }),
    ).toEqual({ messageId: MessageId.make("user-2"), canForkIntoNewWorktree: false });
  });

  it("withholds the worktree option outside a git project but still allows the fork", () => {
    expect(
      resolveForkTarget({
        messages,
        checkpoints,
        messageId: MessageId.make("user-2"),
        isGitProject: false,
      }),
    ).toEqual({ messageId: MessageId.make("user-2"), canForkIntoNewWorktree: false });
  });
});

describe("resolveForkSource", () => {
  const sourceRef = {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-source"),
  };
  const origin = { threadId: ThreadId.make("thread-source"), turnCount: 1, title: "Recorded" };

  it("shows the live title and links while the source exists", () => {
    expect(resolveForkSource(sourceRef, origin, { title: "Renamed" }, true)).toEqual({
      title: "Renamed",
      sourceRef,
    });
  });

  it("falls back to the recorded title without a link once the source is gone", () => {
    expect(resolveForkSource(sourceRef, origin, null, true)).toEqual({
      title: "Recorded",
      sourceRef: null,
    });
  });

  it("leaves an untitled origin nameless once the source is gone", () => {
    const { title: _title, ...untitled } = origin;
    expect(resolveForkSource(sourceRef, untitled, null, true)).toEqual({
      title: null,
      sourceRef: null,
    });
  });

  it("waits for the shell bootstrap before calling a source gone", () => {
    expect(resolveForkSource(sourceRef, origin, null, false)).toBeNull();
  });
});

describe("forkedFromLabel", () => {
  it("names the source, or says it is gone when no title survives", () => {
    expect(forkedFromLabel({ title: "Recorded" })).toBe("Forked from Recorded");
    expect(forkedFromLabel({ title: null })).toBe("Forked from a deleted thread");
  });
});
