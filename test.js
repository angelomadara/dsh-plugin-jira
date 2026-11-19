/**
 * Self-check for the host half: branch prep + ticket hand-off, offline.
 * Run: node test.js   (needs git; no network — fetch is stubbed)
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'

const cwd = mkdtempSync(join(tmpdir(), 'jira-plugin-'))
const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' })
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'test@example.com')
git('config', 'user.name', 'test')
writeFileSync(join(cwd, 'README.md'), 'x\n')
git('add', '.')
git('commit', '-qm', 'init')
git('branch', 'dev')

const issue = {
  key: 'QUBE-1',
  fields: {
    summary: 'Kiosk shows a stale total',
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'After a discount the total is wrong.' }] }] },
    status: { name: 'In Progress' },
    issuetype: { name: 'Bug' },
    comment: { comments: [{ author: { displayName: 'Krian' }, created: '2026-11-01T10:00:00Z', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reproduced on staging.' }] }] } }] },
  },
}
globalThis.fetch = async () => ({ ok: true, json: async () => issue })

const registered = {}
const sent = []
const ctx = {
  commands: { register: (definition) => { registered.command = definition } },
  tools: { register: (definition) => { registered.tool = definition } },
  credentials: {
    resolve: async (ref) => ({ value: { JIRA_SITE: 'https://example.atlassian.net', JIRA_API_TOKEN: 'blob' }[ref] }),
  },
}
apply(ctx)
assert.equal(registered.command.name, 'jira-do')
assert.equal(registered.tool.name, 'jira_ticket')

const agent = { session: { header: { cwd } }, followup: (message) => sent.push(message) }
const ok = await registered.command.handler({ rawInput: ' QUBE-1 ', agent })
assert.equal(ok.kind, 'success', ok.text)
assert.match(ok.text, /created branch QUBE-1/)
assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim(), 'QUBE-1')
assert.equal(sent.length, 1)
assert.equal(sent[0].role, 'user')
assert.match(sent[0].content[0].text, /QUBE-1 — Kiosk shows a stale total/)
assert.match(sent[0].content[0].text, /Reproduced on staging/)

const bad = await registered.command.handler({ rawInput: 'nope', agent })
assert.equal(bad.kind, 'error')

const tool = await registered.tool.execute({ key: 'qube-1' })
assert.equal(tool.key, 'QUBE-1')
assert.match(tool.text, /After a discount the total is wrong/)

console.log('ok — command, branch, hand-off, tool')
