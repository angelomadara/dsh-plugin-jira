/** Download a ticket's attachments into `docs/jira/<KEY>/` for the agent. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

// ponytail: 10 MB per file keeps one ticket from dumping a video into the repo; raise if needed.
const MAX_BYTES = 10 * 1024 * 1024

/**
 * Fetch every attachment into `docs/jira/<KEY>/` under `cwd`.
 * @returns `{ dir, files, skipped }`; failures are reported in `skipped`, not thrown.
 */
export async function downloadAttachments(config, issue, cwd, key) {
  const attachments = issue.fields?.attachment ?? []
  if (attachments.length === 0) return { dir: '', files: [], skipped: [] }
  const dir = join(cwd, 'docs', 'jira', key)
  mkdirSync(dir, { recursive: true })
  const files = []
  const skipped = []
  for (const attachment of attachments) {
    const name = basename(attachment.filename ?? `attachment-${attachment.id}`)
    if (Number(attachment.size) > MAX_BYTES) {
      skipped.push(`${name} (>10 MB)`)
      continue
    }
    const content = String(attachment.content ?? '')
    const url = /^https?:/i.test(content) ? content : `${config.site}${content}`
    try {
      const response = await fetch(url, { headers: { authorization: config.authorization } })
      if (!response.ok) {
        skipped.push(`${name} (HTTP ${response.status})`)
        continue
      }
      const path = join(dir, `${attachment.id}-${name}`)
      writeFileSync(path, Buffer.from(await response.arrayBuffer()))
      files.push({ name, path })
    } catch (error) {
      skipped.push(`${name} (${error?.message ?? error})`)
    }
  }
  return { dir, files, skipped }
}
