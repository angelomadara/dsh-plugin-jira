/**
 * Jira plugin, host half.
 *
 * - `/jira-do KEY` — fetch the issue, branch it from dev, hand it to the agent.
 * - `/jira-check` — who the token authenticates as and which projects it can see.
 * - `/jira-comment [KEY] [text]` — post a comment, or let the agent summarize the branch.
 * - `jira_ticket` / `jira_comment` tools.
 *
 * Credentials `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN` are resolved per call and written by the browser half.
 */
import { registerCommands } from './lib/commands.js'
import { registerTools } from './lib/tools.js'

export const name = 'jira'
export const inject = ['commands', 'tools', 'credentials']

/** Register the Jira commands and tools. */
export function apply(ctx) {
  registerCommands(ctx)
  registerTools(ctx)
}
