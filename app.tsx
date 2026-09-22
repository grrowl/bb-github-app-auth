// bb-plugin-github-app-auth — settings page.
//
// Rendered below the host's own settings form on the plugin's settings page.
// The form above edits the default app (all projects). This section shows that
// default app read-only, then a project dropdown for storing one GitHub App on
// one project, the way bb's own Environment variables page scopes values.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  definePluginApp,
  useBbContext,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { OverviewResult, ProjectSummary, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const ALL_PROJECTS = "__all__";

type ProjectApp = OverviewResult["projectApps"][number];

function tokenLine(token: ProjectApp["token"]): string {
  if (token === null || !token.hasToken) return "no token cached yet";
  const parts: string[] = [];
  if (token.identity !== null) parts.push(token.identity);
  if (token.expiresAt !== null) parts.push(`expires ${token.expiresAt}`);
  return parts.length > 0 ? `token cached (${parts.join(", ")})` : "token cached";
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  mono?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={cn(mono && "font-mono")}
      />
    </label>
  );
}

function DefaultAppCard({ overview }: { overview: OverviewResult }) {
  const app = overview.defaultApp;
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">All projects</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        The default app comes from the settings above. A project without its own
        app uses it when the project is listed or defines the enable variable.
      </p>
      {app === null ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No default app is set. Fill in the App ID, installation ID and private
          key path above, or leave them empty to use only per-project apps.
        </p>
      ) : (
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">App ID</dt>
          <dd className="font-mono">{app.appId}</dd>
          <dt className="text-muted-foreground">Installation ID</dt>
          <dd className="font-mono">{app.installationId}</dd>
          <dt className="text-muted-foreground">Private key</dt>
          <dd className="truncate font-mono">{app.privateKeyPath}</dd>
          <dt className="text-muted-foreground">Projects</dt>
          <dd>{app.projects.length > 0 ? app.projects.join(", ") : "none"}</dd>
          <dt className="text-muted-foreground">Enable by variable</dt>
          <dd>
            {app.enableByEnvVar ? `on (${app.enableEnvVarName})` : "off"}
          </dd>
          <dt className="text-muted-foreground">Token</dt>
          <dd>{tokenLine(app.token)}</dd>
        </dl>
      )}
    </section>
  );
}

function ProjectEditor({
  projects,
  overview,
  selected,
  onSelect,
  onChanged,
}: {
  projects: ProjectSummary[];
  overview: OverviewResult;
  selected: string;
  onSelect: (projectId: string) => void;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const stored = useMemo(
    () => new Map(overview.projectApps.map((app) => [app.projectId, app])),
    [overview.projectApps],
  );
  const current = selected === ALL_PROJECTS ? undefined : stored.get(selected);

  const [appId, setAppId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [busy, setBusy] = useState(false);

  // Reload the form when the selected project or its stored values change.
  useEffect(() => {
    setAppId(current?.appId ?? "");
    setInstallationId(current?.installationId ?? "");
    setKeyPath(current?.privateKeyPath ?? "");
  }, [current?.appId, current?.installationId, current?.privateKeyPath, selected]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === ALL_PROJECTS || busy) return;
    if (appId.trim() === "" || installationId.trim() === "" || keyPath.trim() === "") {
      toast.error("App ID, installation ID and private key path are all required.");
      return;
    }
    setBusy(true);
    try {
      await rpc.call("app_set", {
        projectId: selected,
        appId: appId.trim(),
        installationId: installationId.trim(),
        privateKeyPath: keyPath.trim(),
      });
      toast.success("Saved the app for this project.");
      onChanged();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (selected === ALL_PROJECTS || busy) return;
    setBusy(true);
    try {
      const { removed } = await rpc.call("app_unset", { projectId: selected });
      toast.success(removed ? "Removed the app for this project." : "No app to remove.");
      onChanged();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const nameFor = (id: string) =>
    projects.find((project) => project.id === id)?.name ?? id;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">One project</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Store one GitHub App for one project. It stays on the bb server and no
        agent can read it.
      </p>

      <label className="mt-3 flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">Project</span>
        <select
          value={selected}
          onChange={(event) => onSelect(event.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value={ALL_PROJECTS}>Choose a project…</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
              {stored.has(project.id) ? "  • has app" : ""}
            </option>
          ))}
        </select>
      </label>

      {selected === ALL_PROJECTS ? null : (
        <form onSubmit={save} className="mt-4 flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {stored.has(selected)
              ? `Editing the app stored for ${nameFor(selected)}.`
              : `No app stored for ${nameFor(selected)} yet.`}
          </p>
          <Field label="App ID" value={appId} onChange={setAppId} placeholder="123456" mono />
          <Field
            label="Installation ID"
            value={installationId}
            onChange={setInstallationId}
            placeholder="98765432"
            mono
          />
          <Field
            label="Private key path"
            value={keyPath}
            onChange={setKeyPath}
            placeholder="~/.config/github-apps/my-app.private-key.pem"
            mono
          />
          {current?.token ? (
            <p className="text-xs text-muted-foreground">{tokenLine(current.token)}</p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={busy}>
              <Icon name="Check" className="size-4" />
              Save app
            </Button>
            {stored.has(selected) ? (
              <Button
                type="button"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={busy}
                onClick={remove}
              >
                <Icon name="Trash2" className="size-4" />
                Remove
              </Button>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}

function SettingsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const context = useBbContext();
  const [overview, setOverview] = useState<OverviewResult | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(ALL_PROJECTS);
  const [primed, setPrimed] = useState(false);

  const load = useCallback(() => {
    Promise.all([rpc.call("overview"), rpc.call("projects_list")]).then(
      ([overviewResult, projectsResult]) => {
        setOverview(overviewResult);
        setProjects(projectsResult.projects);
        setError(null);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);

  useEffect(() => {
    load();
  }, [load]);
  useRealtime("apps-changed", load);

  // Preselect the current thread's project once, when it has a stored app.
  useEffect(() => {
    if (primed || overview === null) return;
    setPrimed(true);
    const here = context.projectId;
    if (here !== null && overview.projectApps.some((app) => app.projectId === here)) {
      setSelected(here);
    }
  }, [context.projectId, overview, primed]);

  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (overview === null || projects === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <DefaultAppCard overview={overview} />
      <ProjectEditor
        projects={projects}
        overview={overview}
        selected={selected}
        onSelect={setSelected}
        onChanged={load}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "project-apps",
    title: "GitHub Apps by project",
    description: "Give one project its own GitHub App, kept on the server.",
    component: SettingsPage,
  });
});
