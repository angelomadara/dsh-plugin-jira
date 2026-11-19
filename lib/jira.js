/** Jira REST v3: issue reads, comments, ADF rendering, and the credential check. */
import { credentialHint } from './config.js'

/** Issue key, e.g. TCKT-123. */
export const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/
const MAX_COMMENTS = 20

/** GET one issue with the fields a fix needs. */
export async function fetchIssue(config, key) {
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
export function textToAdf(text) {
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
export async function postComment(config, key, text) {
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
export function renderIssue(issue) {
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

/** Who the token authenticates as, and whether it can see any projects. */
export async function checkAccess(config) {
  const headers = { authorization: config.authorization, accept: 'application/json' }
  const meResponse = await fetch(`${config.site}/rest/api/3/myself`, { headers })
  if (!meResponse.ok) {
    const detail = (await meResponse.text()).slice(0, 300)
    if (meResponse.status === 401) {
      return {
        ok: false,
        text: 'Jira rejected the credentials (401). On Jira Cloud the email must be the account that owns the API token; on Data Center leave the email blank and paste a PAT. Update Settings → Jira; if a fresh token still fails, ask your admin whether API tokens are allowed.',
      }
    }
    return { ok: false, text: `Jira ${meResponse.status} on /myself: ${detail}` }
  }
  const me = await meResponse.json()
  const identity = me.accountId ?? me.name ?? me.key ?? 'unknown'
  const contact = me.emailAddress ? ` <${me.emailAddress}>` : ''
  const projectsResponse = await fetch(`${config.site}/rest/api/3/project/search?maxResults=5`, { headers })
  if (!projectsResponse.ok) {
    const detail = (await projectsResponse.text()).slice(0, 300)
    return {
      ok: false,
      text: `Signed in as ${me.displayName ?? identity}${contact} (${identity}), but the project list failed: Jira ${projectsResponse.status} ${detail}`,
    }
  }
  const projects = await projectsResponse.json()
  const values = Array.isArray(projects.values) ? projects.values : []
  const total = Number.isFinite(projects.total) ? projects.total : values.length
  const visible = values
    .map((project) => project.name ? `${project.key} — ${project.name}` : project.key)
    .join(', ')
  const line = total === 0
    ? "No projects are visible to this token — check the account's project permissions."
    : `Visible projects (${total}): ${visible}${total > values.length ? ', …' : ''}`
  return { ok: true, text: `Signed in as ${me.displayName ?? identity}${contact} (${identity}).\n${line}` }
}
