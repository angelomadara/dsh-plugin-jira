/** Git helpers for the ticket branch flow. */
import { execFileSync } from 'node:child_process'

/** Run git in the session cwd and return trimmed stdout. */
export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function gitError(error) {
  return String(error?.stderr ?? error?.message ?? error).trim()
}

/** dev + pull + KEY, reporting every step so the command reply shows what happened. */
export function prepareBranch(cwd, key) {
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

/** The ticket branch's changes: committed since the base branch, plus the working tree. */
export function branchChanges(cwd, key) {
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
