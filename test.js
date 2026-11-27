/**
 * Self-check for the host half: branch prep + ticket hand-off, offline.
 * Run: node test.js   (needs git; no network — fetch is stubbed)
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'
import { baseBranch, ensureWorktree, findTicketWorktree } from './lib/git.js'
import { renderIssue } from './lib/jira.js'
import { downloadAttachments } from './lib/attachments.js'
import { branchName, keyFromBranch, repoConfig } from './lib/repo.js'
import { buildRequestBody, commitTicketChanges, extractSection, parseRemote, parseTargets } from './lib/requests.js'

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
let lastCommentUrl
globalThis.fetch = async (url, init) => {
  lastRequest = { url, init }
  if (url.includes('/comment?')) {
    lastCommentUrl = url
    return { ok: true, json: async () => ({ total: 1, comments: issue.fields.comment.comments }) }
  }
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
assert.equal(registered.commands['jira-check'].name, 'jira-check')
assert.equal(registered.commands['jira-comment'].name, 'jira-comment')
assert.equal(registered.commands['jira-mr'].name, 'jira-mr')
assert.equal(registered.commands['jira-pr'].name, 'jira-pr')
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
assert.match(lastCommentUrl, /\/rest\/api\/3\/issue\/QUBE-1\/comment\?/)
assert.match(lastCommentUrl, /startAt=0&maxResults=100/)
assert.equal(lastRequest.init.headers.authorization, 'Bearer blob')

// /jira-check names the token's account and its visible projects, and turns a 401 into one clear fix.
globalThis.fetch = async (url) => url.endsWith('/myself')
  ? { ok: true, json: async () => ({ displayName: 'Angelo Madara', emailAddress: 'a@example.com', accountId: 'acc-1' }) }
  : { ok: true, json: async () => ({ total: 2, values: [{ key: 'QUBE', name: 'QMS' }, { key: 'OPS', name: 'Ops' }] }) }
const check = await registered.commands['jira-check'].handler({})
assert.equal(check.kind, 'success')
assert.match(check.text, /Angelo Madara/)
assert.match(check.text, /Visible projects \(2\): QUBE — QMS, OPS — Ops/)

globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'denied' })
const checkFail = await registered.commands['jira-check'].handler({})
assert.equal(checkFail.kind, 'error')
assert.match(checkFail.text, /rejected the credentials/)

// JQL search: compact list from the tool and the command.
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    total: 2,
    issues: [
      { key: 'QUBE-1', fields: { summary: 'Kiosk shows a stale total', status: { name: 'In Progress' }, assignee: { displayName: 'Angelo' }, issuetype: { name: 'Bug' } } },
      { key: 'QUBE-9', fields: { summary: 'Other issue', status: { name: 'To Do' }, assignee: null, issuetype: { name: 'Task' } } },
    ],
  }),
})
const found = await registered.tools.jira_search.execute({ jql: 'project = QUBE', maxResults: 10 })
assert.match(found.text, /QUBE-1 \[In Progress\] Kiosk shows a stale total — Angelo/)
assert.match(found.text, /QUBE-9 \[To Do\] Other issue — unassigned/)
const findCmd = await registered.commands['jira-find'].handler({ rawInput: 'project = QUBE' })
assert.equal(findCmd.kind, 'success')
assert.match(findCmd.text, /2 issue\(s\) for: project = QUBE/)

// Transitions: list, apply by destination status, and the command.
let transitionPost
globalThis.fetch = async (url, init) => {
  if (init?.method === 'POST') {
    transitionPost = JSON.parse(init.body)
    return { ok: true, status: 204, text: async () => '' }
  }
  return {
    ok: true,
    json: async () => ({
      transitions: [
        { id: '31', name: 'In Review', to: { name: 'In Review' } },
        { id: '41', name: 'Done', to: { name: 'Done' } },
      ],
    }),
  }
}
const listed = await registered.tools.jira_transition.execute({ key: 'QUBE-1' })
assert.match(listed.text, /In Review → In Review/)
const moved = await registered.tools.jira_transition.execute({ key: 'QUBE-1', status: 'Done' })
assert.match(moved.text, /Moved QUBE-1 via "Done" to Done/)
assert.deepEqual(transitionPost, { transition: { id: '41' } })
const cmdMove = await registered.commands['jira-transition'].handler({ rawInput: 'QUBE-1 In Review' })
assert.equal(cmdMove.kind, 'success')
assert.match(cmdMove.text, /Moved QUBE-1 via "In Review"/)

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

// Markdown comments: bold, inline code, lists, fenced code and links.
await registered.tools.jira_comment.execute({ key: 'QUBE-1', body: '**Bold** and `code`\n\n- one\n- two\n\n```js\nconst x = 1\n```\n\n[link](https://example.com)' })
const markdown = JSON.parse(lastRequest.init.body).body
assert.equal(markdown.content[0].content[0].marks[0].type, 'strong')
assert.equal(markdown.content[0].content[2].marks[0].type, 'code')
assert.equal(markdown.content[1].type, 'bulletList')
assert.equal(markdown.content[1].content.length, 2)
assert.equal(markdown.content[2].type, 'codeBlock')
assert.equal(markdown.content[2].attrs.language, 'js')
assert.equal(markdown.content[3].content[0].marks[0].type, 'link')

// A screenshot is uploaded, then embedded as a media node in the comment.
const imagePath = join(mkdtempSync(join(tmpdir(), 'jira-image-')), 'shot.png')
writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=', 'base64'))
let imageBody
globalThis.fetch = async (url, init) => {
  lastRequest = { url, init }
  if (url.endsWith('/attachments')) {
    return { ok: true, json: async () => ([{ id: '77', filename: 'shot.png', mediaType: 'image/png' }]) }
  }
  if (url.includes('/attachment/content/77')) {
    return {
      status: 303,
      url,
      headers: new Headers({ location: 'https://api.media.atlassian.com/file/11111111-1111-1111-1111-111111111111/binary?token=x' }),
    }
  }
  imageBody = JSON.parse(init.body).body
  return { ok: true, json: async () => ({ id: '10004' }) }
}
const imageComment = await registered.tools.jira_comment.execute({ key: 'QUBE-1', body: 'Screenshot', attachments: [imagePath] })
assert.equal(imageComment.id, '10004')
const media = imageBody.content.find((block) => block.type === 'mediaSingle')
assert.equal(media.content[0].attrs.id, '11111111-1111-1111-1111-111111111111')
assert.equal(media.content[0].attrs.type, 'file')

await assert.rejects(() => registered.tools.jira_comment.execute({ key: 'QUBE-1', body: '  ' }), /body` or `attachments` is required/)

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

// A dirty tracked tree blocks /jira-do before it switches branches.
globalThis.fetch = async (url) => url.includes('/comment?')
  ? { ok: true, json: async () => ({ total: 0, comments: [] }) }
  : { ok: true, json: async () => issue }
const dirty = await registered.commands['jira-do'].handler({ rawInput: 'QUBE-3', agent })
assert.equal(dirty.kind, 'error')
assert.match(dirty.text, /tracked changes/)
assert.equal(execFileSync('git', ['branch', '--list', 'QUBE-3'], { cwd, encoding: 'utf8' }).trim(), '')

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
assert.deepEqual(client.inject, ['slots', 'remote', 'remote.credentials', 'remote.commands', 'uiSession'])
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

// PR/MR helpers: remote parsing and the structured description.
assert.deepEqual(parseRemote('https://gitlab.aique.cloud/group/repo.git'), { host: 'gitlab.aique.cloud', path: 'group/repo' })
assert.deepEqual(parseRemote('git@github.com:owner/repo.git'), { host: 'github.com', path: 'owner/repo' })
const report = '## Root cause\nThe cache key ignored the DB.\n\n## Test plan\n- run node test.js\n\n## Risks\nNone.'
assert.equal(extractSection(report, ['test plan']), '- run node test.js')
const prBody = buildRequestBody({ key: 'QUBE-1', summary: 'Fix it', site: 'https://example.atlassian.net', branch: 'QUBE-1', target: 'dev', report })
assert.match(prBody, /\[QUBE-1 — Fix it\]\(https:\/\/example\.atlassian\.net\/browse\/QUBE-1\)/)
assert.match(prBody, /The cache key ignored the DB\./)
assert.match(prBody, /- run node test\.js/)
assert.match(prBody, /\*\*Branch:\*\* `QUBE-1` → `dev`/)

// One command can target several branches.
assert.deepEqual(parseTargets('', 'dev'), ['dev'])
assert.deepEqual(parseTargets(' dev  staging main ', 'dev'), ['dev', 'staging', 'main'])
assert.deepEqual(parseTargets('dev dev', 'dev'), ['dev'])
assert.throws(() => parseTargets('dev;rm', 'dev'), /invalid target/)

// Auto-commit: tracked changes + the ticket report, but not unrelated untracked files.
const autoDir = mkdtempSync(join(tmpdir(), 'jira-auto-'))
const autoGit = (...args) => execFileSync('git', args, { cwd: autoDir, encoding: 'utf8' })
autoGit('init', '-q', '-b', 'main')
autoGit('config', 'user.email', 'test@example.com')
autoGit('config', 'user.name', 'test')
writeFileSync(join(autoDir, 'app.js'), 'old\n')
autoGit('add', '.')
autoGit('commit', '-qm', 'init')
writeFileSync(join(autoDir, 'app.js'), 'new\n')
mkdirSync(join(autoDir, 'docs', 'jira'), { recursive: true })
writeFileSync(join(autoDir, 'docs', 'jira', 'QUBE-9.md'), '# report\n')
writeFileSync(join(autoDir, 'other.txt'), 'x\n')
const autoCommit = commitTicketChanges(autoDir, 'QUBE-9: test summary')
assert.match(autoCommit, /^[0-9a-f]{7,}$/)
assert.equal(autoGit('log', '-1', '--format=%s').trim(), 'QUBE-9: test summary')
assert.equal(autoGit('status', '--porcelain').trim(), '')
assert.equal(commitTicketChanges(autoDir, 'again'), '')

// Repo config: base, branch template and custom field ids.
const configDir = mkdtempSync(join(tmpdir(), 'jira-config-'))
assert.equal(baseBranch(configDir), 'dev')
writeFileSync(join(configDir, '.dsh-jira.json'), JSON.stringify({
  base: 'develop',
  branch: 'feature/{key}-{slug}',
  fields: { acceptanceCriteria: 'customfield_10001' },
}))
const repo = repoConfig(configDir)
assert.equal(repo.base, 'develop')
assert.equal(branchName(repo, 'QUBE-1', 'Fix the total!'), 'feature/QUBE-1-fix-the-total')
assert.equal(keyFromBranch('feature/QUBE-1-fix-the-total'), 'QUBE-1')
assert.equal(repo.fields.acceptanceCriteria, 'customfield_10001')

// Rich ticket rendering: components, fix versions, environment, subtasks, attachments, custom fields.
const rich = renderIssue({
  key: 'QUBE-2',
  fields: {
    summary: 'Rich ticket',
    issuetype: { name: 'Bug' },
    status: { name: 'To Do' },
    components: [{ name: 'API' }, { name: 'Web' }],
    fixVersions: [{ name: '1.2' }],
    environment: 'Staging',
    subtasks: [{ key: 'QUBE-3', fields: { summary: 'Sub' } }],
    attachment: [{ id: '9', filename: 'log.txt', size: 2048 }],
    customfield_10001: 'Must be fast',
    customfield_10002: 3,
  },
}, { acceptanceCriteria: 'customfield_10001', storyPoints: 'customfield_10002' })
assert.match(rich, /Components: API, Web/)
assert.match(rich, /Fix versions: 1.2/)
assert.match(rich, /Environment: Staging/)
assert.match(rich, /Subtasks: QUBE-3 Sub/)
assert.match(rich, /Attachments: log.txt \(2 KB\)/)
assert.match(rich, /Acceptance criteria: Must be fast/)
assert.match(rich, /Story points: 3/)

// Attachments land under docs/jira/<KEY>/ and never escape it via the filename.
const attachDir = mkdtempSync(join(tmpdir(), 'jira-attach-'))
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })
const downloaded = await downloadAttachments(
  { site: 'https://example.atlassian.net', authorization: 'Basic x' },
  { fields: { attachment: [{ id: '9', filename: '../evil.txt', size: 3, content: 'https://example.atlassian.net/secure/attachment/9/evil.txt' }] } },
  attachDir,
  'QUBE-2',
)
assert.equal(downloaded.files.length, 1)
assert.ok(existsSync(join(attachDir, 'docs', 'jira', 'QUBE-2', '9-evil.txt')))

// Worktree mode creates the tree without switching the current checkout, then cleans up.
const worktree = ensureWorktree(cwd, 'QUBE-7', 'dev')
assert.ok(existsSync(worktree))
assert.equal(findTicketWorktree(cwd, 'QUBE-7')?.path, worktree)
assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim(), 'QUBE-1')
execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd })
execFileSync('git', ['branch', '-D', 'QUBE-7'], { cwd })

console.log('ok — command, branch, hand-off, tools, comments, client registration')
