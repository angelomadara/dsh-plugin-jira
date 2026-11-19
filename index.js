/**
 * Jira plugin, host half.
 *
 * - `/jira-do KEY` command: git checkout dev → pull → branch KEY → fetch the issue → hand it to the agent.
 * - `jira_ticket` tool: fetch one issue without touching git.
 * - Credentials `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN` are read per call and written by the browser half.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export const name = 'jira'
export const inject = ['commands', 'tools', 'credentials']

const REF = { site: 'JIRA_SITE', email: 'JIRA_EMAIL', token: 'JIRA_API_TOKEN' }
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/
const MAX_COMMENTS = 20
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Resolve the credentials. `JIRA_EMAIL` + `JIRA_API_TOKEN` are encoded into Basic auth (Jira Cloud);
 * with the email left blank the token is sent as `Bearer` (Jira Data Center PAT) unless it is already
 * a `Basic …` value.
 */
async function readConfig(ctx) {
  const read = async (ref) => (await ctx.credentials.resolve(ref))?.value
  const [site, email, token] = await Promise.all([read(REF.site), read(REF.email), read(REF.token)])
  if (!site || !token) {
    throw new Error('Jira is not configured — open Settings → Built-in plugins → Jira and set site URL and API token.')
  }
  let url
  try {
    url = new URL(site)
  } catch {
    throw new Error(`Jira: "${site}" is not a valid site URL.`)
  }
  if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('Jira: the site URL must use https (the API token would otherwise travel in cleartext).')
  }
  const authorization = email
    ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
    : /^Basic\s/i.test(token) ? token : `Bearer ${token}`
  return { site: site.replace(/\/+$/, ''), authorization }
}

/** GET one issue with the fields a fix needs. */
async function fetchIssue(config, key) {
  const url = `${config.site}/rest/api/3/issue/${encodeURIComponent(key)}` +
    '?fields=summary,description,status,issuetype,priority,labels,assignee,reporter,parent,comment'
  const response = await fetch(url, { headers: { authorization: config.authorization, accept: 'application/json' } })
  if (!response.ok) {
    throw new Error(`Jira ${response.status} for ${key}: ${(await response.text()).slice(0, 300)}`)
  }
  return response.json()
}

/** Flatten Atlassian Document Format (or plain text) into readable prose. */
function adfText(node, out = []) {
  if (node == null) return out
  if (Array.isArray(node)) {
    for (const child of node) adfText(child, out)
    return out
  }
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (node.type === 'text' && typeof node.text === 'string') out.push(node.text)
  if (node.type === 'hardBreak') out.push('\n')
  if (node.type === 'codeBlock') {
    adfText(node.content, out)
    out.push('\n')
    return out
  }
  if (node.content) adfText(node.content, out)
  if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem') out.push('\n')
  return out
}

function plain(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  return adfText(value)
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** One issue as the model and the command reply both read it. */
function renderIssue(issue) {
  const f = issue.fields ?? {}
  const comments = (f.comment?.comments ?? []).slice(-MAX_COMMENTS)
  const who = (person) => person?.displayName ?? 'unassigned'
  const head = [
    `${issue.key} — ${f.summary ?? '(no summary)'}`,
    `Type: ${f.issuetype?.name ?? '?'} · Status: ${f.status?.name ?? '?'} · Priority: ${f.priority?.name ?? '-'} · Assignee: ${who(f.assignee)} · Reporter: ${who(f.reporter)}`,
    f.parent ? `Parent: ${f.parent.key} — ${f.parent.fields?.summary ?? ''}` : '',
    f.labels?.length ? `Labels: ${f.labels.join(', ')}` : '',
  ].filter(Boolean).join('\n')
  const description = plain(f.description) || '(no description)'
  const thread = comments.length === 0 ? '' : '\n\n## Comments\n' + comments
    .map((c) => `- ${who(c.author)} (${(c.created ?? '').slice(0, 10)}): ${plain(c.body).replace(/\n+/g, ' ')}`)
    .join('\n')
  return `${head}\n\n## Description\n${description}${thread}`
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitError(error) {
  return String(error?.stderr ?? error?.message ?? error).trim()
}

/** dev + pull + KEY, reporting every step so the command reply shows what happened. */
function prepareBranch(cwd, key) {
  const log = []
  try {
    git(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    throw new Error(`Jira: ${cwd} is not a git repository.`)
  }
  try {
    git(cwd, ['checkout', 'dev'])
    log.push('checked out dev')
  } catch (error) {
    throw new Error(`Jira: could not check out dev — ${gitError(error)}`)
  }
  try {
    git(cwd, ['pull', '--ff-only'])
    log.push('pulled dev')
  } catch (error) {
    log.push(`pull skipped (${gitError(error).split('\n')[0]})`)
  }
  try {
    git(cwd, ['checkout', '-b', key])
    log.push(`created branch ${key}`)
  } catch (error) {
    try {
      git(cwd, ['checkout', key])
      log.push(`branch ${key} already existed, checked out`)
    } catch {
      throw new Error(`Jira: could not create branch ${key} — ${gitError(error)}`)
    }
  }
  return log
}

function taskPrompt(key, issue) {
  return [
    `Jira ${key} is checked out on branch ${key} (based on dev).`,
    '',
    renderIssue(issue),
    '',
    'Fix this like any other ticket in this repo:',
    '1. Read the code the ticket points at and name the root cause, not the symptom.',
    '2. Make the smallest change that fixes it, following the patterns already in the repo.',
    `3. Write docs/jira/${key}.md — file paths, line numbers, severity, root cause, fix.`,
    '4. Run the tests that cover the change.',
    '5. Do not commit or push; leave the diff for review.',
  ].join('\n')
}

/** Register the command and the fetch tool. */
export function apply(ctx) {
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
        log = prepareBranch(cwd, key)
        try {
          invocation.agent.followup({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: taskPrompt(key, issue) }],
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

  ctx.tools.register({
    name: 'jira_ticket',
    description: 'Fetch one Jira issue (summary, description, status, comments) by key. Read-only; does not touch git.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: {
        key: { type: 'string', description: 'Issue key, e.g. TCKT-123.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'text'],
        properties: {
          key: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const key = typeof args?.key === 'string' ? args.key.trim().toUpperCase() : ''
      if (!KEY_RE.test(key)) throw new Error('jira_ticket: `key` must look like TCKT-123')
      const issue = await fetchIssue(await readConfig(ctx), key)
      return { key: issue.key, text: renderIssue(issue) }
    },
  })
}
