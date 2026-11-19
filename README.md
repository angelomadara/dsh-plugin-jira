# dsh-plugin-jira

Jira ticket intake for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), built against dsh 0.2.x.

- **Settings → Jira** — store the site URL, email and API token; its **Check connection** button runs `/jira-check` in the current session.
- **`/jira-do TCKT-123`** — fetches the issue, checks out the base branch (`dev`, or `base` from `.dsh-jira.json`), pulls, creates branch `TCKT-123`, then hands it to the agent with a fix brief (root cause, minimal change, tests, a full change report at `docs/jira/TCKT-123.md`, no commit).
- **`/jira-check`** — shows which account the token authenticates as and which projects it can see; a 401 is reported with the exact fix.
- **`/jira-find [JQL]`** — searches Jira; with no input it lists your open issues.
- **`/jira-transition TCKT-123 [status]`** — lists the allowed transitions, or moves the ticket to the matching transition/destination status.
- **`/jira-comment [TCKT-123] text`** — posts a comment; the key is taken from the current branch when the branch is a ticket key, so `/jira-comment Fixed in this branch` is enough. **Omit the text** (e.g. `/jira-comment` on `TCKT-123`) and the agent analyzes all the branch's changes — committed since `dev`/`main`/`master` plus the working tree — and writes the comment itself.
- **`jira_ticket` tool** — fetch one issue (summary, description, status, labels, last 20 comments) without touching git.
- **`jira_search` tool** — JQL search (max 50), read-only.
- **`jira_transition` tool** — list or apply workflow transitions; writes to Jira.
- **`jira_comment` tool** — post a comment (progress, findings, completion) on one issue.

```
package.json      dsh.bundle.patch + dsh.client (platform: web); exports "." and "./client"
cordis.patch.yml  insert row  id: jira → dsh-plugin-jira
index.js          host entry: apply() wires the modules below
lib/config.js     credential refs, auth header, rejected-credential hint
lib/adf.js        Markdown → Atlassian Document Format
lib/jira.js       REST v3 (issues, comments, search, transitions), rendering, /jira-check
lib/git.js        branch prep, branch diff and status
lib/prompts.js    agent hand-off prompts
lib/commands.js   /jira-do, /jira-check, /jira-find, /jira-transition, /jira-comment
lib/tools.js      jira_ticket, jira_search, jira_transition, jira_comment
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

Notes: after the fix, the agent must write the full change report to `docs/jira/<KEY>.md` — ticket URL and summary, severity/impact, root cause, every changed file and why, verification commands and results, risks and follow-ups — and treat it as part of the deliverable. Comments are posted as Atlassian Document Format (REST v3): blank lines become paragraphs, single newlines hard breaks, and `**bold**`, `*italic*`, `` `code` ``, `[links](url)`, `-`/`1.` lists and fenced code blocks are converted; the last 20 comments are fetched by position rather than trusting the issue field. `/jira-comment` without text hands the ticket branch's diff and `git status` to the agent (60k-char diff cap; the agent can run git for the rest) and asks it to post one summary comment. `/jira-do` fetches the ticket **before** touching git, so an unknown or unreachable key never leaves a new branch behind. Branch prep is `checkout <base>` → `pull --ff-only` → `checkout -b <KEY>` (base defaults to `dev`; set `{ "base": "develop" }` in `.dsh-jira.json` at the repo root to override; an existing branch is reused); a failed pull is reported in the command reply, not fatal. The agent is instructed not to commit or push.

## License

MIT
