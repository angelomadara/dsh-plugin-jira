/** The two model tools: jira_ticket (read) and jira_comment (write). */
import { readConfig } from './config.js'
import { fetchIssue, KEY_RE, postComment, renderIssue } from './jira.js'

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
