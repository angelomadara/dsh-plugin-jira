# TODO

Future work for `dsh-plugin-jira`. Current surface: **Settings → Jira**, `/jira-do`, `/jira-comment`, and the `jira_ticket` / `jira_comment` tools.

Conventions: no runtime dependencies (Node built-ins + `fetch`), keep `client.js` hand-written, never write tokens into commands/docs/logs, and never commit or push from a command.

## P1 — close the obvious gaps

- [ ] `/jira-check`: `GET /rest/api/3/myself`, print the authenticated account and whether a sample project is visible; turn a 401 into one clear fix.
- [ ] `jira_search` tool + `/jira-find`: JQL, assignee/status filters, a compact key/summary/status list.
- [ ] `jira_transition` tool + `/jira-transition KEY <status>`: list allowed transitions first, apply by name, never guess.
- [ ] Markdown → ADF comments: bullets, numbered lists, code blocks, inline code, links, mentions (today: paragraphs + hard breaks only).
- [ ] Comment pagination: read `/issue/KEY/comment?startAt=…` so "last 20" really is the latest 20.
- [ ] Configurable base branch (Settings or a repo `.dsh-jira.json`, default `dev`) used by `/jira-do` and the summary diff.
- [ ] Settings page "Check connection" (needs a small host remote route) that shows who the token resolves to.

## P2 — richer ticket intake

- [ ] Custom fields in the brief: acceptance criteria, story points, severity, environment, components, fix versions (field IDs configurable).
- [ ] Epic/parent/subtasks context and the full comment thread.
- [ ] Attachments: list them, download description images/files into `docs/jira/<KEY>/` for the agent.
- [ ] Issue-type briefs: bug (repro + root cause), story (acceptance criteria), spike (questions/outcome).
- [ ] Branch naming template (`{key}`, `{key}-{slug}`, optional `feature/`) with collision checks.
- [ ] Idempotent `/jira-do`: reuse an existing branch and report work in progress instead of re-branching.
- [ ] Worktree mode: create a dedicated git worktree instead of switching the current checkout.
- [ ] Dirty-tree guard: warn/refuse when uncommitted work would cross the branch switch.

## P3 — write-back workflows

- [ ] `/jira-closeout`: summarize the branch, refresh `docs/jira/<KEY>.md`, post the comment, and optionally transition to In Review — one explicit command.
- [ ] `jira_worklog` tool: log time with a comment.
- [ ] `jira_assign` tool: assign to self / an account id.
- [ ] `jira_link` tool: remote link to the branch, PR or commit URL.
- [ ] `jira_create` tool: create an issue/subtask from a title/description template.
- [ ] Attach files to an issue (`POST /rest/api/3/issue/<KEY>/attachments`).
- [ ] Update labels/priority/due date/sprint with a confirmation step.

## P4 — auth, settings, reliability

- [ ] Multiple Jira sites/profiles: per-workspace named credential sets, not one global `JIRA_*`.
- [ ] Explicit token type (Cloud API token vs Data Center PAT) instead of inferring from a blank email.
- [ ] OAuth 2.0 (3LO) option for orgs that disallow API tokens.
- [ ] Clear a single credential from the page (`credentials.unset`).
- [ ] Show where each credential came from (store vs environment).
- [ ] Retry with backoff on 429/5xx, honor `Retry-After`, add request timeouts via `AbortSignal`.
- [ ] Jira Data Center fallback: try `/rest/api/3`, fall back to `/rest/api/2` (plain-text descriptions).
- [ ] URL normalization: accept a context path (`https://host/jira`), strip UI paths and trailing slashes.
- [ ] Clear, actionable errors for 401 vs 403 vs 404 vs rate limit (partly done via the `/myself` probe).

## P5 — polish and packaging

- [ ] Market card assets: an icon and `screenshots.json` (Settings → Jira, a `/jira-do` run).
- [ ] npm publish (needs `--otp` or a granular token with bypass 2FA) and verify `repository` linking.
- [ ] GitHub Actions: `node test.js`, `npm publish --dry-run`, publish on tag.
- [ ] Integration tests against a local fake Jira HTTP server: 200/401/404/429, ADF payloads, comment pagination.
- [ ] `CHANGELOG.md`, release tags, version bumps.
- [ ] README screenshots and troubleshooting (401 vs 404, Cloud vs DC token, org API-token policy).
- [ ] Localize the Settings page and command copy.
- [ ] Accessibility: `aria-live` save/status text, focus states, error association.
- [ ] Document credential rotation and the store locations (Desktop vs CLI profile).

## Parked — not now

- [ ] Jira Service Management request types / portal.
- [ ] Jira Align / Advanced Roadmaps.
- [ ] Jira webhooks or event-driven updates.
- [ ] Offline issue cache.
