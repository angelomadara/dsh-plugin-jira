/** Git helpers for the ticket branch flow. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Run git in the session cwd and return trimmed stdout. */
export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function gitError(error) {
  return String(error?.stderr ?? error?.message ?? error).trim()
}

/** The repo's base branch from `.dsh-jira.json` (`{ "base": "develop" }`), default `dev`. */
export function baseBranch(cwd) {
  try {
    const config = JSON.parse(readFileSync(join(cwd, '.dsh-jira.json'), 'utf8'))
    if (typeof config.base === 'string' && config.base.trim()) return config.base.trim()
  } catch {}
  return 'dev'
}

/** base + pull + KEY, reporting every step so the command reply shows what happened. */
export function prepareBranch(cwd, key, base = baseBranch(cwd)) {
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

/** The ticket branch's changes: committed since the base branch, plus the working tree. */
export function branchChanges(cwd, key, base = baseBranch(cwd)) {
  const branch = git(cwd, ['branch', '--show-current'])
  if (branch !== key) {
    throw new Error(`Jira: ${key} is not the current branch (${branch || 'detached HEAD'}); check it out or pass comment text.`)
  }
  // The default `dev` keeps the historical dev/main/master fallback; a configured base must exist.
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
  const committed = git(cwd, ['diff', `${resolved}...HEAD`])
  const working = git(cwd, ['diff', 'HEAD'])
  const status = git(cwd, ['status', '--porcelain'])
  return { base: resolved, diff: [committed, working].filter(Boolean).join('\n'), status }
}
