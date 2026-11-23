/** Open a GitHub pull request or GitLab merge request for a ticket branch. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readConfig } from './config.js'
import { findTicketWorktree, git } from './git.js'
import { fetchIssue } from './jira.js'
import { keyFromBranch, repoConfig } from './repo.js'

/** Parse `https://host/group/repo.git` and `git@host:group/repo.git`. */
export function parseRemote(url) {
  const cleaned = String(url ?? '').trim().replace(/\/+$/, '').replace(/\.git$/, '')
  const ssh = /^[^@\s]+@([^:\s]+):(.+)$/.exec(cleaned)
  if (ssh) return { host: ssh[1], path: ssh[2] }
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(cleaned)
  if (https) return { host: https[1], path: https[2] }
  const sshUrl = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(cleaned)
  if (sshUrl) return { host: sshUrl[1], path: sshUrl[2] }
  return null
}

/** The markdown under the first heading matching one of `names` (case-insensitive). */
export function extractSection(text, names) {
  const lines = String(text ?? '').split('\n')
  const wanted = names.map((name) => name.toLowerCase())
  const start = lines.findIndex((line) => {
    const match = /^#{1,6}\s+(.*)$/.exec(line)
    return match ? wanted.some((name) => match[1].toLowerCase().startsWith(name)) : false
  })
  if (start === -1) return ''
  const body = []
  for (let index = start + 1; index < lines.length; index++) {
    if (/^#{1,6}\s+/.test(lines[index])) break
    body.push(lines[index])
  }
  return body.join('\n').trim()
}

/** Structured PR/MR description from the change report. */
export function buildRequestBody({ key, summary, site, branch, target, report }) {
  const rootCause = extractSection(report, ['root cause', 'cause'])
  const testPlan = extractSection(report, ['test plan', 'tests', 'testing', 'verification'])
  const ticket = site
    ? `[${key}${summary ? ` — ${summary}` : ''}](${site}/browse/${key})`
    : `${key}${summary ? ` — ${summary}` : ''}`
  return [
    '## Jira',
    ticket,
    '',
    `**Branch:** \`${branch}\` → \`${target}\``,
    '',
    '## Root cause',
    rootCause || 'See the change report below.',
    '',
    '## Test plan',
    testPlan || 'See the change report below.',
    '',
    '<details>',
    `<summary>Change report (\`docs/jira/${key}.md\`)</summary>`,
    '',
    report.trim(),
    '',
    '</details>',
    '',
  ].join('\n')
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', ...options }).trim()
  } catch (error) {
    throw new Error(String(error?.stderr || error?.message || error).trim())
  }
}

async function gitlabToken(ctx, host) {
  if (process.env.GITLAB_TOKEN) return process.env.GITLAB_TOKEN
  try {
    const resolved = await ctx.credentials.resolve('GITLAB_TOKEN')
    if (resolved?.value) return resolved.value
  } catch {}
  try {
    const out = run('git', ['credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const password = /^password=(.*)$/m.exec(out)?.[1]?.trim()
    if (password) return password
  } catch {}
  return ''
}

async function createGitlab(ctx, remote, { branch, target, title, body }) {
  const token = await gitlabToken(ctx, remote.host)
  if (!token) {
    throw new Error(`GitLab authentication for ${remote.host} is missing: set GITLAB_TOKEN in the DSH credential store or environment, or store git credentials for that host.`)
  }
  const api = `https://${remote.host}/api/v4`
  const project = encodeURIComponent(remote.path)
  const headers = { 'PRIVATE-TOKEN': token, accept: 'application/json' }
  const query = new URLSearchParams({ state: 'opened', source_branch: branch, target_branch: target })
  const existing = await fetch(`${api}/projects/${project}/merge_requests?${query}`, { headers })
  if (existing.ok) {
    const list = await existing.json()
    if (Array.isArray(list) && list[0]?.web_url) {
      return { url: list[0].web_url, provider: 'gitlab', action: 'merge request', existing: true }
    }
  }
  const response = await fetch(`${api}/projects/${project}/merge_requests`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ source_branch: branch, target_branch: target, title, description: body }),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`GitLab ${response.status} creating merge request: ${detail}`)
  }
  const mr = await response.json()
  return { url: mr.web_url, provider: 'gitlab', action: 'merge request', existing: false }
}

function createGithub(cwd, { branch, target, title, body }) {
  const existing = run('gh', ['pr', 'list', '--head', branch, '--base', target, '--state', 'open', '--json', 'url', '--jq', '.[0].url'], { cwd })
  if (existing) return { url: existing, provider: 'github', action: 'pull request', existing: true }
  const url = run('gh', ['pr', 'create', '--base', target, '--head', branch, '--title', title, '--body-file', '-'], { cwd, input: body })
  return { url, provider: 'github', action: 'pull request', existing: false }
}

/** Stage the whole working tree (ignored files excluded) and commit it. */
export function commitTicketChanges(path, message) {
  git(path, ['add', '-A'])
  let staged = true
  try {
    git(path, ['diff', '--cached', '--quiet'])
    staged = false
  } catch {}
  if (!staged) return ''
  git(path, ['commit', '-m', message])
  return git(path, ['rev-parse', '--short', 'HEAD'])
}

/**
 * Open the ticket branch's request: commit the ticket's changes, push the branch,
 * then create the GitHub PR or GitLab MR.
 */
export async function openRequest(ctx, cwd, key, target) {
  const worktree = findTicketWorktree(cwd, key)
  const path = worktree?.path ?? cwd
  const branch = worktree?.branch ?? git(cwd, ['branch', '--show-current'])
  if (keyFromBranch(branch) !== key) {
    throw new Error(`Jira: ${key} is not the current branch (${branch || 'detached HEAD'}).`)
  }
  if (branch === target) throw new Error('Jira: the target branch and the ticket branch are the same.')

  const reportPath = join(path, 'docs', 'jira', `${key}.md`)
  if (!existsSync(reportPath)) {
    throw new Error(`Jira: docs/jira/${key}.md is missing — write the change report before opening a request.`)
  }
  const report = readFileSync(reportPath, 'utf8')

  const remote = parseRemote(git(cwd, ['remote', 'get-url', 'origin']))
  if (!remote) throw new Error('Jira: origin is not a recognisable GitHub/GitLab remote.')
  const provider = repoConfig(cwd).provider
    || (/github/i.test(remote.host) ? 'github' : /gitlab/i.test(remote.host) ? 'gitlab' : '')
  if (!provider) {
    throw new Error(`Jira: cannot tell whether ${remote.host} is GitHub or GitLab; set "provider" in .dsh-jira.json.`)
  }
  if (provider === 'github' && !remote.host.includes('github')) {
    // A GitHub Enterprise host still works through the gh CLI.
  }

  let summary = ''
  let site = ''
  try {
    const config = await readConfig(ctx)
    site = config.site
    summary = (await fetchIssue(config, key)).fields?.summary ?? ''
  } catch {}

  const committed = commitTicketChanges(path, summary ? `${key}: ${summary}` : `${key}: ticket changes`)

  run('git', ['push', '-u', 'origin', branch], { cwd })
  const title = `${key}${summary ? ` — ${summary}` : ''}`.slice(0, 200)
  const body = buildRequestBody({ key, summary, site, branch, target, report })
  const result = provider === 'gitlab'
    ? await createGitlab(ctx, remote, { branch, target, title, body })
    : createGithub(cwd, { branch, target, title, body })
  return { ...result, committed }
}
