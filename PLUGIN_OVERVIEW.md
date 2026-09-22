Are you sick of every pull request landing under YOUR name? Sick of not being
able to review them, because GitHub won't let you approve your own work? Does
your software factory feel more like an echo chamber?

With bb GitHub App Auth, your agents get a GitHub identity of their own. Make
a GitHub App for free with only the scopes you choose, install this plugin,
and every agent turn in the projects you pick runs as the app. Pull requests
open under the app's name. You review them. You stay in charge.

## What it does

- Mints a short-lived GitHub App installation token for each agent turn and
  sets it as `GH_TOKEN` and `GITHUB_TOKEN`.
- Only touches the projects you list. Personal projects stay personal.
- Mints a new token before the one-hour expiry, and keeps a token warm for
  new threads.
- Sets the git author and committer to the app's bot user, so commits are
  the app's too.
- Rewrites GitHub SSH remotes to HTTPS and sends credentials through `gh`,
  so pushes use the token and not your SSH key.
- Ships a skill that tells agents how to refresh a token inside a long turn.

## Commands

`bb github-app-auth status`, `env`, `token` and `refresh`.

The plugin never writes a token or the private key to its logs.

Try bb GitHub App Auth today!
