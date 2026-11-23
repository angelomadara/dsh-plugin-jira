/** The two model tools: jira_ticket (read) and jira_comment (write). */
import { filesFromPaths } from './attachments.js'
import { readConfig } from './config.js'
import { fetchIssue, KEY_RE, listTransitions, postComment, renderIssue, renderSearch, renderTransitions, searchIssues, transitionIssue } from './jira.js'

/** Register the Jira tools on the plugin context. */
export function registerTools(ctx) {
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
    name: 'jira_search',
    description: 'Search Jira issues with JQL (max 50). Read-only; does not touch git.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['jql'],
      properties: {
        jql: { type: 'string', description: 'JQL, e.g. project = QUBE AND statusCategory != Done ORDER BY updated DESC.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['jql', 'text'],
        properties: {
          jql: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const jql = typeof args?.jql === 'string' ? args.jql.trim() : ''
      if (!jql) throw new Error('jira_search: `jql` must not be empty')
      const result = await searchIssues(await readConfig(ctx), jql, args?.maxResults)
      return { jql, text: renderSearch(result) }
    },
  })

  ctx.tools.register({
    name: 'jira_transition',
    description: 'Move a Jira issue through a workflow transition. Omit status to list the allowed transitions. Writes to Jira; does not touch git.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: {
        key: { type: 'string', description: 'Issue key, e.g. TCKT-123.' },
        status: { type: 'string', description: 'Transition name or destination status, e.g. "In Review". Omit to list.' },
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
      if (!KEY_RE.test(key)) throw new Error('jira_transition: `key` must look like TCKT-123')
      const config = await readConfig(ctx)
      const status = typeof args?.status === 'string' ? args.status.trim() : ''
      if (!status) {
        return { key, text: renderTransitions(key, await listTransitions(config, key)) }
      }
      const transition = await transitionIssue(config, key, status)
      return { key, text: `Moved ${key} via "${transition.name}"${transition.to ? ` to ${transition.to}` : ''}.` }
    },
  })

  ctx.tools.register({
    name: 'jira_comment',
    description: 'Post a comment on a Jira issue (progress, findings, completion), optionally with local images/screenshots. Writes to Jira; does not touch git.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'body'],
      properties: {
        key: { type: 'string', description: 'Issue key, e.g. TCKT-123.' },
        body: { type: 'string', description: 'Comment text. Blank lines start new paragraphs. May be empty when attachments are supplied.' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'Optional local file paths (images/screenshots) to upload and embed.' },
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
      const paths = Array.isArray(args?.attachments)
        ? args.attachments.filter((path) => typeof path === 'string')
        : []
      const files = filesFromPaths(paths)
      if (!body && files.length === 0) throw new Error('jira_comment: `body` or `attachments` is required')
      const comment = await postComment(await readConfig(ctx), key, body, files)
      return { key, id: comment.id, url: comment.url }
    },
  })
}
