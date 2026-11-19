# dsh-plugin-jira

Jira ticket intake for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), built against dsh 0.2.x.

- **Settings → Built-in plugins → Jira** — store the site URL, email and API token in the DSH credential store.
- **`/jira-do TCKT-123`** — fetches the issue, checks out `dev`, pulls, creates branch `TCKT-123`, then hands it to the agent with a fix brief (root cause, minimal change, `docs/jira/TCKT-123.md`, run tests, no commit).
- **`jira_ticket` tool** — fetch one issue (summary, description, status, labels, last 20 comments) without touching git.

```
package.json      dsh.bundle.patch + dsh.client (platform: web); exports "." and "./client"
cordis.patch.yml  insert row  id: jira → dsh-plugin-jira
index.js          host half: command + tool + git + Jira REST (no @deepseek-ai/* imports)
client.js         browser half: the settings page, in window.__ModuleLoader__ format
test.js           offline self-check: branch prep, hand-off, tool, client registration
```

## Install

In the desktop app: **Plugins → install**, using `link:/absolute/path/to/dsh-plugin-jira` while developing. With a CLI profile:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-plugin-jira
dsh web --dump-config | grep 'id: jira'   # confirm the layer mounted
# restart dsh web
```

Publishing as a repo bundle works too:

```sh
dsh plugin --profile web add github:angelomadara/dsh-plugin-jira
```

Remove it from the Plugins page, or `dsh plugin --profile web remove dsh-plugin-jira` and delete the `jira` row from the profile's `cordis.patch.yml`.

## Credentials

The page writes three credential references: `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN`. Env vars of the same names also resolve, so CI/headless can skip the page.

- `JIRA_EMAIL` + `JIRA_API_TOKEN` → encoded into `Basic` auth (Jira Cloud API token).
- `JIRA_EMAIL` blank → `JIRA_API_TOKEN` is sent as `Bearer` (Jira Data Center PAT), unless it already starts with `Basic `.

The site URL must be `https` (plain `http` is allowed only for localhost), so the token never travels in cleartext.

## Check

```sh
node test.js   # ok — command, branch, hand-off, tool, client registration
```

Notes: `/jira-do` fetches the ticket **before** touching git, so an unknown or unreachable key never leaves a new branch behind. Branch prep is `checkout dev` → `pull --ff-only` → `checkout -b <KEY>` (an existing branch is reused); a failed pull is reported in the command reply, not fatal. The agent is instructed not to commit or push.

## License

MIT
