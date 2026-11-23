/** Jira REST v3: issue reads, comments, ADF rendering, and the credential check. */
import { textToAdf } from './adf.js'
import { mediaIdFor, uploadAttachments } from './attachments.js'
import { credentialHint } from './config.js'

/** Issue key, e.g. TCKT-123. */
export const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/
const MAX_BRIEF_COMMENTS = 200
const BASE_FIELDS = [
  'summary', 'description', 'status', 'issuetype', 'priority', 'labels',
  'assignee', 'reporter', 'parent', 'components', 'fixVersions', 'environment',
  'subtasks', 'attachment',
]

/** All comments, paged in 100s up to `MAX_BRIEF_COMMENTS`. */
async function allComments(config, key) {
  const base = `${config.site}/rest/api/3/issue/${encodeURIComponent(key)}/comment`
  const headers = { authorization: config.authorization, accept: 'application/json' }
  try {
    const comments = []
    let total = Infinity
    while (comments.length < Math.min(total, MAX_BRIEF_COMMENTS)) {
      const response = await fetch(`${base}?startAt=${comments.length}&maxResults=100`, { headers })
      if (!response.ok) break
      const data = await response.json()
      total = Number.isFinite(data.total) ? data.total : comments.length + (data.comments?.length ?? 0)
      const page = data.comments ?? []
      if (page.length === 0) break
      comments.push(...page)
    }
    return comments.slice(0, MAX_BRIEF_COMMENTS)
  } catch {
    return []
  }
}

/** GET one issue with the fields a fix needs; `extraFields` adds configured custom fields. */
export async function fetchIssue(config, key, extraFields = []) {
  const fields = [...new Set([...BASE_FIELDS, ...extraFields])].join(',')
  const url = `${config.site}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`
  const response = await fetch(url, { headers: { authorization: config.authorization, accept: 'application/json' } })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    const hint = response.status === 404 ? await credentialHint(config) : ''
    throw new Error(`Jira ${response.status} for ${key}: ${detail}${hint}`)
  }
  const issue = await response.json()
  issue.fields = issue.fields ?? {}
  issue.fields.comment = { comments: await allComments(config, key) }
  return issue
}

/** POST one comment (with optional uploaded files); returns its id and browser URL. */
export async function postComment(config, key, text, files = []) {
  const uploaded = files.length > 0 ? await uploadAttachments(config, key, files) : []
  const body = textToAdf(text)
  for (const file of uploaded) {
    const mediaId = await mediaIdFor(config, file.id)
    if (mediaId) {
      body.content.push({
        type: 'mediaSingle',
        attrs: { layout: 'center' },
        content: [{ type: 'media', attrs: { type: 'file', id: mediaId, collection: '' } }],
      })
    } else if (file.content) {
      // No Media Services id (DC or a direct download): link the attachment instead of embedding.
      body.content.push({
        type: 'paragraph',
        content: [
          { type: 'text', text: `${file.filename ?? 'attachment'}: ` },
          { type: 'text', text: String(file.content), marks: [{ type: 'link', attrs: { href: String(file.content) } }] },
        ],
      })
    }
  }
  const url = `${config.site}/rest/api/3/issue/${encodeURIComponent(key)}/comment`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: config.authorization,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ body }),
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

const FIELD_LABELS = {
  acceptanceCriteria: 'Acceptance criteria',
  storyPoints: 'Story points',
  severity: 'Severity',
  epic: 'Epic',
}

/** Render a custom-field value without assuming its shape. */
function fieldValue(value) {
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(fieldValue).filter(Boolean).join(', ')
  if (typeof value === 'object') {
    if ('value' in value) return fieldValue(value.value)
    if ('name' in value) return fieldValue(value.name)
    if ('displayName' in value) return fieldValue(value.displayName)
    if ('key' in value) return fieldValue(value.key)
  }
  return ''
}

function formatSize(bytes) {
  const size = Number(bytes)
  if (!Number.isFinite(size) || size <= 0) return ''
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`
}

/** One issue as the model and the command reply both read it. */
export function renderIssue(issue, fieldLabels = {}) {
  const f = issue.fields ?? {}
  const comments = f.comment?.comments ?? []
  const who = (person) => person?.displayName ?? 'unassigned'
  const names = (list) => (list ?? []).map((item) => item?.name).filter(Boolean).join(', ')
  const subtasks = (f.subtasks ?? [])
    .map((subtask) => `${subtask.key} ${subtask.fields?.summary ?? ''}`.trim())
    .join('; ')
  const attachments = (f.attachment ?? [])
    .map((file) => `${file.filename ?? file.id}${formatSize(file.size) ? ` (${formatSize(file.size)})` : ''}`)
    .join(', ')
  const custom = Object.entries(fieldLabels).map(([label, id]) => {
    const value = fieldValue(f[id])
    return value ? `${FIELD_LABELS[label] ?? label}: ${value}` : ''
  })
  const head = [
    `${issue.key} — ${f.summary ?? '(no summary)'}`,
    `Type: ${f.issuetype?.name ?? '?'} · Status: ${f.status?.name ?? '?'} · Priority: ${f.priority?.name ?? '-'} · Assignee: ${who(f.assignee)} · Reporter: ${who(f.reporter)}`,
    f.parent ? `Parent: ${f.parent.key} — ${f.parent.fields?.summary ?? ''}` : '',
    names(f.components) ? `Components: ${names(f.components)}` : '',
    names(f.fixVersions) ? `Fix versions: ${names(f.fixVersions)}` : '',
    f.labels?.length ? `Labels: ${f.labels.join(', ')}` : '',
    plain(f.environment) ? `Environment: ${plain(f.environment)}` : '',
    subtasks ? `Subtasks: ${subtasks}` : '',
    attachments ? `Attachments: ${attachments}` : '',
    ...custom,
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

/** JQL search over the v3 endpoint, falling back to the legacy `/search` on DC. */
export async function searchIssues(config, jql, maxResults = 20) {
  const limit = Math.min(50, Math.max(1, Number(maxResults) || 20))
  const params = new URLSearchParams({
    jql,
    maxResults: String(limit),
    fields: 'summary,status,assignee,priority,issuetype',
  })
  const headers = { authorization: config.authorization, accept: 'application/json' }
  const search = (path) => fetch(`${config.site}${path}?${params}`, { headers })
  let response = await search('/rest/api/3/search/jql')
  if (response.status === 404 || response.status === 410) response = await search('/rest/api/3/search')
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`Jira ${response.status} searching: ${detail}`)
  }
  const data = await response.json()
  const issues = (data.issues ?? []).map((issue) => ({
    key: issue.key,
    summary: issue.fields?.summary ?? '',
    status: issue.fields?.status?.name ?? '?',
    assignee: issue.fields?.assignee?.displayName ?? 'unassigned',
    type: issue.fields?.issuetype?.name ?? '',
  }))
  const total = Number.isFinite(data.total) ? data.total : issues.length
  return { jql, total, issues }
}

/** Compact one-line-per-issue rendering for commands and tools. */
export function renderSearch(result) {
  if (result.issues.length === 0) return `No issues for: ${result.jql}`
  const head = `${result.issues.length}${result.total > result.issues.length ? ` of ${result.total}` : ''} issue(s) for: ${result.jql}`
  const lines = result.issues.map((issue) => `${issue.key} [${issue.status}] ${issue.summary} — ${issue.assignee}`)
  return `${head}\n${lines.join('\n')}`
}

/** Allowed transitions for one issue. */
export async function listTransitions(config, key) {
  const response = await fetch(`${config.site}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    headers: { authorization: config.authorization, accept: 'application/json' },
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`Jira ${response.status} reading transitions for ${key}: ${detail}`)
  }
  const data = await response.json()
  return (data.transitions ?? []).map((transition) => ({
    id: transition.id,
    name: transition.name ?? '',
    to: transition.to?.name ?? '',
  }))
}

/** Apply the transition whose name or destination status matches `status`. */
export async function transitionIssue(config, key, status) {
  const transitions = await listTransitions(config, key)
  const wanted = status.trim().toLowerCase()
  const target = transitions.find((transition) => transition.name.toLowerCase() === wanted)
    ?? transitions.find((transition) => transition.to.toLowerCase() === wanted)
  if (!target) {
    const available = transitions.map((transition) => transition.to
      ? `${transition.name} → ${transition.to}`
      : transition.name).join(', ') || '(none)'
    throw new Error(`Jira: no transition "${status}" on ${key}. Available: ${available}`)
  }
  const response = await fetch(`${config.site}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    headers: {
      authorization: config.authorization,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ transition: { id: target.id } }),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`Jira ${response.status} transitioning ${key}: ${detail}`)
  }
  return target
}

/** One-line list for the command/tool reply. */
export function renderTransitions(key, transitions) {
  if (transitions.length === 0) return `${key}: no transitions available.`
  return `${key} transitions:\n${transitions
    .map((transition) => `- ${transition.name}${transition.to ? ` → ${transition.to}` : ''}`)
    .join('\n')}`
}
