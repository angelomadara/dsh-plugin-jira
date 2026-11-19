/** Agent hand-off prompts for /jira-do and /jira-comment. */
import { renderIssue } from './jira.js'

const MAX_SUMMARY_DIFF = 60000

/** Hand-off prompt for a comment the agent has to write from the branch's changes. */
export function summarizePrompt(key, changes) {
  // ponytail: 60k cap keeps one prompt bounded; the agent can run git itself for the rest.
  const diff = changes.diff.length > MAX_SUMMARY_DIFF
    ? `${changes.diff.slice(0, MAX_SUMMARY_DIFF)}\n… truncated at ${MAX_SUMMARY_DIFF} chars; run git diff for the rest.`
    : changes.diff
  const lines = [
    `Jira ${key}: the user ran /jira-comment without comment text.`,
    '',
    `Analyze ALL the file changes on branch ${key} (base ${changes.base}) — committed and uncommitted — and post ONE concise comment to the ticket.`,
    'Do not change code, commit, or push.',
    `Post the comment with the jira_comment tool, key "${key}".`,
    '',
  ]
  if (changes.status) lines.push(`Working tree status:\n${changes.status}`, '')
  lines.push('Changes:', '```diff', diff, '```')
  return lines.join('\n')
}

export function taskPrompt(key, issue, site) {
  return [
    `Jira ${key} is checked out on branch ${key} (based on dev).`,
    '',
    renderIssue(issue),
    '',
    'Fix this like any other ticket in this repo:',
    '1. Read the code the ticket points at and name the root cause, not the symptom.',
    '2. Make the smallest change that fixes it, following the patterns already in the repo.',
    '3. Run the tests that cover the change and record the exact commands and results.',
    `4. When the work is done, write the full change report to docs/jira/${key}.md at the repository root (create docs/jira if missing). It must contain:`,
    `   - ticket: ${key}, its summary, and the Jira URL ${site}/browse/${key}`,
    '   - severity/impact and the root cause',
    '   - every file changed, what changed, and why',
    '   - verification: the exact commands run and their results',
    '   - risks, follow-ups, and anything deliberately left out of scope',
    `5. The report is part of the deliverable: docs/jira/${key}.md must exist and be complete before you finish.`,
    '6. Do not commit or push; leave the diff for review.',
  ].join('\n')
}
