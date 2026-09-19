import type {
  ProviderSkillSourceKind,
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";

// The classifier and the disabled-skill fold live in `@t3tools/shared` so the
// server shares one implementation; re-exported for the clients already here.
export { resolveProviderSkillSourceKind } from "@t3tools/shared/providerSkills";
export type { ProviderSkillSourceKind };

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

export function dedupeProviderSkillsByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const seenNames = new Set<string>();
  return skills.filter((skill) => {
    const normalizedName = skill.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      return false;
    }
    seenNames.add(normalizedName);
    return true;
  });
}

/**
 * Whether a composer pick can start this skill. A skill switched off in the
 * provider's settings will not run, and one the provider reserves for the
 * agent (Claude Code's `user-invocable: false`) rejects a user invocation.
 * Everything else, including skills the agent may not start on its own, is
 * fair game: the server dispatches the pick in the provider's native form.
 */
function isProviderSkillUserInvocable(
  skill: Pick<ServerProviderSkill, "enabled" | "userInvocable">,
): boolean {
  return skill.enabled && skill.userInvocable !== false;
}

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const visibleSkillsByList = new WeakMap<
  ReadonlyArray<ServerProviderSkill>,
  ReadonlyArray<ServerProviderSkill>
>();

/**
 * The rows every picker starts from: the skills a user can pick, deduped by
 * name. A skill switched off in T3 Code's settings arrives here already
 * `enabled: false` from the shared fold, so it drops out with the ones the
 * provider itself switched off.
 *
 * Memoised on the list the server published, so a settings change that leaves
 * the skills alone hands the composer the same array back and repaints no row.
 */
export function getVisibleProviderSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  const cached = visibleSkillsByList.get(skills);
  if (cached) return cached;
  const visible = dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable));
  visibleSkillsByList.set(skills, visible);
  return visible;
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ReadonlyArray<ServerProviderSkill> {
  return showSkillsInSlashMenu ? getVisibleProviderSkills(skills) : NO_SKILLS;
}

const SKILL_SOURCE_LABEL_BY_KIND: Record<ProviderSkillSourceKind, string> = {
  app: "App",
  repo: "Repo",
  project: "Project",
  personal: "Personal",
  system: "System",
  other: "Other",
};

/**
 * The short source label a picker row carries, so a Personal `review` and a
 * Project `review` are tellable apart. One map for every client.
 */
export function formatProviderSkillSourceLabel(kind: ProviderSkillSourceKind): string {
  return SKILL_SOURCE_LABEL_BY_KIND[kind];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

function resolveProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string | null | undefined,
) {
  if (!cwd) return undefined;
  return provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
}

export function resolveProviderSkillsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["skills"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.skills ?? provider.skills;
}

export function resolveProviderSlashCommandsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["slashCommands"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.slashCommands ?? provider.slashCommands;
}

/**
 * The folder to delete to stop a provider loading a skill. A skill's `path`
 * names its `SKILL.md`, so the folder around that file is the skill. A provider
 * that reports the folder itself is left alone.
 */
export function providerSkillDirectory(skill: Pick<ServerProviderSkill, "path">): string {
  const skillPath = skill.path.trim();
  const separator = Math.max(skillPath.lastIndexOf("/"), skillPath.lastIndexOf("\\"));
  if (separator <= 0) return skillPath;
  const base = skillPath.slice(separator + 1).toLowerCase();
  return base.endsWith(".md") ? skillPath.slice(0, separator) : skillPath;
}

/**
 * Whether switching a skill off in T3 Code leaves the provider able to start it
 * anyway. T3 Code never writes provider configuration, and every root it scans
 * is a root the provider loads by itself: `<config dir>/skills` and
 * `<cwd>/.claude/skills` for Claude Code, the `.cursor`, `.agents`, `.codex`
 * and `.claude` skill folders for Cursor, `.gemini`, `.agents` and `.agent` for
 * Antigravity, and the catalogs Codex, Grok and OpenCode report about
 * themselves. The answer is therefore yes for every source kind. Two cases say
 * no: the provider already switched the skill off, and a skill the provider
 * reserves for manual invocation (Claude Code's `disable-model-invocation`),
 * which the agent cannot start on its own.
 */
export function providerMayStillInvokeSkill(
  skill: Pick<ServerProviderSkill, "enabled" | "disabledBy" | "userInvocationOnly">,
): boolean {
  if (!skill.enabled && skill.disabledBy === "provider") return false;
  return skill.userInvocationOnly !== true;
}
