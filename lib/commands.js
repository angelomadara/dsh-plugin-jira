/** The three slash commands: /jira-do, /jira-check, /jira-comment. */
import { randomUUID } from 'node:crypto'
import { readConfig } from './config.js'
import { checkAccess, fetchIssue, KEY_RE, listTransitions, postComment, renderSearch, renderTransitions, searchIssues, transitionIssue } from './jira.js'
import { baseBranch, branchChanges, git, gitError, prepareBranch } from './git.js'
import { summarizePrompt, taskPrompt } from './prompts.js'

/** Register the Jira commands on the plugin context. */
export function registerCommands(ctx) {
  ctx.commands.register({
    name: 'jira-do',
    description: 'Fetch a Jira ticket: checkout dev, pull, branch the ticket key, then hand it to the agent to fix.',
    input: { hint: 'TCKT-123' },
    async handler(invocation) {
      const key = invocation.rawInput.trim().toUpperCase()
      if (!KEY_RE.test(key)) return { kind: 'error', text: 'Usage: /jira-do TCKT-123' }
      const cwd = invocation.agent.session.header?.cwd
      if (!cwd) return { kind: 'error', text: 'Jira: this session has no working directory.' }

      let log
      try {
        const config = await readConfig(ctx)
        let issue
        try {
          issue = await fetchIssue(config, key)
        } catch (error) {
          return { kind: 'error', text: `Jira fetch failed: ${error?.message ?? error}` }
        }
        const base = baseBranch(cwd)
        log = prepareBranch(cwd, key, base)
        try {
          invocation.agent.followup({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: taskPrompt(key, issue, config.site, base) }],
            source: { kind: 'user' },
          })
          return {
            kind: 'success',
            text: `${issue.key} — ${issue.fields?.summary ?? ''}\n${log.join(' · ')}\nHanded to the agent.`,
          }
        } catch (error) {
          return { kind: 'error', text: `${log.join(' · ')}; could not reach the agent (${error?.message ?? error})` }
        }
      } catch (error) {
        return { kind: 'error', text: String(error?.message ?? error) }
      }
    },
  })

  ctx.commands.register({
    name: 'jira-check',
    description: 'Check the Jira credentials: show the authenticated account and the projects the token can see.',
    async handler() {
      try {
        const result = await checkAccess(await readConfig(ctx))
        return { kind: result.ok ? 'success' : 'error', text: result.text }
      } catch (error) {
        return { kind: 'error', text: String(error?.message ?? error) }
      }
    },
  })

  ctx.commands.register({
    name: 'jira-find',
    description: 'Search Jira with JQL; with no input it lists your open issues.',
    input: { hint: 'project = QUBE AND statusCategory != Done' },
    async handler(invocation) {
      const jql = invocation.rawInput.trim() ||
        'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
      try {
        const result = await searchIssues(await readConfig(ctx), jql, 20)
        return { kind: 'success', text: renderSearch(result) }
      } catch (error) {
        return { kind: 'error', text: String(error?.message ?? error) }
      }
    },
  })

  ctx.commands.register({
    name: 'jira-transition',
    description: 'Move a Jira ticket through a workflow transition; without a status it lists the allowed ones.',
    input: { hint: 'TCKT-123 In Review' },
    async handler(invocation) {
      const match = /^([A-Za-z][A-Za-z0-9_]*-\d+)(?:\s+([\s\S]+))?$/.exec(invocation.rawInput.trim())
      if (!match) return { kind: 'error', text: 'Usage: /jira-transition TCKT-123 [status]' }
      const key = match[1].toUpperCase()
      const status = (match[2] ?? '').trim()
      try {
        const config = await readConfig(ctx)
        if (!status) {
          return { kind: 'success', text: renderTransitions(key, await listTransitions(config, key)) }
        }
        const transition = await transitionIssue(config, key, status)
        return {
          kind: 'success',
          text: `Moved ${key} via "${transition.name}"${transition.to ? ` to ${transition.to}` : ''}.`,
        }
      } catch (error) {
        return { kind: 'error', text: String(error?.message ?? error) }
      }
    },
  })

  ctx.commands.register({
    name: 'jira-comment',
    description: 'Comment on a Jira ticket; without comment text the agent analyzes the ticket branch changes and writes it.',
    input: { hint: 'TCKT-123 Fixed the rounding issue' },
    async handler(invocation) {
      const post = async (key, body) => {
        try {
          const comment = await postComment(await readConfig(ctx), key, body)
          return { kind: 'success', text: `Commented on ${key} — ${comment.url}` }
        } catch (error) {
          return { kind: 'error', text: String(error?.message ?? error) }
        }
      }
      const raw = invocation.rawInput.trim()
      const explicit = /^([A-Za-z][A-Za-z0-9_]*-\d+)\s+([\s\S]+)$/.exec(raw)
      if (explicit) return post(explicit[1].toUpperCase(), explicit[2].trim())

      const cwd = invocation.agent.session.header?.cwd
      if (!cwd) return { kind: 'error', text: 'Jira: this session has no working directory.' }
      let branch
      try {
        branch = git(cwd, ['branch', '--show-current'])
      } catch (error) {
        return { kind: 'error', text: `Jira: ${gitError(error)}` }
      }
      const key = KEY_RE.test(raw) ? raw : KEY_RE.test(branch) ? branch : ''
      if (!key) {
        return { kind: 'error', text: 'Usage: /jira-comment [TCKT-123] comment text — the branch is not a ticket key, so name the ticket.' }
      }
      if (raw && !KEY_RE.test(raw)) return post(key, raw)

      try {
        const changes = branchChanges(cwd, key, baseBranch(cwd))
        if (!changes.diff && !changes.status) return { kind: 'error', text: `Jira: no changes on ${key} to summarize.` }
        invocation.agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: summarizePrompt(key, changes) }],
          source: { kind: 'user' },
        })
        return { kind: 'success', text: `Handed ${key}'s changes to the agent to analyze and comment.` }
      } catch (error) {
        return { kind: 'error', text: String(error?.message ?? error) }
      }
    },
  })
}
