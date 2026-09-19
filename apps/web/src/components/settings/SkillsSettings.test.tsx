import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderSkillKey, ServerProvider } from "@t3tools/contracts";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({
  useUpdateEnvironmentSettings: () => vi.fn(),
  usePrimarySettingsAvailable: () => true,
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE: "Connect to an environment",
}));
vi.mock("./useScopedSettings", () => ({
  useUpdateScopedSettings: () => vi.fn(),
  useClearProjectOverrides: () => vi.fn(),
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment", environmentIds: [] },
    target: null,
    targets: [],
  }),
  useOptionalSettingsScope: () => null,
}));

import { SkillsSettings } from "./SkillsSettings";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");

function claudeProvider(skills: ServerProvider["skills"]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude-1"),
    driver: ProviderDriverKind.make("claude"),
    displayName: "Claude Code",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills,
  } as unknown as ServerProvider;
}

function renderSkills(disabledSkills: ReadonlyArray<ProviderSkillKey>, skills: unknown) {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      <StrictMode>
        <SkillsSettings
          environmentId={ENVIRONMENT_ID}
          providers={[claudeProvider(skills as ServerProvider["skills"])]}
          disabledSkills={disabledSkills}
          readOnly={false}
        />
      </StrictMode>,
    );
  });
  const text = JSON.stringify(renderer?.toJSON() ?? null);
  act(() => renderer?.unmount());
  return text;
}

const review = {
  name: "review",
  path: "/home/dev/.claude/skills/review/SKILL.md",
  scope: "user",
  enabled: true,
};

describe("SkillsSettings", () => {
  it("says the provider can still invoke a skill T3 Code hides", () => {
    const text = renderSkills(
      [{ source: "personal", name: "review" } as ProviderSkillKey],
      [review],
    );

    expect(text).toContain("Hidden in T3 Code only.");
    expect(text).toContain("Claude Code");
    expect(text).toContain("/home/dev/.claude/skills/review");
  });

  it("leaves the note off while the skill is on", () => {
    expect(renderSkills([], [review])).not.toContain("Hidden in T3 Code only.");
  });

  it("leaves the note off for a skill the provider reserves for manual invocation", () => {
    const text = renderSkills(
      [{ source: "personal", name: "review" } as ProviderSkillKey],
      [{ ...review, userInvocationOnly: true }],
    );

    expect(text).not.toContain("Hidden in T3 Code only.");
  });

  it("names the other folder one switch covers", () => {
    const text = renderSkills(
      [],
      [review, { ...review, path: "/home/dev/.cursor/skills/review/SKILL.md" }],
    );

    expect(text).toContain("One switch, also in ");
    expect(text).toContain("/home/dev/.cursor/skills/review");
  });
});
