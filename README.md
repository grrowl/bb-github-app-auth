# bb-github-app-auth

Are you sick of every pull request landing under YOUR name?

Are you sick of not being able to review them, because GitHub won't let you
approve your own work?

Do you own a software factory, but lately it feels more like an echo chamber?
One account, talking to itself, all day long?

Friend, there is a better way.

With **bb GitHub App Auth**, your agents get a GitHub identity of their very
own. Make a GitHub App in about two minutes, for FREE, with only the scopes
you choose. Install this plugin. That's it! From then on, every agent turn in
the projects you pick runs as the app. Pull requests open under the app's
name. You review them. You approve them. You stay in charge.

Your agents get their own personality. Your agents get only the access you
give them. And you get your name back.

Try bb GitHub App Auth today!

---

## What it does

bb runs coding agents in threads. Each time bb starts, resumes, forks or sends
a turn to an agent in a project you have set up, this plugin hands the agent a
fresh GitHub App installation token. The agent sees it as `GH_TOKEN` and
`GITHUB_TOKEN`, so `gh` and `git` act as the app without any login step.

The plugin also sets the git author and committer to the app's bot user, and
it rewrites `git@github.com:` remotes to HTTPS so pushes use the token
instead of your SSH key. Both of these can be switched off.

A project you have not set up gets nothing. Personal projects stay personal.

## Set up the GitHub App

Do this once on GitHub.

1. Go to Settings, then Developer settings, then GitHub Apps, then New GitHub
   App. An organisation can create the app under the organisation's settings
   instead, so the organisation owns it.
2. Give it a name. Uncheck Webhook. This app needs no webhook.
3. Under Repository permissions, grant only what your agents need. `Contents:
   Read and write` and `Pull requests: Read and write` cover commits and pull
   requests. Add `Issues: Read and write` for issue work. Leave everything else
   at No access.
4. Create the app. On its page, note the App ID.
5. Under Private keys, choose Generate a private key. GitHub downloads a `.pem`
   file. Put it on the machine that runs the bb server and keep it readable
   only by you.
6. Choose Install App, and install it on the account or organisation that owns
   the repositories. Pick the repositories the agents may touch.
7. Open the installation's settings. The URL ends in a number, e.g.
   `.../installations/12345678`. That number is the installation ID.

You now have three values: the app id, the installation id, and the path to
the private key file.

## Give the plugin the app credentials

The plugin holds the credentials on the bb server and never sends them to an
agent. It reads the private key, mints the token, and gives the agent only the
token. Pick one of the ways below.

### One project

This is the way to tie one app to one project. Run this once, from a thread in
the project or with `--project`:

```bash
bb github-app-auth set-app \
  --app-id 123456 \
  --installation-id 98765432 \
  --key-path ~/.config/github-apps/my-app.private-key.pem
```

The plugin stores the credentials in its own server-side storage, keyed to that
project. Only that project has them, and no other project or agent can read
them. A project that has a stored app is enabled on its own, with no list to
keep. Remove it later with `bb github-app-auth unset-app`.

You cannot store the credentials as a project environment variable. bb hides a
project's environment variable values from plugins, so the plugin could not
read them. `set-app` is the project-scoped path that works.

### A default app for several projects

Set one app in plugin settings, then choose which projects use it.

```bash
bb plugin config github-app-auth set appId 123456
bb plugin config github-app-auth set installationId 98765432
bb plugin config github-app-auth set privateKeyPath ~/.config/github-apps/my-app.private-key.pem
bb plugin reload github-app-auth
```

Choose the projects by name or id:

```bash
bb plugin config github-app-auth set projects my-project,another-project
bb plugin reload github-app-auth
```

Or leave the projects setting empty and keep `enableByEnvVar` on, which is the
default. Then any project that defines a `GITHUB_APP_ID` environment variable
gets the default app, and any project that does not is left alone. In Settings,
then Environment variables, pick a project, add a variable named
`GITHUB_APP_ID`, and save. The plugin reads only that the name is set on that
project, never its value, so the value can be a placeholder. Your personal
projects never define it, so they never get a token.

### The bb server launch environment

The default app's credentials can also come from the bb server process's own
environment, which you set by exporting `GITHUB_APP_ID`,
`GITHUB_APP_INSTALLATION_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` in the shell or
launch agent that starts bb. Leave the three plugin settings empty to use this.
Do not set them at the global scope on the Environment variables page, because
bb copies every global value into every agent's environment, and an agent could
then read the private key path and the app id.

The private key is read on the bb server machine. Tokens are minted there and
sent to whichever machine runs the thread, so the key never has to be copied
to other machines.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `appId`, `installationId`, `privateKeyPath` | empty | The default app, used by a project that has no stored app of its own. Read from plugin settings or the bb server environment. |
| `projects` | empty | Comma-separated project names or ids that get the default app. |
| `enableByEnvVar` | true | Also give the default app to any project that defines the enable environment variable. |
| `enableEnvVarName` | GITHUB_APP_ID | The environment variable whose presence on a project enables the default app. |
| `providerIds` | claude-code, codex, pi, acp-cursor, acp-opencode, acp-hermes-agent, acp-amp | Agent providers that get the variables. Reload the plugin after a change. |
| `refreshMarginMinutes` | 10 | Mint a new token when fewer than this many minutes remain. |
| `gitIdentity` | true | Set `GIT_AUTHOR_*` and `GIT_COMMITTER_*` to `<slug>[bot]`. |
| `gitPushAsApp` | true | Rewrite `git@github.com:` remotes to HTTPS and send github.com credentials through `gh auth git-credential`. |

A stored project app takes precedence over the default app for that project.

## Commands

| Command | Effect |
| --- | --- |
| `bb github-app-auth set-app --app-id <id> --installation-id <id> --key-path <path> [--project <id>]` | Store a project's app credentials on the server. |
| `bb github-app-auth unset-app [--project <id>]` | Remove a project's stored app. |
| `bb github-app-auth status [--json]` | Show the default app, each stored project app, token expiry and the bot identity. It never prints a token. |
| `bb github-app-auth env [--project <id>]` | Print `export` lines for `GH_TOKEN` and `GITHUB_TOKEN`. |
| `bb github-app-auth token [--project <id>] [--json]` | Print the current token on its own. |
| `bb github-app-auth refresh [--project <id>] [--json]` | Throw away the cached token and mint a new one. |

`--project` defaults to the current thread's project.

## Token lifetime

An installation token expires one hour after it is minted. The plugin keeps
the token in memory, mints a new one when it is inside the refresh margin,
and keeps any token that was used in the last two hours fresh in the
background. Each agent turn gets the current token, so a new turn never starts
with a stale one.

An agent process that stays alive across turns keeps the environment it
started with. A single turn that runs for more than an hour can outlive its
token. The bundled skill tells agents to run
`eval "$(bb github-app-auth env)"` in the affected shell and try again.

The plugin never writes a token or the private key to its logs. bb itself
records contributed environment values in a thread's `provider.env-resolved`
diagnostics, so treat those like any other log that holds credentials.

## Develop

```bash
npm install
npm run typecheck
bb plugin install .
bb plugin dev
```

## Licence

MIT. See [LICENSE](LICENSE).
