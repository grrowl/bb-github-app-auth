// bb-plugin-github-app-auth — server entry.
//
// For every agent command (start, resume, fork, turn) in a configured project,
// contribute a fresh GitHub App installation token as GH_TOKEN and
// GITHUB_TOKEN, plus the git identity and config that make commits and pushes
// belong to the app. Tokens live about one hour; the source re-mints when a
// token is inside the refresh margin, and a background loop keeps a recently
// used token warm so the per-command resolver stays fast.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type ExperimentalPluginProviderEnvContext,
  type ExperimentalPluginProviderEnvEntry,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { buildEnvEntries } from "./lib/env.js";
import {
  InstallationTokenSource,
  configKey,
  expandHome,
  type AppConfig,
} from "./lib/github-app.js";

const DEFAULT_PROVIDER_IDS =
  "claude-code,codex,pi,acp-cursor,acp-opencode,acp-hermes-agent,acp-amp";
/** Stop background refresh when no command used the token for this long. */
const WARM_WINDOW_MS = 2 * 60 * 60 * 1000;
const REFRESH_LOOP_MS = 30 * 1000;
const PROJECT_NAME_TTL_MS = 60 * 1000;

interface ResolvedConfig {
  app: AppConfig | null;
  projects: string[];
  providerIds: string[];
  refreshMarginMs: number;
  gitIdentity: boolean;
  gitPushAsApp: boolean;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    appId: {
      type: "string",
      label: "GitHub App ID",
      default: "",
    },
    installationId: {
      type: "string",
      label: "GitHub App installation ID",
      default: "",
    },
    privateKeyPath: {
      type: "string",
      label: "Private key PEM path (on the bb server machine; ~ allowed)",
      default: "",
    },
    projects: {
      type: "string",
      label: "Projects that receive the token (comma-separated names or ids)",
      default: "",
    },
    providerIds: {
      type: "string",
      label: "Provider ids that receive the token (comma-separated; reload after a change)",
      default: DEFAULT_PROVIDER_IDS,
    },
    refreshMarginMinutes: {
      type: "number",
      label: "Re-mint when fewer than this many minutes remain",
      default: 10,
      experimental_schema: z.number().int().min(1).max(50),
    },
    gitIdentity: {
      type: "boolean",
      label: "Set git author and committer to the app bot user",
      default: true,
    },
    gitPushAsApp: {
      type: "boolean",
      label: "Rewrite github.com SSH remotes to HTTPS and authenticate git with the token",
      default: true,
    },
  });

  // Settings win; the server's own GITHUB_APP_* variables fill any gap so a
  // host that already exports them needs no plugin configuration.
  async function loadConfig(): Promise<ResolvedConfig> {
    const values = await settings.get();
    const env = process.env;
    const appId = values.appId.trim() || env.GITHUB_APP_ID?.trim() || "";
    const installationId =
      values.installationId.trim() || env.GITHUB_APP_INSTALLATION_ID?.trim() || "";
    const privateKeyPath =
      values.privateKeyPath.trim() || env.GITHUB_APP_PRIVATE_KEY_PATH?.trim() || "";
    return {
      app:
        appId !== "" && installationId !== "" && privateKeyPath !== ""
          ? { appId, installationId, privateKeyPath }
          : null,
      projects: splitList(values.projects),
      providerIds: splitList(values.providerIds),
      refreshMarginMs: values.refreshMarginMinutes * 60 * 1000,
      gitIdentity: values.gitIdentity,
      gitPushAsApp: values.gitPushAsApp,
    };
  }

  let config = await loadConfig();
  let source: InstallationTokenSource | null = null;
  let lastUsedAt = 0;

  function getSource(): InstallationTokenSource | null {
    if (config.app === null) return null;
    if (source === null || source.key !== configKey(config.app)) {
      source = new InstallationTokenSource(config.app, config.refreshMarginMs, bb.log);
    }
    return source;
  }

  settings.onChange(async () => {
    config = await loadConfig();
    source = null;
    bb.log.info("settings changed; token cache cleared");
  });

  if (config.app === null) {
    bb.status.needsConfiguration(
      "Set appId, installationId and privateKeyPath (or export GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY_PATH for the bb server), then run `bb plugin reload github-app-auth`.",
    );
  } else if (config.projects.length === 0) {
    bb.status.needsConfiguration(
      "Set projects to the project names or ids that should receive the token, then run `bb plugin reload github-app-auth`.",
    );
  }

  // Project names are matched case-insensitively; ids match exactly.
  const projectNames = new Map<string, { name: string; at: number }>();
  async function projectName(projectId: string): Promise<string | null> {
    const cached = projectNames.get(projectId);
    if (cached !== undefined && Date.now() - cached.at < PROJECT_NAME_TTL_MS) {
      return cached.name;
    }
    try {
      const project = await bb.sdk.projects.get({ projectId });
      projectNames.set(projectId, { name: project.name, at: Date.now() });
      return project.name;
    } catch (error) {
      bb.log.warn(`could not read project ${projectId}: ${String(error)}`);
      return cached?.name ?? null;
    }
  }
  async function projectEnabled(projectId: string): Promise<boolean> {
    if (config.projects.length === 0) return false;
    if (config.projects.includes(projectId)) return true;
    const name = await projectName(projectId);
    if (name === null) return false;
    const wanted = name.toLowerCase();
    return config.projects.some((entry) => entry.toLowerCase() === wanted);
  }

  async function resolveEntries(
    projectId: string,
  ): Promise<ExperimentalPluginProviderEnvEntry[]> {
    const tokenSource = getSource();
    if (tokenSource === null || !(await projectEnabled(projectId))) return [];
    const token = await tokenSource.getToken();
    lastUsedAt = Date.now();
    let identity = null;
    try {
      identity = await tokenSource.getIdentity();
    } catch (error) {
      bb.log.warn(`could not resolve app identity: ${String(error)}`);
    }
    return buildEnvEntries(token, identity, {
      appId: tokenSource.config.appId,
      installationId: tokenSource.config.installationId,
      gitIdentity: config.gitIdentity,
      gitPushAsApp: config.gitPushAsApp,
    });
  }

  async function contributeEnv(
    context: ExperimentalPluginProviderEnvContext,
  ): Promise<ExperimentalPluginProviderEnvEntry[]> {
    try {
      return await resolveEntries(context.projectId);
    } catch (error) {
      bb.log.warn(
        `no GitHub token for thread ${context.threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  for (const providerId of config.providerIds) {
    bb.providers.experimental_contributeEnv(providerId, contributeEnv);
  }

  // A new thread in an enabled project warms the token before its first turn.
  bb.events.on("thread.created", async ({ thread }) => {
    const tokenSource = getSource();
    if (tokenSource === null || !(await projectEnabled(thread.projectId))) return;
    await Promise.all([
      tokenSource.getToken().catch(() => undefined),
      tokenSource.getIdentity().catch(() => undefined),
    ]);
  });

  bb.background.service("token-refresh", {
    async start(signal) {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, REFRESH_LOOP_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (signal.aborted) return;
        const tokenSource = source;
        if (
          tokenSource === null ||
          !tokenSource.status().hasToken ||
          Date.now() - lastUsedAt > WARM_WINDOW_MS ||
          !tokenSource.needsRefresh()
        ) {
          continue;
        }
        await tokenSource.getToken().catch(() => undefined);
      }
    },
  });

  async function projectFromCli(
    explicit: string | undefined,
    ctx: PluginCliContext,
  ): Promise<string> {
    const projectId = explicit ?? ctx.projectId;
    if (projectId === undefined) {
      throw new PluginCliError("no project in context", {
        code: "project_required",
        hint: "Add --project <id> (run `bb status` to see the current project id).",
      });
    }
    if (!(await projectEnabled(projectId))) {
      throw new PluginCliError(`project ${projectId} does not receive the token`, {
        code: "project_not_enabled",
        hint: "Add the project name or id to the plugin's projects setting, then run `bb plugin reload github-app-auth`.",
      });
    }
    return projectId;
  }

  function requireSource(): InstallationTokenSource {
    const tokenSource = getSource();
    if (tokenSource === null) {
      throw new PluginCliError("GitHub App is not configured", {
        code: "not_configured",
        hint: "Set appId, installationId and privateKeyPath with `bb plugin config github-app-auth set <key> <value>`.",
      });
    }
    return tokenSource;
  }

  const projectOption = {
    type: "string",
    description: "Project id; defaults to the current thread's project",
  } as const;
  const jsonOption = {
    type: "boolean",
    description: "Emit machine-readable JSON",
  } as const;

  bb.cli.register(
    defineCli({
      name: "github-app-auth",
      summary: "Inspect and refresh the GitHub App installation token injected into agent turns",
      commands: {
        status: cliCommand({
          summary: "Show configuration, enabled projects and token expiry (never the token)",
          options: { json: jsonOption },
          async run(input) {
            const tokenSource = getSource();
            const state = tokenSource?.status() ?? null;
            const payload = {
              configured: config.app !== null,
              appId: config.app?.appId ?? null,
              installationId: config.app?.installationId ?? null,
              privateKeyPath:
                config.app === null ? null : expandHome(config.app.privateKeyPath),
              projects: config.projects,
              providerIds: config.providerIds,
              refreshMarginMinutes: config.refreshMarginMs / 60000,
              gitIdentity: config.gitIdentity,
              gitPushAsApp: config.gitPushAsApp,
              token: state,
            };
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(payload) };
            }
            const lines = [
              `configured: ${payload.configured}`,
              `app id: ${payload.appId ?? "-"}`,
              `installation id: ${payload.installationId ?? "-"}`,
              `private key path: ${payload.privateKeyPath ?? "-"}`,
              `projects: ${payload.projects.join(", ") || "-"}`,
              `providers: ${payload.providerIds.join(", ") || "-"}`,
              `refresh margin: ${payload.refreshMarginMinutes} min`,
              `git identity: ${payload.gitIdentity}`,
              `git push as app: ${payload.gitPushAsApp}`,
              `token cached: ${state?.hasToken ?? false}${state?.expiresAt ? ` (expires ${state.expiresAt})` : ""}`,
              `app identity: ${state?.identity ? `${state.identity.slug}[bot] (user ${state.identity.botUserId})` : "-"}`,
              `last error: ${state?.lastError ?? "-"}`,
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        token: cliCommand({
          summary: "Print a current installation token for the project (mints one when stale)",
          options: { project: projectOption, json: jsonOption },
          async run(input, ctx) {
            await projectFromCli(input.options.project, ctx);
            const token = await requireSource().getToken();
            lastUsedAt = Date.now();
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ token: token.token, expiresAt: token.expiresAt.toISOString() })
                : token.token,
            };
          },
        }),
        env: cliCommand({
          summary: "Print export lines for GH_TOKEN and GITHUB_TOKEN; use with eval to refresh a long-running shell",
          options: { project: projectOption },
          async run(input, ctx) {
            const projectId = await projectFromCli(input.options.project, ctx);
            const entries = await resolveEntries(projectId);
            lastUsedAt = Date.now();
            const lines = entries
              .filter((entry) => entry.name === "GH_TOKEN" || entry.name === "GITHUB_TOKEN")
              .map((entry) => `export ${entry.name}=${shellQuote(String(entry.value))}`);
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        refresh: cliCommand({
          summary: "Discard the cached token and mint a new one now",
          options: { json: jsonOption },
          async run(input) {
            const token = await requireSource().getToken({ force: true });
            lastUsedAt = Date.now();
            const expiresAt = token.expiresAt.toISOString();
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ expiresAt })
                : `minted a new installation token; expires ${expiresAt}`,
            };
          },
        }),
      },
    }),
  );

  bb.onDispose(() => {
    source = null;
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
