# dsh-plugin-jira

Jira ticket intake for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

- **Settings → Built-in plugins → Jira** — a page to store the site URL, email and API token in the DSH credential store.
- **`/jira-do TCKT-123`** — checks out `dev`, pulls, creates branch `TCKT-123`, fetches the issue, then hands it to the agent with a fix brief (root cause, minimal change, `docs/jira/TCKT-123.md`, run tests, no commit).
- **`jira_ticket` tool** — fetch one issue (summary, description, status, labels, last 20 comments) without touching git.

```
package.json      dsh.bundle.patch + dsh.client (platform: web); exports "." and "./client"
cordis.patch.yml  insert row  id: jira → dsh-plugin-jira
index.js          host half: command + tool + git + Jira REST (no @deepseek-ai/* imports)
client.js         browser half: the settings page, in window.__ModuleLoader__ format
test.js           offline self-check: branch prep, hand-off message, tool
```

## Install

```sh
dsh plugin --profile web add github:angelomadara/dsh-plugin-jira
dsh web --dump-config | grep 'id: jira'   # confirm the layer mounted
# restart dsh web
```

Local development:

```sh
dsh plugin --profile web add link:/abs/path/to/dsh-plugin-jira
```

Remove: `dsh plugin --profile web remove dsh-plugin-jira`, then delete the `jira` row from the profile's `cordis.patch.yml`.

## Credentials

The page writes three credential references: `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN`.

- `JIRA_EMAIL` + `JIRA_API_TOKEN` → encoded into `Basic` auth.
- `JIRA_EMAIL` blank → `JIRA_API_TOKEN` is used as an already encoded Basic value (paste a blob from an existing script).

Env vars of the same names also resolve, so CI/headless can skip the page.

## Check

```sh
node test.js   # ok — command, branch, hand-off, tool
```

Notes: branch prep is `checkout dev` → `pull --ff-only` → `checkout -b <KEY>` (an existing branch is reused). A failed pull is reported in the command reply, not fatal. The agent is instructed not to commit or push.

## License

MIT
