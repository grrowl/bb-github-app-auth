// bb-plugin-github-app-auth — settings page.
//
// Rendered below the host's own settings form on the plugin's settings page.
// The form above edits the default app (all projects). This section has one
// project dropdown: "All projects (defaults)" shows the default app read-only,
// and a specific project stores its own GitHub App, the way bb's own
// Environment variables page scopes values.
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
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={disabled}
        className={cn(mono && "font-mono")}
      />
    </label>
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
  const isDefaults = selected === ALL_PROJECTS;
  const current = isDefaults ? undefined : stored.get(selected);
  const defaultApp = overview.defaultApp;
  // The values shown in the fields: the default app when "All projects
  // (defaults)" is selected, otherwise the selected project's stored app.
  const source = isDefaults ? defaultApp : current;

  const [appId, setAppId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [busy, setBusy] = useState(false);

  // Reload the form when the selection or the values it shows change.
  useEffect(() => {
    setAppId(source?.appId ?? "");
    setInstallationId(source?.installationId ?? "");
    setKeyPath(source?.privateKeyPath ?? "");
  }, [source?.appId, source?.installationId, source?.privateKeyPath, selected]);

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
      <h3 className="text-sm font-semibold text-foreground">GitHub Apps by project</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Set a GitHub App for one project. It stays on the server.
      </p>

      <label className="mt-3 flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">Project</span>
        <select
          value={selected}
          onChange={(event) => onSelect(event.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value={ALL_PROJECTS}>All projects (defaults)</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
              {stored.has(project.id) ? "  • has app" : ""}
            </option>
          ))}
        </select>
      </label>

      <form onSubmit={save} className="mt-4 flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {isDefaults
            ? defaultApp === null
              ? "No default app is set. Add one in the settings above."
              : "The default app is set in the settings above."
            : stored.has(selected)
              ? `Editing the app stored for ${nameFor(selected)}.`
              : `No app stored for ${nameFor(selected)} yet.`}
        </p>
        <Field
          label="App ID"
          value={appId}
          onChange={setAppId}
          placeholder="123456"
          mono
          disabled={isDefaults}
        />
        <Field
          label="Installation ID"
          value={installationId}
          onChange={setInstallationId}
          placeholder="98765432"
          mono
          disabled={isDefaults}
        />
        <Field
          label="Private key path"
          value={keyPath}
          onChange={setKeyPath}
          placeholder="~/.config/github-apps/my-app.private-key.pem"
          mono
          disabled={isDefaults}
        />
        {source?.token ? (
          <p className="text-xs text-muted-foreground">{tokenLine(source.token)}</p>
        ) : null}
        {isDefaults ? null : (
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
        )}
      </form>
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
    description: "Set a GitHub App for one project. It stays on the server.",
    component: SettingsPage,
  });
});
