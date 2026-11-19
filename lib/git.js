/** Git helpers for the ticket branch flow. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { keyFromBranch, repoConfig } from './repo.js'

const WORKTREE_ROOT = '.dsh-jira-worktrees'

/** Run git in the given directory and return trimmed stdout. */
export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function gitError(error) {
  return String(error?.stderr ?? error?.message ?? error).trim()
}

/** The repo's base branch from `.dsh-jira.json`, default `dev`. */
export function baseBranch(cwd) {
  return repoConfig(cwd).base
}

/** Tracked modifications only; untracked files do not conflict with a branch switch. */
export function isDirty(cwd) {
  return git(cwd, ['status', '--porcelain', '--untracked-files=no']).length > 0
}

export function branchExists(cwd, branch) {
  try {
    git(cwd, ['rev-parse', '--verify', '--quiet', branch])
    return true
  } catch {
    return false
  }
}

/** base + pull + branch, reporting every step; `existing` says whether the branch was reused. */
export function prepareBranch(cwd, branch, base = baseBranch(cwd)) {
  const log = []
  try {
    git(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    throw new Error(`Jira: ${cwd} is not a git repository.`)
  }
  try {
    git(cwd, ['checkout', base])
    log.push(`checked out ${base}`)
  } catch (error) {
    throw new Error(`Jira: could not check out ${base} — ${gitError(error)}`)
  }
  try {
    git(cwd, ['pull', '--ff-only'])
    log.push(`pulled ${base}`)
  } catch (error) {
    log.push(`pull skipped (${gitError(error).split('\n')[0]})`)
  }
  let existing = branchExists(cwd, branch)
  if (existing) {
    try {
      git(cwd, ['checkout', branch])
      log.push(`branch ${branch} already existed, checked out`)
    } catch (error) {
      throw new Error(`Jira: could not check out ${branch} — ${gitError(error)}`)
    }
  } else {
    try {
      git(cwd, ['checkout', '-b', branch])
      log.push(`created branch ${branch}`)
    } catch (error) {
      try {
        git(cwd, ['checkout', branch])
        existing = true
        log.push(`branch ${branch} already existed, checked out`)
      } catch {
        throw new Error(`Jira: could not create branch ${branch} — ${gitError(error)}`)
      }
    }
  }
  return { log, existing }
}

function worktreeEntries(cwd) {
  try {
    const lines = git(cwd, ['worktree', 'list', '--porcelain']).split('\n')
    const entries = []
    let current = { path: '', branch: '' }
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        if (current.path) entries.push(current)
        current = { path: line.slice('worktree '.length), branch: '' }
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      }
    }
    if (current.path) entries.push(current)
    return entries
  } catch {
    return []
  }
}

/** The path of a worktree already holding `branch`, or ''. */
export function worktreeFor(cwd, branch) {
  return worktreeEntries(cwd).find((entry) => entry.branch === branch)?.path ?? ''
}

/** The worktree for a ticket key (branch may be `feature/KEY-slug`), or null. */
export function findTicketWorktree(cwd, key) {
  return worktreeEntries(cwd).find((entry) => entry.branch && keyFromBranch(entry.branch) === key) ?? null
}

/** Ticket keys currently checked out in worktrees. */
export function worktreeKeys(cwd) {
  return worktreeEntries(cwd).map((entry) => keyFromBranch(entry.branch)).filter(Boolean)
}

/** Add `.dsh-jira-worktrees/` to the repo's local exclude file, once. */
function excludeWorktrees(cwd) {
  try {
    const relative = git(cwd, ['rev-parse', '--git-path', 'info/exclude'])
    const file = isAbsolute(relative) ? relative : join(cwd, relative)
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (!text.includes(`${WORKTREE_ROOT}/`)) appendFileSync(file, `\n# dsh-plugin-jira\n${WORKTREE_ROOT}/\n`)
  } catch {}
}

/** Create (or reuse) a worktree for the ticket branch without touching the current checkout. */
export function ensureWorktree(cwd, branch, base = baseBranch(cwd)) {
  const existing = worktreeFor(cwd, branch)
  if (existing) return existing
  excludeWorktrees(cwd)
  const path = join(cwd, WORKTREE_ROOT, branch.replace(/\//g, '-'))
  if (branchExists(cwd, branch)) git(cwd, ['worktree', 'add', path, branch])
  else git(cwd, ['worktree', 'add', '-b', branch, path, base])
  return worktreeFor(cwd, branch) || path
}

/** The ticket's changes: committed since the base branch, plus its working tree. */
export function branchChanges(cwd, key, base = baseBranch(cwd)) {
  const worktree = findTicketWorktree(cwd, key)
  const path = worktree?.path ?? cwd
  const branch = worktree?.branch ?? git(cwd, ['branch', '--show-current'])
  if (keyFromBranch(branch) !== key) {
    throw new Error(`Jira: ${key} is not the current branch (${branch || 'detached HEAD'}); check it out or pass comment text.`)
  }
  const candidates = base === 'dev' ? ['dev', 'main', 'master'] : [base]
  let resolved = ''
  for (const candidate of candidates) {
    try {
      git(cwd, ['rev-parse', '--verify', '--quiet', candidate])
      resolved = candidate
      break
    } catch {}
  }
  if (!resolved) throw new Error(`Jira: base branch "${base}" not found.`)
  const committed = git(path, ['diff', `${resolved}...HEAD`])
  const working = git(path, ['diff', 'HEAD'])
  const status = git(path, ['status', '--porcelain'])
  return { base: resolved, branch, path, worktree: Boolean(worktree), diff: [committed, working].filter(Boolean).join('\n'), status }
}
