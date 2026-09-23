import { describe, expect, it } from "vite-plus/test";

import { detectComposerTrigger, serializeComposerFileLink } from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %s skill prefixes and their source range",
    (prefix) => {
      const text = `Use ${prefix}review`;
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "skill",
        query: "review",
        rangeStart: 4,
        rangeEnd: text.length,
      });
    },
  );

  it.each([
    { text: "foo /", query: "", rangeStart: "foo ".length },
    { text: "foo /rev", query: "rev", rangeStart: "foo ".length },
    { text: "(see /x", query: "x", rangeStart: "(see ".length },
    { text: "a\n/rev after /re", query: "re", rangeStart: "a\n/rev after ".length },
  ])("opens the skill menu for a mid-prompt slash in $text", ({ text, query, rangeStart }) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "skill",
      query,
      rangeStart,
      rangeEnd: text.length,
    });
  });

  it("keeps a slash at the start of a continuation line a slash command", () => {
    const text = "a\n/rev";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: "a\n".length,
      rangeEnd: text.length,
    });
  });

  it("keeps line-start /model opening the model picker", () => {
    const text = "/model sonnet";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-model",
      query: "sonnet",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it.each(["src/foo", "https://x", "a/b"])("ignores a slash inside %s", (text) => {
    expect(detectComposerTrigger(text, text.length)).toBeNull();
  });

  it("keeps an embedded slash from changing an existing trigger", () => {
    const text = "issue#1/2";

    expect(detectComposerTrigger(text, text.length)).toBeNull();
  });

  it("makes mid-prompt / an alias of the $ skill trigger", () => {
    expect(detectComposerTrigger("Use /rev", "Use /rev".length)).toEqual(
      detectComposerTrigger("Use $rev", "Use $rev".length),
    );
  });

  it("honours the isWhitespaceChar override for slash token boundaries", () => {
    const text = "ctx\u0000/rev";

    expect(detectComposerTrigger(text, text.length, (char) => char === "\u0000")).toEqual({
      kind: "skill",
      query: "rev",
      rangeStart: "ctx\u0000".length,
      rangeEnd: text.length,
    });
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});
