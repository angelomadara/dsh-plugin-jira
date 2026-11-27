# dsh-plugin-jira

**Turn a Jira ticket into a reviewed branch — without leaving DeepSeek Harness.**

Fetch the ticket, branch from your base branch, hand the agent a fix brief, post
the summary back, and open the PR/MR. All from the same chat where you write code.

```text
/jira-do QUBE-212
  → fetch ticket · create branch QUBE-212 · hand the agent a fix brief

… the agent edits, tests, and writes docs/jira/QUBE-212.md …

/jira-comment
  → the agent summarizes the branch and posts it to the ticket

/jira-mr dev staging
  → commit · push · open both merge requests
```

Works with Jira Cloud API tokens and Jira Data Center PATs, GitHub PRs and
GitLab MRs, on `dsh` 0.2.x.

## Why you'll like it

- **The branch starts with context, not a blank prompt.** `/jira-do` fetches the
  summary, description, components, fix versions, environment, parent/subtasks,
  custom fields, the whole comment thread, and downloads the screenshots into
  `docs/jira/<KEY>/`.
- **The agent leaves a paper trail.** Every `/jira-do` asks for a full change
  report at `docs/jira/<KEY>.md` — root cause, files, verification, risks.
- **Comments are two-way.** Post text, drop screenshots in the composer, or let
  the agent read the branch diff and write the summary itself.
- **The PR writes itself.** `/jira-mr` builds the description from the ticket
  link, the report's root cause, and its test plan, then opens one request per
  target.

## Install

From the repo (Desktop **Plugins → install**, or a CLI profile):

```sh
dsh plugin --profile web add github:angelomadara/dsh-plugin-jira
dsh web --dump-config | grep 'id: jira'   # confirm the layer mounted
# restart dsh web
```

Local development:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-plugin-jira
```

Once published on npm, the name alone is enough:

```sh
dsh plugin --profile web add dsh-plugin-jira
```

Remove it from the Plugins page, or `dsh plugin --profile web remove dsh-plugin-jira`.

## Create a Jira API token (2 minutes)

### Jira Cloud

1. Sign in to your Atlassian account.
2. Open **Account Settings → Security → Create and manage API tokens**
   (<https://id.atlassian.com/manage-profile/security/api-tokens>).
3. Click **Create API token**, name it `DSH Jira`, and create it.
4. Copy the token now — Atlassian shows it only once.
5. In DSH open **Settings → Jira** and fill in:
   - **Site URL** — `https://yourorg.atlassian.net`
   - **Email** — the account that owns the token
   - **API token** — the value you copied

   Click **Save**, then **Check connection**.

![DeepSeek Harness Settings → Jira](https://raw.githubusercontent.com/angelomadara/dsh-plugin-jira/main/assets/settings-jira.png)

### Jira Data Center

1. Open your avatar → **Account settings** (or **Profile**) →
   **Personal Access Tokens** → **Create token**.
2. Copy the token.
3. In **Settings → Jira**, set the **Site URL** (include a context path such as
   `https://jira.example.com/jira` if your instance uses one), leave **Email**
   blank, paste the token, then **Save → Check connection**.

The token lives in the DSH credential store, never in this repository or the
settings files. **Check connection** runs `/jira-check` and reports the account
and the projects the token can see.

## Your first run

```text
/jira-check
  Signed in as Angelo Madara <you@company.com> (712020:…).
  Visible projects (7): QUBE — QUBE, QBE — PANDORA, …

/jira-find project = QUBE AND statusCategory != Done ORDER BY updated DESC
  20 issue(s) for: project = QUBE …
  QUBE-114 [QA] Assign Riders to Merchants — Alvin
  …

/jira-do QUBE-212
  QUBE-212 — Rider time is wrong
  checked out dev · pulled dev · created branch QUBE-212
  Handed to the agent.
```

The agent now has a fix brief: root cause before symptom, smallest change,
run the tests, write `docs/jira/QUBE-212.md`, do **not** commit or push.

## The daily loop

| Step | Command | What happens |
|---|---|---|
| Find work | `/jira-find [JQL]` | No JQL = your open issues. |
| Start | `/jira-do QUBE-212` | Fetch, branch, attachments, agent hand-off. |
| Report progress | `/jira-comment QUBE-212 Fixed the rounding` | Posts directly. |
| Show a screenshot | attach an image + `/jira-comment` | Uploaded and embedded in the comment. |
| Summarize the branch | `/jira-comment` (no text) | The agent reads the diff and posts the summary. |
| Open the request | `/jira-mr dev staging main` | One commit + push, one PR/MR per target. |
| Move the ticket | `/jira-transition QUBE-212 "In Review"` | Lists transitions if no status is given. |

## Commands

| Command | Purpose |
|---|---|
| `/jira-do KEY` | Fetch the ticket, prepare the branch, hand it to the agent. |
| `/jira-check` | Show the token's account and visible projects; explain a 401. |
| `/jira-find [JQL]` | JQL search; no input lists your open issues. |
| `/jira-transition KEY [status]` | List transitions, or apply the matching one. |
| `/jira-comment [KEY] [text]` | Comment; screenshots allowed; no text = agent summary. |
| `/jira-mr [target...]` | GitLab MR(s) from the ticket branch; defaults to the base branch. |
| `/jira-pr [target...]` | GitHub PR(s) — same behavior, picked from `origin`. |

## Tools for the agent

| Tool | Purpose |
|---|---|
| `jira_ticket` | Read one issue (description, comments, components, attachments…). |
| `jira_search` | JQL search, up to 50 results. |
| `jira_transition` | List or apply workflow transitions. |
| `jira_comment` | Post a comment, with optional local image paths. |

## The change report

`/jira-do` asks the agent to write `docs/jira/<KEY>.md` before it finishes:

- ticket key, summary, Jira URL
- severity/impact and root cause
- every file changed and why
- verification commands and results
- risks, follow-ups, out-of-scope items

`/jira-mr` and `/jira-pr` read that report, put the **root cause** and **test
plan** in the description, and keep the full report in a collapsible block.
Commit the report with the branch — the request commands commit the whole
working tree (`git add -A`, gitignored files excluded) before pushing.

## Configuration

Optional `.dsh-jira.json` at the repository root:

```json
{
  "base": "develop",
  "branch": "feature/{key}-{slug}",
  "worktree": false,
  "allowDirty": false,
  "downloadAttachments": true,
  "provider": "gitlab",
  "fields": {
    "acceptanceCriteria": "customfield_10001",
    "storyPoints": "customfield_10002",
    "severity": "customfield_10003",
    "epic": "customfield_10014"
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `base` | `dev` | Branch to branch from. |
| `branch` | `{key}` | Template with `{key}` and `{slug}`. |
| `worktree` | `false` | Use `.dsh-jira-worktrees/<branch>` instead of switching checkout. |
| `allowDirty` | `false` | Allow switching with tracked changes. |
| `downloadAttachments` | `true` | Download attachments into `docs/jira/<KEY>/` (10 MB/file). |
| `provider` | auto | `github` or `gitlab` when the host name doesn't say. |
| `fields` | `{}` | Friendly label → Jira custom field id. |

## Credentials

The Settings page writes three credential references: `JIRA_SITE`,
`JIRA_EMAIL`, `JIRA_API_TOKEN`. Environment variables with the same names also
resolve, so CI/headless can skip the page.

- `JIRA_EMAIL` + `JIRA_API_TOKEN` → `Basic` auth (Jira Cloud API token).
- `JIRA_EMAIL` blank → `JIRA_API_TOKEN` as `Bearer` (Data Center PAT), unless it
  already starts with `Basic `.
- The site URL must be `https` (plain `http` only for localhost).

For `/jira-mr`, GitLab auth comes from `GITLAB_TOKEN` (credential store or
environment) or the git credential helper for that host. `/jira-pr` uses the
authenticated `gh` CLI.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Jira rejected the credentials (401)` | Email must own the Cloud token; Data Center uses a blank email + PAT. Try **Check connection**. |
| `Jira 404 for KEY` | The issue is missing **or** the token cannot see it; 404 hides both. Check the project permissions. |
| `/jira-mr` cannot tell the provider | Set `"provider": "github"` or `"gitlab"` in `.dsh-jira.json`. |
| GitLab 401 | Set `GITLAB_TOKEN`, or store git credentials for that host. |
| GitHub prompt/failure | `gh auth status`; the active account needs push access. |
| Comment images fail | The image exceeds 10 MB or the issue rejects the media; falls back to a link on Data Center. |

## What's inside

```text
index.js            host entry: apply() wires the modules
lib/config.js       credentials, auth header, rejected-credential hint
lib/requests.js     GitHub PR / GitLab MR from the change report
lib/repo.js         .dsh-jira.json: base, branch, worktree, fields
lib/attachments.js  download/upload attachments; composer images → comment media
lib/adf.js          Markdown → Atlassian Document Format
lib/jira.js         REST v3: issues, comments, search, transitions, rich rendering
lib/git.js          branch/worktree prep, dirty guard, diff and status
lib/prompts.js      agent hand-off prompts
lib/commands.js     the slash commands
lib/tools.js        the model tools
client.js           Settings → Jira page (browser half)
test.js             offline self-check
```

## Development

```sh
node test.js   # offline: branch prep, hand-off, tools, comments, client registration
```

No runtime dependencies — Node built-ins and `fetch` only.

## License

MIT
