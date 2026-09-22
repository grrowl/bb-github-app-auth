// GitHub App installation token source.
//
// One instance per (appId, installationId, private key). It keeps at most one
// live installation token in memory and re-mints when the token is within the
// refresh margin of its expiry. Concurrent callers share one in-flight mint.
// Nothing in this module logs a token or the private key.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { createAppAuth } from "@octokit/auth-app";

export interface AppConfig {
  appId: string;
  installationId: string;
  privateKeyPath: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

export interface AppIdentity {
  /** The app's URL slug, e.g. `my-app`. */
  slug: string;
  /** The `<slug>[bot]` user id used in noreply email addresses. */
  botUserId: number;
}

export interface TokenSourceStatus {
  hasToken: boolean;
  expiresAt: string | null;
  identity: AppIdentity | null;
  lastError: string | null;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolvePath(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolvePath(path);
}

export async function readPrivateKey(path: string): Promise<string> {
  const pem = await readFile(expandHome(path), "utf8");
  if (!pem.includes("-----BEGIN")) {
    throw new Error(`private key file at ${path} is not a PEM file`);
  }
  return pem;
}

export function configKey(config: AppConfig): string {
  return `${config.appId}:${config.installationId}:${expandHome(config.privateKeyPath)}`;
}

const GITHUB_API = "https://api.github.com";

export class InstallationTokenSource {
  readonly key: string;
  private auth: ReturnType<typeof createAppAuth> | null = null;
  private current: InstallationToken | null = null;
  private pending: Promise<InstallationToken> | null = null;
  private identity: AppIdentity | null = null;
  private identityPending: Promise<AppIdentity> | null = null;
  private lastError: string | null = null;
  /** Epoch ms of the most recent getToken call; drives background refresh. */
  lastUsedAt = 0;

  constructor(
    readonly config: AppConfig,
    private readonly refreshMarginMs: number,
    private readonly log: { info(m: string): void; warn(m: string): void },
  ) {
    this.key = configKey(config);
  }

  private async getAuth(): Promise<ReturnType<typeof createAppAuth>> {
    if (this.auth === null) {
      const privateKey = await readPrivateKey(this.config.privateKeyPath);
      this.auth = createAppAuth({
        appId: this.config.appId,
        privateKey,
        installationId: this.config.installationId,
      });
    }
    return this.auth;
  }

  /** True when the cached token expires inside the refresh margin. */
  needsRefresh(now = Date.now()): boolean {
    return (
      this.current === null ||
      this.current.expiresAt.getTime() - now <= this.refreshMarginMs
    );
  }

  /** Return the cached token, or mint a new one when it is missing or stale. */
  async getToken(options: { force?: boolean } = {}): Promise<InstallationToken> {
    this.lastUsedAt = Date.now();
    if (!options.force && !this.needsRefresh() && this.current !== null) {
      return this.current;
    }
    if (this.pending === null) {
      this.pending = this.mint().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async mint(): Promise<InstallationToken> {
    try {
      const auth = await this.getAuth();
      const result = await auth({ type: "installation", refresh: true });
      const token = { token: result.token, expiresAt: new Date(result.expiresAt) };
      this.current = token;
      this.lastError = null;
      this.log.info(
        `minted installation token for app ${this.config.appId} installation ${this.config.installationId}; expires ${token.expiresAt.toISOString()}`,
      );
      return token;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.log.warn(
        `failed to mint installation token for app ${this.config.appId}: ${message}`,
      );
      throw error;
    }
  }

  /** Resolve the app slug and bot user id once; both are stable for an app. */
  async getIdentity(): Promise<AppIdentity> {
    if (this.identity !== null) return this.identity;
    if (this.identityPending === null) {
      this.identityPending = this.fetchIdentity().finally(() => {
        this.identityPending = null;
      });
    }
    return this.identityPending;
  }

  private async fetchIdentity(): Promise<AppIdentity> {
    // `/app` accepts only the app JWT; `/users/*` accepts only a token.
    const auth = await this.getAuth();
    const appAuth = await auth({ type: "app" });
    const app = await githubJson<{ slug: string }>("/app", appAuth.token);
    const installation = await this.getToken();
    const user = await githubJson<{ id: number }>(
      `/users/${encodeURIComponent(`${app.slug}[bot]`)}`,
      installation.token,
    );
    this.identity = { slug: app.slug, botUserId: user.id };
    return this.identity;
  }

  status(): TokenSourceStatus {
    return {
      hasToken: this.current !== null,
      expiresAt: this.current?.expiresAt.toISOString() ?? null,
      identity: this.identity,
      lastError: this.lastError,
    };
  }
}

async function githubJson<T>(path: string, bearer: string): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${bearer}`,
      "user-agent": "bb-plugin-github-app-auth",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}
