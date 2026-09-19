import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { claudeManagedSettingsPaths, hasClaudeManagedSettings } from "./claudeManagedSettings.ts";

describe("claudeManagedSettingsPaths", () => {
  it.each([
    {
      platform: "darwin" as const,
      expected: [
        "/Library/Application Support/ClaudeCode/managed-settings.json",
        "/Library/Application Support/ClaudeCode/managed-settings.d",
      ],
    },
    {
      platform: "linux" as const,
      expected: ["/etc/claude-code/managed-settings.json", "/etc/claude-code/managed-settings.d"],
    },
    {
      platform: "win32" as const,
      expected: [
        "C:\\Program Files\\ClaudeCode\\managed-settings.json",
        "C:\\Program Files\\ClaudeCode\\managed-settings.d",
      ],
    },
  ])("reads $platform where Claude Code reads it", ({ platform, expected }) => {
    expect(claudeManagedSettingsPaths(platform, {})).toEqual(expected);
  });

  it("follows the override Claude Code follows", () => {
    expect(
      claudeManagedSettingsPaths("linux", { CLAUDE_CODE_MANAGED_SETTINGS_PATH: "/opt/policy" }),
    ).toEqual(["/opt/policy/managed-settings.json", "/opt/policy/managed-settings.d"]);
  });
});

describe("hasClaudeManagedSettings", () => {
  const onLinuxWith = (present: ReadonlyArray<string>) =>
    hasClaudeManagedSettings((path) => Effect.succeed(present.includes(path))).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, {}),
    );

  it.effect("finds the single managed settings file", () =>
    Effect.gen(function* () {
      expect(yield* onLinuxWith(["/etc/claude-code/managed-settings.json"])).toBe(true);
    }),
  );

  it.effect("finds the drop-in directory on its own", () =>
    Effect.gen(function* () {
      expect(yield* onLinuxWith(["/etc/claude-code/managed-settings.d"])).toBe(true);
    }),
  );

  it.effect("reports an unmanaged machine, where T3 Code's own policy does apply", () =>
    Effect.gen(function* () {
      expect(yield* onLinuxWith([])).toBe(false);
    }),
  );
});
