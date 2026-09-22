# bb-github-app-auth

A [bb](https://getbb.app) plugin that authenticates agents as a GitHub App.

For each agent command (start, resume, fork, turn) in a configured project, it
mints or reuses a GitHub App installation token and contributes it to the
agent's environment as `GH_TOKEN` and `GITHUB_TOKEN`. `gh` and git then act as
the app. Personal projects and projects not listed get nothing.

## Prerequisites

- A GitHub App installed on the organisation or account that owns the
  repositories. It needs at least `contents: write` and
  `pull_requests: write`; add `issues: write` for issue work.
- The app's private key PEM file on the bb server machine.
- The app id (Settings → Developer settings → GitHub Apps) and the
  installation id (the number at the end of the installation's settings URL).
- `gh` on the PATH of the machines that run threads.

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

The private key path is read on the bb server machine. Tokens are minted on
the server and sent to whichever host runs the thread, so the key does not
need to exist on enrolled machines.

When `appId`, `installationId` or `privateKeyPath` is empty, the plugin reads
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` and
`GITHUB_APP_PRIVATE_KEY_PATH` from the bb server's own environment.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `appId`, `installationId`, `privateKeyPath` | empty | The GitHub App. All three are required. |
| `projects` | empty | Comma-separated project names or ids that receive the token. Empty means no project. |
| `providerIds` | claude-code, codex, pi, acp-cursor, acp-opencode, acp-hermes-agent, acp-amp | Providers whose commands receive the variables. Reload after a change. |
| `refreshMarginMinutes` | 10 | Re-mint when fewer than this many minutes remain. |
| `gitIdentity` | true | Set `GIT_AUTHOR_*` and `GIT_COMMITTER_*` to `<slug>[bot]`. |
| `gitPushAsApp` | true | Rewrite `git@github.com:` remotes to HTTPS and route github.com credentials through `gh auth git-credential`. |

## Token lifetime

Installation tokens expire one hour after they are minted. The plugin caches
the token in memory, re-mints when it is inside the refresh margin, and keeps
a token that was used in the last two hours warm in the background. Every
agent command gets the current token, so a new turn never starts with a
stale one.

A provider process that stays alive across turns keeps its launch
environment. A single turn longer than about an hour can outlive its token.
The bundled skill tells agents to run `eval "$(bb github-app-auth env)"` in
the affected shell and retry.

Tokens and the private key are never logged. `bb github-app-auth status`
prints expiry and identity only. bb records contributed values in the
thread's `provider.env-resolved` diagnostics; treat those like any other
credential-bearing log.

## Develop

```bash
npm install
npm run typecheck
bb plugin install .
bb plugin dev
```

## Licence

MIT. See [LICENSE](LICENSE).
