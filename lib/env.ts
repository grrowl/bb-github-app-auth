// Builds the provider environment entries contributed to one agent command.
import type { AppIdentity, InstallationToken } from "./github-app.js";

export interface EnvEntry {
  name: string;
  value: string;
  reason: string;
}

export interface EnvOptions {
  appId: string;
  installationId: string;
  gitIdentity: boolean;
  gitPushAsApp: boolean;
}

export function botIdentity(identity: AppIdentity): { name: string; email: string } {
  const name = `${identity.slug}[bot]`;
  return { name, email: `${identity.botUserId}+${name}@users.noreply.github.com` };
}

export function buildEnvEntries(
  token: InstallationToken,
  identity: AppIdentity | null,
  options: EnvOptions,
): EnvEntry[] {
  const tokenReason = `GitHub App ${options.appId} installation token, expires ${token.expiresAt.toISOString()}`;
  const entries: EnvEntry[] = [
    { name: "GH_TOKEN", value: token.token, reason: tokenReason },
    { name: "GITHUB_TOKEN", value: token.token, reason: tokenReason },
    {
      name: "GITHUB_APP_ID",
      value: options.appId,
      reason: "GitHub App that owns the installation token",
    },
    {
      name: "GITHUB_APP_INSTALLATION_ID",
      value: options.installationId,
      reason: "GitHub App installation the token was minted for",
    },
  ];
  if (identity !== null) {
    entries.push({
      name: "GITHUB_APP_SLUG",
      value: identity.slug,
      reason: "GitHub App slug; the bot login is <slug>[bot]",
    });
  }
  if (options.gitIdentity && identity !== null) {
    const bot = botIdentity(identity);
    const reason = "Commit as the GitHub App bot user";
    entries.push(
      { name: "GIT_AUTHOR_NAME", value: bot.name, reason },
      { name: "GIT_AUTHOR_EMAIL", value: bot.email, reason },
      { name: "GIT_COMMITTER_NAME", value: bot.name, reason },
      { name: "GIT_COMMITTER_EMAIL", value: bot.email, reason },
    );
  }
  if (options.gitPushAsApp) {
    entries.push(...gitConfigEntries());
  }
  return entries;
}

// Git reads GIT_CONFIG_COUNT/KEY_n/VALUE_n as config with the highest
// precedence. An empty helper value resets the helper list so a keychain
// helper cannot answer with a personal credential first, and the insteadOf
// rewrites send SSH remotes over HTTPS where the token applies.
function gitConfigEntries(): EnvEntry[] {
  const pairs: Array<[string, string]> = [
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", "!gh auth git-credential"],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ];
  const reason = "Route git pushes to github.com through gh with the app token";
  const entries: EnvEntry[] = [
    { name: "GIT_CONFIG_COUNT", value: String(pairs.length), reason },
  ];
  pairs.forEach(([key, value], index) => {
    entries.push(
      { name: `GIT_CONFIG_KEY_${index}`, value: key, reason },
      { name: `GIT_CONFIG_VALUE_${index}`, value, reason },
    );
  });
  return entries;
}
