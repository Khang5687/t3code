import { describe, expect, it } from "vite-plus/test";

import { formatTimelineDebugRef } from "./timelineDebugRef.ts";

describe("formatTimelineDebugRef", () => {
  it("joins the full triple in thread/turn/message order", () => {
    expect(formatTimelineDebugRef({ threadId: "thr_1", turnId: "trn_2", messageId: "msg_3" })).toBe(
      "thread=thr_1;turn=trn_2;message=msg_3",
    );
  });

  it("drops the turn segment when the row has no turn", () => {
    expect(formatTimelineDebugRef({ threadId: "thr_1", messageId: "msg_3" })).toBe(
      "thread=thr_1;message=msg_3",
    );
    expect(formatTimelineDebugRef({ threadId: "thr_1", turnId: null, messageId: "msg_3" })).toBe(
      "thread=thr_1;message=msg_3",
    );
  });

  it("uses semicolons with no spaces and no trailing separator", () => {
    const ref = formatTimelineDebugRef({ threadId: "a", turnId: "b", messageId: "c" });
    expect(ref).not.toMatch(/\s/);
    expect(ref.endsWith(";")).toBe(false);
    expect(ref.split(";")).toEqual(["thread=a", "turn=b", "message=c"]);
  });
});
