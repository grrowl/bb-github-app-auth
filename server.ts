// bb-plugin-github-app-auth — server entry.
//
// For every agent command (start, resume, fork, turn) in an enabled project,
// contribute a fresh GitHub App installation token as GH_TOKEN and
// GITHUB_TOKEN, plus the git identity and config that make commits and pushes
// belong to the app. Tokens live about one hour; each source re-mints when a
// token is inside the refresh margin, and a background loop keeps a recently
// used token warm so the per-command resolver stays fast.
//
// Credentials come from three places, most specific first: a project's own
// stored credentials (`bb github-app-auth set-app`, kept in the plugin's
// server-side storage and never sent to an agent), the plugin settings, and
// the bb server process environment. Project credentials are the way to scope
// one GitHub App to one project without exposing it to any other project.
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
/** kv key prefix for a project's stored GitHub App credentials. */
const APP_PREFIX = "app:";

interface ResolvedConfig {
  app: AppConfig | null;
  projects: string[];
  enableByEnvVar: boolean;
  enableEnvVarName: string;
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
      label: "Default GitHub App ID (used when a project has no stored app)",
      default: "",
    },
    installationId: {
      type: "string",
      label: "Default GitHub App installation ID",
      default: "",
    },
    privateKeyPath: {
      type: "string",
      label: "Default private key PEM path (on the bb server machine; ~ allowed)",
      default: "",
    },
    projects: {
      type: "string",
      label: "Projects that receive the default app (comma-separated names or ids)",
      default: "",
    },
    enableByEnvVar: {
      type: "boolean",
      label:
        "Also give the default app to any project that defines the GITHUB_APP_ID environment variable",
      default: true,
    },
    enableEnvVarName: {
      type: "string",
      label: "Environment variable whose presence enables the default app for a project",
      default: "GITHUB_APP_ID",
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

  // The default app fills any project that has no stored app of its own. Its
  // credentials come from plugin settings, then the bb server environment.
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
      enableByEnvVar: values.enableByEnvVar,
      enableEnvVarName: values.enableEnvVarName.trim() || "GITHUB_APP_ID",
      providerIds: splitList(values.providerIds),
      refreshMarginMs: values.refreshMarginMinutes * 60 * 1000,
      gitIdentity: values.gitIdentity,
      gitPushAsApp: values.gitPushAsApp,
    };
  }

  let config = await loadConfig();

  // One token source per distinct app, keyed by app id, installation and key
  // path, so a per-project app and the default app never share a token cache.
  const sources = new Map<string, InstallationTokenSource>();
  function getSourceFor(app: AppConfig): InstallationTokenSource {
    const key = configKey(app);
    let existing = sources.get(key);
    if (existing === undefined) {
      existing = new InstallationTokenSource(app, config.refreshMarginMs, bb.log);
      sources.set(key, existing);
    }
    return existing;
  }

  // A project's own stored credentials. Kept in the plugin's server-side
  // storage, so only the projects you set have an app and none of it reaches
  // an agent's environment.
  const appConfigSchema = z.object({
    appId: z.string().min(1),
    installationId: z.string().min(1),
    privateKeyPath: z.string().min(1),
  });
  async function projectApp(projectId: string): Promise<AppConfig | null> {
    const stored = await bb.storage.kv.get<unknown>(APP_PREFIX + projectId);
    if (stored === undefined) return null;
    const parsed = appConfigSchema.safeParse(stored);
    return parsed.success ? parsed.data : null;
  }
  async function listProjectApps(): Promise<Array<{ projectId: string; app: AppConfig }>> {
    const keys = await bb.storage.kv.list(APP_PREFIX);
    const rows: Array<{ projectId: string; app: AppConfig }> = [];
    for (const key of keys) {
      const projectId = key.slice(APP_PREFIX.length);
      const app = await projectApp(projectId);
      if (app !== null) rows.push({ projectId, app });
    }
    return rows;
  }

  settings.onChange(async () => {
    config = await loadConfig();
    sources.clear();
    bb.log.info("settings changed; token cache cleared");
  });

  const hasProjectApps = (await bb.storage.kv.list(APP_PREFIX)).length > 0;
  if (config.app === null && !hasProjectApps) {
    bb.status.needsConfiguration(
      "Store a per-project app with `bb github-app-auth set-app`, or set appId, installationId and privateKeyPath (or export GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY_PATH for the bb server) and run `bb plugin reload github-app-auth`.",
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

  // The default app reaches a project on the projects list, or, when
  // enableByEnvVar is on, a project that defines the enable environment
  // variable. Project environment values are masked from plugins, so only the
  // presence of the name is read here, never its value. An inherited global
  // variable is excluded, so a global value of the same name never turns
  // projects on.
  const envVarProjects = new Map<string, { present: boolean; at: number }>();
  async function projectDefinesEnableVar(projectId: string): Promise<boolean> {
    const cached = envVarProjects.get(projectId);
    if (cached !== undefined && Date.now() - cached.at < PROJECT_NAME_TTL_MS) {
      return cached.present;
    }
    try {
      const env = await bb.sdk.projects.machineEnvironment({ projectId });
      const present = env.variables.some(
        (entry) => entry.name === config.enableEnvVarName,
      );
      envVarProjects.set(projectId, { present, at: Date.now() });
      return present;
    } catch (error) {
      bb.log.warn(`could not read env for project ${projectId}: ${String(error)}`);
      return cached?.present ?? false;
    }
  }
  async function defaultAppEnabled(projectId: string): Promise<boolean> {
    if (config.app === null) return false;
    if (config.projects.includes(projectId)) return true;
    const name = await projectName(projectId);
    if (
      name !== null &&
      config.projects.some((entry) => entry.toLowerCase() === name.toLowerCase())
    ) {
      return true;
    }
    return config.enableByEnvVar && (await projectDefinesEnableVar(projectId));
  }

  // The app a project should use, or null when the project gets no token.
  async function appForProject(projectId: string): Promise<AppConfig | null> {
    const own = await projectApp(projectId);
    if (own !== null) return own;
    if (await defaultAppEnabled(projectId)) return config.app;
    return null;
  }

  async function resolveEntries(
    projectId: string,
  ): Promise<ExperimentalPluginProviderEnvEntry[]> {
    const app = await appForProject(projectId);
    if (app === null) return [];
    const tokenSource = getSourceFor(app);
    const token = await tokenSource.getToken();
    let identity = null;
    try {
      identity = await tokenSource.getIdentity();
    } catch (error) {
      bb.log.warn(`could not resolve app identity: ${String(error)}`);
    }
    return buildEnvEntries(token, identity, {
      appId: app.appId,
      installationId: app.installationId,
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

  // A new thread in an enabled project warms its token before the first turn.
  bb.events.on("thread.created", async ({ thread }) => {
    const app = await appForProject(thread.projectId);
    if (app === null) return;
    const tokenSource = getSourceFor(app);
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
        const now = Date.now();
        for (const tokenSource of sources.values()) {
          if (
            !tokenSource.status().hasToken ||
            now - tokenSource.lastUsedAt > WARM_WINDOW_MS ||
            !tokenSource.needsRefresh(now)
          ) {
            continue;
          }
          await tokenSource.getToken().catch(() => undefined);
        }
      }
    },
  });

  function resolveProjectId(
    explicit: string | undefined,
    ctx: PluginCliContext,
  ): string {
    const projectId = explicit ?? ctx.projectId;
    if (projectId === undefined) {
      throw new PluginCliError("no project in context", {
        code: "project_required",
        hint: "Add --project <id> (run `bb status` to see the current project id).",
      });
    }
    return projectId;
  }

  async function requireSourceFor(projectId: string): Promise<InstallationTokenSource> {
    const app = await appForProject(projectId);
    if (app === null) {
      throw new PluginCliError(`project ${projectId} has no GitHub App`, {
        code: "project_not_enabled",
        hint: "Store one with `bb github-app-auth set-app`, add the project to the projects setting, or define the GITHUB_APP_ID environment variable on the project.",
      });
    }
    return getSourceFor(app);
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
      summary: "Store, inspect and refresh the GitHub App credentials injected into agent turns",
      commands: {
        status: cliCommand({
          summary: "Show configuration, stored project apps and token expiry (never the token)",
          options: { json: jsonOption },
          async run(input) {
            const projectApps = await listProjectApps();
            const tokenState = (app: AppConfig) =>
              sources.get(configKey(app))?.status() ?? null;
            const payload = {
              defaultApp:
                config.app === null
                  ? null
                  : {
                      appId: config.app.appId,
                      installationId: config.app.installationId,
                      privateKeyPath: expandHome(config.app.privateKeyPath),
                      projects: config.projects,
                      enableByEnvVar: config.enableByEnvVar,
                      enableEnvVarName: config.enableEnvVarName,
                      token: tokenState(config.app),
                    },
              projectApps: projectApps.map(({ projectId, app }) => ({
                projectId,
                appId: app.appId,
                installationId: app.installationId,
                privateKeyPath: expandHome(app.privateKeyPath),
                token: tokenState(app),
              })),
              providerIds: config.providerIds,
              refreshMarginMinutes: config.refreshMarginMs / 60000,
              gitIdentity: config.gitIdentity,
              gitPushAsApp: config.gitPushAsApp,
            };
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(payload) };
            }
            const tokenLine = (state: ReturnType<typeof tokenState>) =>
              `${state?.hasToken ?? false}${state?.expiresAt ? ` (expires ${state.expiresAt})` : ""}`;
            const identityLine = (state: ReturnType<typeof tokenState>) =>
              state?.identity
                ? `${state.identity.slug}[bot] (user ${state.identity.botUserId})`
                : "-";
            const lines: string[] = [];
            if (payload.defaultApp === null) {
              lines.push("default app: none");
            } else {
              const d = payload.defaultApp;
              lines.push(
                "default app:",
                `  app id: ${d.appId}`,
                `  installation id: ${d.installationId}`,
                `  private key path: ${d.privateKeyPath}`,
                `  projects: ${d.projects.join(", ") || "-"}`,
                `  enable by env var: ${d.enableByEnvVar} (${d.enableEnvVarName})`,
                `  token cached: ${tokenLine(d.token)}`,
                `  app identity: ${identityLine(d.token)}`,
              );
            }
            if (payload.projectApps.length === 0) {
              lines.push("project apps: none");
            } else {
              lines.push("project apps:");
              for (const p of payload.projectApps) {
                lines.push(
                  `  ${p.projectId}:`,
                  `    app id: ${p.appId}`,
                  `    installation id: ${p.installationId}`,
                  `    private key path: ${p.privateKeyPath}`,
                  `    token cached: ${tokenLine(p.token)}`,
                  `    app identity: ${identityLine(p.token)}`,
                );
              }
            }
            lines.push(
              `providers: ${payload.providerIds.join(", ") || "-"}`,
              `refresh margin: ${payload.refreshMarginMinutes} min`,
              `git identity: ${payload.gitIdentity}`,
              `git push as app: ${payload.gitPushAsApp}`,
            );
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        "set-app": cliCommand({
          summary: "Store the GitHub App credentials for a project (server-side, never sent to an agent)",
          options: {
            project: projectOption,
            "app-id": { type: "string", required: true, description: "GitHub App ID" },
            "installation-id": {
              type: "string",
              required: true,
              description: "GitHub App installation ID",
            },
            "key-path": {
              type: "string",
              required: true,
              description: "Private key PEM path on the bb server (~ allowed)",
            },
            json: jsonOption,
          },
          async run(input, ctx) {
            const projectId = resolveProjectId(input.options.project, ctx);
            const app: AppConfig = {
              appId: input.options["app-id"],
              installationId: input.options["installation-id"],
              privateKeyPath: input.options["key-path"],
            };
            await bb.storage.kv.set(APP_PREFIX + projectId, app);
            sources.delete(configKey(app));
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ projectId, appId: app.appId, installationId: app.installationId })
                : `stored app ${app.appId} for project ${projectId}`,
            };
          },
        }),
        "unset-app": cliCommand({
          summary: "Remove a project's stored GitHub App credentials",
          options: { project: projectOption, json: jsonOption },
          async run(input, ctx) {
            const projectId = resolveProjectId(input.options.project, ctx);
            const existing = await projectApp(projectId);
            await bb.storage.kv.delete(APP_PREFIX + projectId);
            if (existing !== null) sources.delete(configKey(existing));
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ projectId, removed: existing !== null })
                : existing !== null
                  ? `removed the app for project ${projectId}`
                  : `project ${projectId} had no stored app`,
            };
          },
        }),
        token: cliCommand({
          summary: "Print a current installation token for the project (mints one when stale)",
          options: { project: projectOption, json: jsonOption },
          async run(input, ctx) {
            const projectId = resolveProjectId(input.options.project, ctx);
            const token = await (await requireSourceFor(projectId)).getToken();
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
            const projectId = resolveProjectId(input.options.project, ctx);
            await requireSourceFor(projectId);
            const entries = await resolveEntries(projectId);
            const lines = entries
              .filter((entry) => entry.name === "GH_TOKEN" || entry.name === "GITHUB_TOKEN")
              .map((entry) => `export ${entry.name}=${shellQuote(String(entry.value))}`);
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        refresh: cliCommand({
          summary: "Discard the cached token for a project and mint a new one now",
          options: { project: projectOption, json: jsonOption },
          async run(input, ctx) {
            const projectId = resolveProjectId(input.options.project, ctx);
            const token = await (await requireSourceFor(projectId)).getToken({ force: true });
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
    sources.clear();
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
