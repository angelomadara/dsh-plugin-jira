/** Download ticket attachments, upload comment attachments, and map local files. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

// ponytail: 10 MB per file keeps one ticket from dumping a video into the repo; raise if needed.
const MAX_BYTES = 10 * 1024 * 1024

const MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  zip: 'application/zip',
}

/** Guess a content type from the file extension. */
export function mediaTypeFor(filename) {
  return MEDIA_TYPES[extname(filename).slice(1).toLowerCase()] ?? 'application/octet-stream'
}

/** Read local file paths into upload payloads (capped at 10 files / 10 MB each). */
export function filesFromPaths(paths) {
  const files = []
  for (const path of paths.slice(0, 10)) {
    const bytes = readFileSync(path)
    if (bytes.length > MAX_BYTES) throw new Error(`${basename(path)} is larger than 10 MB.`)
    files.push({ bytes, filename: basename(path), mediaType: mediaTypeFor(path) })
  }
  return files
}

/** Turn composer image attachments (base64 `ImageBlock`s) into upload payloads. */
export function filesFromImages(images) {
  return (images ?? [])
    .filter((image) => image?.type === 'image' && typeof image.data === 'string')
    .slice(0, 10)
    .map((image) => ({
      bytes: Buffer.from(image.data, 'base64'),
      filename: image.name ?? `screenshot.${(image.mediaType ?? 'image/png').split('/')[1] ?? 'png'}`,
      mediaType: image.mediaType ?? 'image/png',
    }))
}

/** Upload files to the issue; returns Jira's attachment records (with ids). */
export async function uploadAttachments(config, key, files) {
  if (files.length === 0) return []
  const form = new FormData()
  for (const file of files) form.append('file', new Blob([file.bytes], { type: file.mediaType }), file.filename)
  const response = await fetch(`${config.site}/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, {
    method: 'POST',
    headers: {
      authorization: config.authorization,
      'X-Atlassian-Token': 'no-check',
      accept: 'application/json',
    },
    body: form,
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`Jira ${response.status} uploading attachments: ${detail}`)
  }
  const uploaded = await response.json()
  return Array.isArray(uploaded) ? uploaded : []
}

/** Resolve a Jira attachment id to its Media Services UUID (comments embed that, not the numeric id). */
export async function mediaIdFor(config, attachmentId) {
  try {
    const response = await fetch(`${config.site}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`, {
      headers: { authorization: config.authorization },
      redirect: 'manual',
    })
    const location = response.headers.get('location') ?? response.url ?? ''
    const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(location)
    return match ? match[0] : ''
  } catch {
    return ''
  }
}

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
