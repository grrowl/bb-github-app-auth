Authenticate bb agents as a GitHub App instead of a personal account.

For every agent command in a project you list, the plugin mints or reuses a
short-lived GitHub App installation token and injects it as `GH_TOKEN` and
`GITHUB_TOKEN`. `gh` and `git` then act as the app: pull requests, reviews,
comments and pushes are attributed to `<app>[bot]`.

## What it does

- Reads the app id, installation id and private key path from plugin settings
  or from the bb server's `GITHUB_APP_*` environment.
- Scopes injection to the projects you name. Other projects are untouched.
- Re-mints before the one-hour expiry and warms the token for new threads.
- Sets git author and committer to the app's bot user.
- Rewrites GitHub SSH remotes to HTTPS and routes credentials through `gh`,
  so pushes use the token.
- Ships a skill that tells agents how to refresh a token inside a long turn
  with `bb github-app-auth env`.

## Commands

`bb github-app-auth status`, `env`, `token` and `refresh`.

Tokens and the private key are never written to logs.
