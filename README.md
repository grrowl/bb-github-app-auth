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
a turn to an agent in a project you have listed, this plugin hands the agent a
fresh GitHub App installation token. The agent sees it as `GH_TOKEN` and
`GITHUB_TOKEN`, so `gh` and `git` act as the app without any login step.

The plugin also sets the git author and committer to the app's bot user, and
it rewrites `git@github.com:` remotes to HTTPS so pushes use the token
instead of your SSH key. Both of these can be switched off.

Projects you do not list get nothing. Personal projects stay personal.

## Prerequisites

- A GitHub App installed on the organisation or account that owns the
  repositories. Give it `contents: write` and `pull_requests: write`, and add
  `issues: write` if the agents will work on issues.
- The app's private key PEM file on the machine that runs the bb server.
- The app id and the installation id. The app id is on the app's settings
  page. The installation id is the number at the end of the installation's
  settings URL.
- `gh` on the PATH of every machine that runs threads.

## Configure

```bash
bb plugin install https://github.com/grrowl/bb-github-app-auth
bb plugin config github-app-auth set appId 123456
bb plugin config github-app-auth set installationId 98765432
bb plugin config github-app-auth set privateKeyPath ~/.config/github-apps/my-app.private-key.pem
bb plugin config github-app-auth set projects my-project
bb plugin reload github-app-auth
bb github-app-auth status
```

The private key is read on the bb server machine. Tokens are minted there and
sent to whichever machine runs the thread, so the key never has to be copied
to other machines.

If `appId`, `installationId` or `privateKeyPath` is left empty, the plugin
reads `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` and
`GITHUB_APP_PRIVATE_KEY_PATH` from the bb server's own environment instead.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `appId`, `installationId`, `privateKeyPath` | empty | The GitHub App. All three are needed. |
| `projects` | empty | Comma-separated project names or ids that get the token. Empty means no project. |
| `providerIds` | claude-code, codex, pi, acp-cursor, acp-opencode, acp-hermes-agent, acp-amp | Agent providers that get the variables. Reload the plugin after a change. |
| `refreshMarginMinutes` | 10 | Mint a new token when fewer than this many minutes remain. |
| `gitIdentity` | true | Set `GIT_AUTHOR_*` and `GIT_COMMITTER_*` to `<slug>[bot]`. |
| `gitPushAsApp` | true | Rewrite `git@github.com:` remotes to HTTPS and send github.com credentials through `gh auth git-credential`. |

## Commands

| Command | Effect |
| --- | --- |
| `bb github-app-auth status [--json]` | Show the configuration, the enabled projects, when the token expires and which bot the app is. It never prints the token. |
| `bb github-app-auth env [--project <id>]` | Print `export` lines for `GH_TOKEN` and `GITHUB_TOKEN`. |
| `bb github-app-auth token [--project <id>] [--json]` | Print the current token on its own. |
| `bb github-app-auth refresh [--json]` | Throw away the cached token and mint a new one. |

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
