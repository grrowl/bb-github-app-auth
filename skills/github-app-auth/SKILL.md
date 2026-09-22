---
name: github-app-auth
description: Use when GitHub CLI or git returns 401 or "Bad credentials" in a project that authenticates as a GitHub App, or when you need to know which identity GH_TOKEN carries. Covers the `bb github-app-auth` command.
---

# GitHub App token

In projects the GitHub App Auth plugin is configured for, each agent turn
starts with these variables set by the plugin:

| Variable | Content |
| --- | --- |
| `GH_TOKEN`, `GITHUB_TOKEN` | A GitHub App installation token (`ghs_...`). It expires about one hour after it was minted. |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_SLUG` | The app behind the token. The bot login is `<slug>[bot]`. |
| `GIT_AUTHOR_*`, `GIT_COMMITTER_*` | The app's bot user, so commits belong to the app. |
| `GIT_CONFIG_*` | Rewrites `git@github.com:` remotes to HTTPS and routes github.com credentials through `gh`, so pushes use the token. |

`gh` and `git push` need no login. Do not run `gh auth login` and do not
change `GH_TOKEN` by hand.

## Recovery after a 401

The token is refreshed at the start of every turn. A turn that runs for more
than about an hour can outlive its token. When `gh` or `git push` reports 401,
"Bad credentials", or an authentication failure, refresh the shell you are in:

```bash
eval "$(bb github-app-auth env)"
```

Then retry the command. Run the refresh in the same shell as the retry; a
separate command invocation does not keep the exported value.

## Commands

| Command | Effect |
| --- | --- |
| `bb github-app-auth status [--json]` | Configuration, enabled projects, token expiry, app identity. Never prints a token. |
| `bb github-app-auth env [--project <id>]` | `export` lines for `GH_TOKEN` and `GITHUB_TOKEN`. |
| `bb github-app-auth token [--project <id>] [--json]` | The current token on its own. |
| `bb github-app-auth refresh [--json]` | Discard the cached token and mint a new one. |

`--project` defaults to the current thread's project. A project that is not
in the plugin's projects setting gets `project_not_enabled`.

## Rules

- Never paste a token into a message, a file, a commit, or a log.
- A `project_not_enabled` error is a configuration decision, not a fault. Tell
  the user; do not work around it with a personal credential.
