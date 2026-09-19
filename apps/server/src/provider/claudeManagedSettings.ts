/**
 * Fork-only. Whether this machine already carries an IT-managed Claude
 * settings tier.
 *
 * It matters because of one line in the Agent SDK contract: when a managed tier
 * exists, `parentSettingsBehavior` defaults to `"first-wins"` and the policy an
 * embedding app hands the subprocess — `CLAUDE_FIRST_PARTY_LOCKDOWN`, sent as
 * `managedSettings` / `--managed-settings` — is dropped whole. T3 Code must not
 * try to outrank an administrator, so it detects the situation and says so on
 * the instance instead of drawing a gate that is not closed.
 *
 * Only the file sources are detectable from here. MDM-delivered policy (the
 * macOS `com.anthropic.claudecode` managed plist, the Windows
 * `HKLM\SOFTWARE\Policies\ClaudeCode` key) and server-managed settings outrank
 * the same way and leave nothing on disk to stat, so absence is not proof.
 *
 * @module provider/claudeManagedSettings
 */
import * as Effect from "effect/Effect";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

/**
 * The directory Claude Code reads managed settings from, matching the CLI's own
 * per-platform resolution. `CLAUDE_CODE_MANAGED_SETTINGS_PATH` overrides it
 * there, so it overrides it here.
 */
export function claudeManagedSettingsDirectory(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  const override = env.CLAUDE_CODE_MANAGED_SETTINGS_PATH?.trim();
  if (override) return override;
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

/**
 * Both file sources Claude Code's policy walk reads: the single file and the
 * drop-in directory beside it. Either one present means a managed tier.
 */
export function claudeManagedSettingsPaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const directory = claudeManagedSettingsDirectory(platform, env);
  const separator = platform === "win32" ? "\\" : "/";
  const prefix = directory.endsWith(separator) ? directory : `${directory}${separator}`;
  return [`${prefix}managed-settings.json`, `${prefix}managed-settings.d`];
}

/**
 * `exists` is injected rather than taken from `FileSystem` so the platform
 * branches above can be tested without a real `/etc` or `/Library`; the
 * platform and environment come from the host references, which tests override
 * the same way. A reader that fails must answer "no" — an unreadable path is
 * not evidence of policy, and this runs inside a provider snapshot.
 */
export const hasClaudeManagedSettings = (
  exists: (path: string) => Effect.Effect<boolean>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const paths = claudeManagedSettingsPaths(
      yield* HostProcessPlatform,
      yield* HostProcessEnvironment,
    );
    const found = yield* Effect.forEach(paths, exists);
    return found.includes(true);
  });
