/** Repo-local `.dsh-jira.json` settings: base branch, branch template, worktree, fields. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULTS = {
  base: 'dev',
  branch: '{key}',
  worktree: false,
  allowDirty: false,
  downloadAttachments: true,
  provider: '',
  fields: {},
}

/** Read `.dsh-jira.json` at the repo root, falling back to the defaults. */
export function repoConfig(cwd) {
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(join(cwd, '.dsh-jira.json'), 'utf8'))
  } catch {}
  const fields = raw && typeof raw.fields === 'object' && raw.fields !== null ? raw.fields : {}
  return {
    base: typeof raw.base === 'string' && raw.base.trim() ? raw.base.trim() : DEFAULTS.base,
    branch: typeof raw.branch === 'string' && raw.branch.trim() ? raw.branch.trim() : DEFAULTS.branch,
    worktree: raw.worktree === true,
    allowDirty: raw.allowDirty === true,
    downloadAttachments: raw.downloadAttachments !== false,
    provider: raw.provider === 'github' || raw.provider === 'gitlab' ? raw.provider : '',
    fields: Object.fromEntries(
      Object.entries(fields).filter(([, value]) => typeof value === 'string' && value.trim().length > 0),
    ),
  }
}

/** Lowercase, hyphenated summary fragment for a branch name. */
export function slugify(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/^-|-$/g, '')
}

/** Expand `{key}` and `{slug}` in the configured branch template. */
export function branchName(config, key, summary) {
  const name = config.branch
    .replace(/\{key\}/g, key)
    .replace(/\{slug\}/g, slugify(summary))
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
  return name || key
}

/** The ticket key inside a branch name (`feature/QUBE-123-fix` → `QUBE-123`). */
export function keyFromBranch(branch) {
  const match = /([A-Z][A-Z0-9_]*-\d+)/.exec(String(branch ?? ''))
  return match ? match[1] : ''
}
