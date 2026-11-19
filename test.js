/**
 * Self-check for the host half: branch prep + ticket hand-off, offline.
 * Run: node test.js   (needs git; no network — fetch is stubbed)
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
let lastRequest
globalThis.fetch = async (url, init) => {
  lastRequest = { url, init }
  return { ok: true, json: async () => issue }
}

const registered = { commands: {}, tools: {} }
const sent = []
const ctx = {
  commands: { register: (definition) => { registered.commands[definition.name] = definition } },
  tools: { register: (definition) => { registered.tools[definition.name] = definition } },
  credentials: {
    resolve: async (ref) => ({ value: { JIRA_SITE: 'https://example.atlassian.net', JIRA_API_TOKEN: 'blob' }[ref] }),
  },
}
apply(ctx)
assert.equal(registered.commands['jira-do'].name, 'jira-do')
assert.equal(registered.commands['jira-comment'].name, 'jira-comment')
assert.equal(registered.tools.jira_ticket.name, 'jira_ticket')
assert.equal(registered.tools.jira_comment.name, 'jira_comment')

const agent = { session: { header: { cwd } }, followup: (message) => sent.push(message) }
const ok = await registered.commands['jira-do'].handler({ rawInput: ' QUBE-1 ', agent })
assert.equal(ok.kind, 'success', ok.text)
assert.match(ok.text, /created branch QUBE-1/)
assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim(), 'QUBE-1')
assert.equal(sent.length, 1)
assert.equal(sent[0].role, 'user')
assert.match(sent[0].content[0].text, /QUBE-1 — Kiosk shows a stale total/)
assert.match(sent[0].content[0].text, /Reproduced on staging/)
assert.match(sent[0].content[0].text, /full change report/)
assert.match(sent[0].content[0].text, /docs\/jira\/QUBE-1\.md/)
assert.match(sent[0].content[0].text, /https:\/\/example\.atlassian\.net\/browse\/QUBE-1/)

const bad = await registered.commands['jira-do'].handler({ rawInput: 'nope', agent })
assert.equal(bad.kind, 'error')

const tool = await registered.tools.jira_ticket.execute({ key: 'qube-1' })
assert.equal(tool.key, 'QUBE-1')
assert.match(tool.text, /After a discount the total is wrong/)
assert.match(lastRequest.url, /\/rest\/api\/3\/issue\/QUBE-1\?/)
assert.equal(lastRequest.init.headers.authorization, 'Bearer blob')

// Comments go out as ADF on the v3 comment endpoint.
globalThis.fetch = async (url, init) => {
  lastRequest = { url, init }
  return { ok: true, json: async () => ({ id: '10001' }) }
}
const comment = await registered.tools.jira_comment.execute({ key: 'qube-1', body: 'Fixed the total.\n\nTests pass.' })
assert.equal(comment.key, 'QUBE-1')
assert.equal(comment.id, '10001')
assert.match(comment.url, /\/browse\/QUBE-1\?focusedCommentId=10001$/)
assert.equal(lastRequest.init.method, 'POST')
assert.match(lastRequest.url, /\/rest\/api\/3\/issue\/QUBE-1\/comment$/)
assert.equal(lastRequest.init.headers['content-type'], 'application/json')
const adf = JSON.parse(lastRequest.init.body).body
assert.equal(adf.type, 'doc')
assert.equal(adf.content.length, 2)
assert.deepEqual(adf.content[0].content, [{ type: 'text', text: 'Fixed the total.' }])

await assert.rejects(() => registered.tools.jira_comment.execute({ key: 'QUBE-1', body: '  ' }), /must not be empty/)

// /jira-comment takes the key from the current branch when the input does not name one.
const inferred = await registered.commands['jira-comment'].handler({ rawInput: 'Progress update', agent })
assert.equal(inferred.kind, 'success')
assert.match(inferred.text, /Commented on QUBE-1/)
assert.match(lastRequest.url, /\/issue\/QUBE-1\/comment$/)
const explicit = await registered.commands['jira-comment'].handler({ rawInput: 'OTHER-2 Hello there', agent })
assert.equal(explicit.kind, 'success')
assert.match(lastRequest.url, /\/issue\/OTHER-2\/comment$/)

// Without comment text the agent gets the ticket branch's changes to analyze.
writeFileSync(join(cwd, 'README.md'), 'x\nnew line\n')
const summarized = await registered.commands['jira-comment'].handler({ rawInput: 'QUBE-1', agent })
assert.equal(summarized.kind, 'success')
assert.match(summarized.text, /Handed QUBE-1/)
assert.equal(sent.length, 2)
assert.match(sent[1].content[0].text, /Analyze ALL the file changes/)
assert.match(sent[1].content[0].text, /new line/)
const inferredEmpty = await registered.commands['jira-comment'].handler({ rawInput: '', agent })
assert.equal(inferredEmpty.kind, 'success')
assert.equal(sent.length, 3)
const wrongBranch = await registered.commands['jira-comment'].handler({ rawInput: 'OTHER-2', agent })
assert.equal(wrongBranch.kind, 'error')
assert.match(wrongBranch.text, /not the current branch/)

// A ticket that Jira will not return must not leave a new branch behind; a rejected token is named as such.
globalThis.fetch = async (url) => url.endsWith('/myself')
  ? { ok: false, status: 401, text: async () => '' }
  : { ok: false, status: 404, text: async () => 'Issue does not exist' }
const missing = await registered.commands['jira-do'].handler({ rawInput: 'QUBE-2', agent })
assert.equal(missing.kind, 'error')
assert.match(missing.text, /Jira fetch failed: Jira 404/)
assert.match(missing.text, /rejected the credentials/)
assert.equal(execFileSync('git', ['branch', '--list', 'QUBE-2'], { cwd, encoding: 'utf8' }).trim(), '')
assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim(), 'QUBE-1')

// The browser half must register its page into the real settings slot when loaded.
let bundle
globalThis.window = { __ModuleLoader__: { load: (definition) => { bundle = definition } } }
const React = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (callback) => callback,
}
new Function('window', 'require', readFileSync(new URL('./client.js', import.meta.url), 'utf8'))(globalThis.window, () => React)
assert.equal(bundle.id, 'dsh-plugin-jira')
const client = bundle.factory(() => React)
assert.deepEqual(client.inject, ['slots', 'remote', 'remote.credentials'])
let registration
client.apply({
  effect: (fn) => { const dispose = fn(); return () => dispose?.() },
  slots: {
    inject: (_name, callback) => callback(),
    register: (spec, component) => { registration = { spec, component }; return () => {} },
  },
  remote: { credentials: {} },
})
assert.equal(registration.spec.name, 'settings.section')
assert.equal(registration.spec.id, 'jira')
assert.equal(registration.spec.label(), 'Jira')
assert.equal(typeof registration.component, 'function')

console.log('ok — command, branch, hand-off, tools, comments, client registration')
