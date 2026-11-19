# dsh-plugin-jira

Jira ticket intake for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), built against dsh 0.2.x.

- **Settings → Jira** — store the site URL, email and API token in the DSH credential store.
- **`/jira-do TCKT-123`** — fetches the issue, checks out `dev`, pulls, creates branch `TCKT-123`, then hands it to the agent with a fix brief (root cause, minimal change, tests, a full change report at `docs/jira/TCKT-123.md`, no commit).
- **`/jira-comment [TCKT-123] text`** — posts a comment; the key is taken from the current branch when the branch is a ticket key, so `/jira-comment Fixed in this branch` is enough. **Omit the text** (e.g. `/jira-comment` on `TCKT-123`) and the agent analyzes all the branch's changes — committed since `dev`/`main`/`master` plus the working tree — and writes the comment itself.
- **`jira_ticket` tool** — fetch one issue (summary, description, status, labels, last 20 comments) without touching git.
- **`jira_comment` tool** — post a comment (progress, findings, completion) on one issue.

```
package.json      dsh.bundle.patch + dsh.client (platform: web); exports "." and "./client"
cordis.patch.yml  insert row  id: jira → dsh-plugin-jira
index.js          host half: commands + tools + git + Jira REST (no @deepseek-ai/* imports)
client.js         browser half: the settings page, in window.__ModuleLoader__ format
test.js           offline self-check: branch prep, hand-off, tools, comments, client registration
```

## Install

Published package:

```sh
dsh plugin --profile web add dsh-plugin-jira
dsh web --dump-config | grep 'id: jira'   # confirm the layer mounted
# restart dsh web
```

From the repo (also what the Desktop **Plugins → install** dialog takes):

```sh
dsh plugin --profile web add github:angelomadara/dsh-plugin-jira
```

Local development:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-plugin-jira
```

Then open **Settings → Jira** and store the site URL, email and API token. Remove it from the Plugins page, or `dsh plugin --profile web remove dsh-plugin-jira` and delete the `jira` row from the profile's `cordis.patch.yml`.

## Credentials

The page writes three credential references: `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN`. Env vars of the same names also resolve, so CI/headless can skip the page.

- `JIRA_EMAIL` + `JIRA_API_TOKEN` → encoded into `Basic` auth (Jira Cloud API token).
- `JIRA_EMAIL` blank → `JIRA_API_TOKEN` is sent as `Bearer` (Jira Data Center PAT), unless it already starts with `Basic `.

The site URL must be `https` (plain `http` is allowed only for localhost), so the token never travels in cleartext.

## Check

```sh
node test.js   # ok — command, branch, hand-off, tools, comments, client registration
```

Notes: after the fix, the agent must write the full change report to `docs/jira/<KEY>.md` — ticket URL and summary, severity/impact, root cause, every changed file and why, verification commands and results, risks and follow-ups — and treat it as part of the deliverable. Comments are posted as Atlassian Document Format (REST v3), blank lines become paragraphs and single newlines become hard breaks. `/jira-comment` without text hands the ticket branch's diff and `git status` to the agent (60k-char diff cap; the agent can run git for the rest) and asks it to post one summary comment. `/jira-do` fetches the ticket **before** touching git, so an unknown or unreachable key never leaves a new branch behind. Branch prep is `checkout dev` → `pull --ff-only` → `checkout -b <KEY>` (an existing branch is reused); a failed pull is reported in the command reply, not fatal. The agent is instructed not to commit or push.

## License

MIT
