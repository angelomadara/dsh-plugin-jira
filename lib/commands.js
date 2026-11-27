/** The slash commands: /jira-do, /jira-check, /jira-find, /jira-transition, /jira-comment. */
import { randomUUID } from 'node:crypto'
import { downloadAttachments, filesFromImages } from './attachments.js'
import { readConfig } from './config.js'
import {
  checkAccess, fetchIssue, KEY_RE, listTransitions, postComment,
  renderSearch, renderTransitions, searchIssues, transitionIssue,
} from './jira.js'
import { branchChanges, ensureWorktree, git, gitError, isDirty, prepareBranch, worktreeKeys } from './git.js'
import { summarizePrompt, taskPrompt } from './prompts.js'
import { openRequest, parseTargets } from './requests.js'
import { branchName, keyFromBranch, repoConfig } from './repo.js'

/** Register the Jira commands on the plugin context. */
export function registerCommands(ctx) {
  ctx.commands.register({
    name: 'jira-do',
    description: 'Fetch a Jira ticket: prepare its branch or worktree, download attachments, then hand it to the agent to fix.',
    input: { hint: 'TCKT-123' },
    async handler(invocation) {
      const key = invocation.rawInput.trim().toUpperCase()
      if (!KEY_RE.test(key)) return { kind: 'error', text: 'Usage: /jira-do TCKT-123' }
      const cwd = invocation.agent.session.header?.cwd
      if (!cwd) return { kind: 'error', text: 'Jira: this session has no working directory.' }

      try {
        const repo = repoConfig(cwd)
        const config = await readConfig(ctx)
        let issue
        try {
          issue = await fetchIssue(config, key, Object.values(repo.fields))
        } catch (error) {
          return { kind: 'error', text: `Jira fetch failed: ${error?.message ?? error}` }
        }

        if (!repo.allowDirty && !repo.worktree && isDirty(cwd)) {
          return {
            kind: 'error',
            text: 'Jira: the working tree has tracked changes; commit or stash them, or set "allowDirty": true in .dsh-jira.json.',
          }
        }

        const base = repo.base
        const branch = branchName(repo, key, issue.fields?.summary)
        let worktree = ''
        let log
        let existing = false
        if (repo.worktree) {
          worktree = ensureWorktree(cwd, branch, base)
          log = [`worktree ${worktree}`]
        } else {
          const prepared = prepareBranch(cwd, branch, base)
          log = prepared.log
          existing = prepared.existing
        }
        let ahead = '0'
        if (existing) {
          try {
            ahead = git(cwd, ['rev-list', '--count', `${base}..${branch}`])
          } catch {}
        }

        const workdir = worktree || cwd
        const attachments = repo.downloadAttachments
          ? await downloadAttachments(config, issue, workdir, key)
          : null
        const task = taskPrompt(key, issue, config.site, base, {
          fields: repo.fields,
          branch,
          worktree,
          existing,
          ahead,
          attachments,
        })
        try {
          invocation.agent.followup({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: task }],
            source: { kind: 'user' },
          })
        } catch (error) {
          return { kind: 'error', text: `${log.join(' · ')}; could not reach the agent (${error?.message ?? error})` }
        }

        const continued = existing ? `Continuing ${branch} (${ahead} commit(s) ahead of ${base}).\n` : ''
        const downloaded = attachments?.files?.length
          ? `\n${attachments.files.length} attachment(s) in docs/jira/${key}/`
          : ''
        return {
          kind: 'success',
          text: `${issue.key} — ${issue.fields?.summary ?? ''}\n${log.join(' · ')}\n${continued}Handed to the agent.${downloaded}`,
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

  const requestCommand = (label) => ({
    description: `Open a ${label} from the ticket branch to one or more target branches (default dev), using docs/jira/<KEY>.md.`,
    input: { hint: 'dev staging main' },
    async handler(invocation) {
      const cwd = invocation.agent.session.header?.cwd
      if (!cwd) return { kind: 'error', text: 'Jira: this session has no working directory.' }
      let branch
      try {
        branch = git(cwd, ['branch', '--show-current'])
      } catch (error) {
        return { kind: 'error', text: `Jira: ${gitError(error)}` }
      }
      const keys = worktreeKeys(cwd)
      const key = keyFromBranch(branch) || (keys.length === 1 ? keys[0] : '')
      if (!key) {
        return { kind: 'error', text: 'Jira: run this from the ticket branch (or with a single ticket worktree).' }
      }
      try {
        const targets = parseTargets(invocation.rawInput, repoConfig(cwd).base)
        const result = await openRequest(ctx, cwd, key, targets)
        const committed = result.committed ? `Committed ${result.committed}.` : ''
        const lines = result.results.map((entry) => entry.error
          ? `Failed ${entry.target}: ${entry.error}`
          : `${entry.action} ${entry.existing ? 'already open' : 'opened'} → ${entry.target}: ${entry.url}`)
        const opened = result.results.some((entry) => !entry.error)
        return {
          kind: opened ? 'success' : 'error',
          text: [committed, ...lines].filter(Boolean).join('\n'),
        }
      } catch (error) {
        return { kind: 'error', text: String(error?.message ?? error) }
      }
    },
  })

  ctx.commands.register({ name: 'jira-mr', ...requestCommand('GitLab merge request or GitHub pull request') })
  ctx.commands.register({ name: 'jira-pr', ...requestCommand('GitHub pull request or GitLab merge request') })

  ctx.commands.register({
    name: 'jira-comment',
    description: 'Comment on a Jira ticket; without comment text the agent analyzes the ticket branch changes and writes it.',
    input: { hint: 'TCKT-123 Fixed the rounding issue', attachments: true },
    async handler(invocation) {
      const post = async (key, body, files = []) => {
        try {
          const comment = await postComment(await readConfig(ctx), key, body, files)
          return { kind: 'success', text: `Commented on ${key} — ${comment.url}` }
        } catch (error) {
          return { kind: 'error', text: String(error?.message ?? error) }
        }
      }
      const files = filesFromImages(invocation.attachments)
      const raw = invocation.rawInput.trim()
      const explicit = /^([A-Za-z][A-Za-z0-9_]*-\d+)\s+([\s\S]+)$/.exec(raw)
      if (explicit) return post(explicit[1].toUpperCase(), explicit[2].trim(), files)

      const cwd = invocation.agent.session.header?.cwd
      if (!cwd) return { kind: 'error', text: 'Jira: this session has no working directory.' }
      let branch
      try {
        branch = git(cwd, ['branch', '--show-current'])
      } catch (error) {
        return { kind: 'error', text: `Jira: ${gitError(error)}` }
      }
      const repo = repoConfig(cwd)
      const keys = worktreeKeys(cwd)
      const key = KEY_RE.test(raw)
        ? raw
        : keyFromBranch(branch) || (keys.length === 1 ? keys[0] : '')
      if (!key) {
        return { kind: 'error', text: 'Usage: /jira-comment [TCKT-123] comment text — the branch is not a ticket key, so name the ticket.' }
      }
      if (raw && !KEY_RE.test(raw)) return post(key, raw, files)
      if (files.length > 0) return post(key, '', files)

      try {
        const changes = branchChanges(cwd, key, repo.base)
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
