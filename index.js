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
    throw new Error('Jira is not configured — open Settings → Jira and set site URL and API token.')
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

/** A 404 hides both a missing issue and rejected credentials; ask /myself when it happens. */
async function credentialHint(config) {
  try {
    const response = await fetch(`${config.site}/rest/api/3/myself`, {
      headers: { authorization: config.authorization, accept: 'application/json' },
    })
    if (response.status === 401) {
      return ' — Jira rejected the credentials (401 on /myself); update the email/API token in Settings → Jira.'
    }
  } catch {}
  return ''
}

/** GET one issue with the fields a fix needs. */
async function fetchIssue(config, key) {
  const url = `${config.site}/rest/api/3/issue/${encodeURIComponent(key)}` +
    '?fields=summary,description,status,issuetype,priority,labels,assignee,reporter,parent,comment'
  const response = await fetch(url, { headers: { authorization: config.authorization, accept: 'application/json' } })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    const hint = response.status === 404 ? await credentialHint(config) : ''
    throw new Error(`Jira ${response.status} for ${key}: ${detail}${hint}`)
  }
  return response.json()
}

/** Turn plain comment text into Atlassian Document Format for REST API v3. */
function textToAdf(text) {
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean)
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((paragraph) => ({
      type: 'paragraph',
      content: paragraph.split('\n').flatMap((line, index) => index === 0
        ? [{ type: 'text', text: line }]
        : [{ type: 'hardBreak' }, { type: 'text', text: line }]),
    })),
  }
}

/** POST one comment; returns its id and the browser URL that focuses it. */
async function postComment(config, key, text) {
  const url = `${config.site}/rest/api/3/issue/${encodeURIComponent(key)}/comment`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: config.authorization,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ body: textToAdf(text) }),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    const hint = response.status === 404 ? await credentialHint(config) : ''
    throw new Error(`Jira ${response.status} commenting on ${key}: ${detail}${hint}`)
  }
  const comment = await response.json()
  const id = String(comment.id ?? '')
  const browse = `${config.site}/browse/${encodeURIComponent(key)}`
  return { id, url: id ? `${browse}?focusedCommentId=${encodeURIComponent(id)}` : browse }
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

const MAX_SUMMARY_DIFF = 60000

/** The ticket branch's changes: committed since the base branch, plus the working tree. */
function branchChanges(cwd, key) {
  const branch = git(cwd, ['branch', '--show-current'])
  if (branch !== key) {
    throw new Error(`Jira: ${key} is not the current branch (${branch || 'detached HEAD'}); check it out or pass comment text.`)
  }
  let base = ''
  for (const candidate of ['dev', 'main', 'master']) {
    try {
      git(cwd, ['rev-parse', '--verify', '--quiet', candidate])
      base = candidate
      break
    } catch {}
  }
  const committed = base ? git(cwd, ['diff', `${base}...HEAD`]) : ''
  const working = git(cwd, ['diff', 'HEAD'])
  const status = git(cwd, ['status', '--porcelain'])
  return { base: base || '(no dev/main/master)', diff: [committed, working].filter(Boolean).join('\n'), status }
}

/** Hand-off prompt for a comment the agent has to write from the branch's changes. */
function summarizePrompt(key, changes) {
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

function taskPrompt(key, issue, site) {
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

/** Register the commands and the tools. */
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
            content: [{ type: 'text', text: taskPrompt(key, issue, config.site) }],
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
        const changes = branchChanges(cwd, key)
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

  ctx.tools.register({
    name: 'jira_comment',
    description: 'Post a comment on a Jira issue (progress, findings, completion). Writes to Jira; does not touch git.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'body'],
      properties: {
        key: { type: 'string', description: 'Issue key, e.g. TCKT-123.' },
        body: { type: 'string', description: 'Comment text. Blank lines start new paragraphs.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'id', 'url'],
        properties: {
          key: { type: 'string' },
          id: { type: 'string' },
          url: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Commented on ${value.key}. ${value.url}` }],
    },
    async execute(args) {
      const key = typeof args?.key === 'string' ? args.key.trim().toUpperCase() : ''
      const body = typeof args?.body === 'string' ? args.body.trim() : ''
      if (!KEY_RE.test(key)) throw new Error('jira_comment: `key` must look like TCKT-123')
      if (!body) throw new Error('jira_comment: `body` must not be empty')
      const comment = await postComment(await readConfig(ctx), key, body)
      return { key, id: comment.id, url: comment.url }
    },
  })
}
