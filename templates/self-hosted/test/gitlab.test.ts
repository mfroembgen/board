import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { beforeEach, mock, test } from 'node:test'
import { syncFromEnv, type SyncOptions } from '../src/sync.ts'
import { asAda, board, channel, eventually, inbox, thread, until, URL_, type App } from './sync-board.ts'

const GITLAB_API = 'https://gitlab.test/api/v4'
const SECRET = 'gitlab-webhook-secret'
const MR_URL = 'https://gitlab.test/acme/platform/web/-/merge_requests'

const projectOf = (id: number, path: string) => ({ id, name: path.split('/').pop(), path_with_namespace: path, web_url: `https://gitlab.test/${path}` })
const person = (username: string) => ({ id: username.length, name: username, username, avatar_url: null })

function mergeRequestItem(iid: number, extra: Record<string, unknown> = {}) {
  return {
    iid,
    title: 'Ship the export page',
    state: 'opened',
    draft: false,
    sha: 'a1b2c3d4e5f6a7b8',
    head_pipeline: { id: 300, status: 'running', sha: 'a1b2c3d4e5f6a7b8' },
    web_url: `${MR_URL}/${iid}`,
    references: { full: `acme/platform/web!${iid}` },
    author: { id: 6, username: 'bo', name: 'Bo' },
    ...extra,
  }
}

const issueItem = (extra: Record<string, unknown> = {}) => ({
  iid: 3,
  title: 'Export page is blank',
  state: 'opened',
  web_url: 'https://gitlab.test/acme/platform/web/-/issues/3',
  references: { full: 'acme/platform/web#3' },
  author: { id: 5, username: 'ada', name: 'Ada' },
  ...extra,
})

let api: Record<string, unknown> = {}
const posted: string[] = []
const bodies: string[] = []
const logged: string[] = []
const info = console.info.bind(console)
mock.method(console, 'info', (...args: unknown[]) => {
  logged.push(args.join(' '))
  info(...args)
})
beforeEach(() => {
  api = {
    '/user': { id: 99, username: 'board', name: 'Board' },
    '/projects/42': projectOf(42, 'acme/platform/web'),
    '/projects/50': projectOf(50, 'acme/hiring/pipeline'),
    '/projects/77': projectOf(77, 'acme/forks/web'),
    '/projects/42/merge_requests/7': mergeRequestItem(7),
    '/projects/42/merge_requests/7/approvals': { approved: false },
    '/projects/42/merge_requests/8': mergeRequestItem(8),
    '/projects/42/issues/3': issueItem(),
  }
  posted.length = 0
  bodies.length = 0
})
const setItem = (path: string, extra: Record<string, unknown>) => void (api[path] = { ...(api[path] as object), ...extra })

mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.startsWith(GITLAB_API)) return new Response('not found', { status: 404 })
  const path = new URL(url).pathname.slice(new URL(GITLAB_API).pathname.length)
  if ((init?.method ?? 'GET') !== 'GET') {
    posted.push(path)
    bodies.push(String(init?.body ?? ''))
    return Response.json({ id: 5000 + posted.length, body: '', author: { id: 99, username: 'board', name: 'Board' }, created_at: '2026-11-27T11:00:00Z', updated_at: '2026-11-27T11:00:00Z', system: false, type: null }, { status: 201 })
  }
  const found = typeof api[path] === 'function' ? (api[path] as () => unknown)() : api[path]
  return found ? Response.json(found) : new Response('not found', { status: 404 })
})

const gitlabSync = (excludedPaths: string[] = []): SyncOptions['gitlab'] => ({ token: 'glpat-test', webhookSecret: SECRET, apiUrl: GITLAB_API, excludedPaths })

const gitlabHook = (app: App, event: string, body: unknown, token = SECRET) =>
  app(new Request(`${URL_}/webhooks/gitlab`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gitlab-event': event, 'x-gitlab-token': token, 'idempotency-key': randomUUID() },
    body: JSON.stringify(body),
  }))

function note(id: number, discussion: string, text: string, options: { path?: string; projectId?: number; iid?: number; email?: string } = {}) {
  const path = options.path ?? 'acme/platform/web'
  const projectId = options.projectId ?? 42
  return {
    object_kind: 'note',
    event_type: 'note',
    user: { id: 5, name: 'Ada', username: 'ada', avatar_url: null, email: options.email ?? '[REDACTED]' },
    project_id: projectId,
    project: projectOf(projectId, path),
    object_attributes: {
      id,
      note: text,
      noteable_type: 'MergeRequest',
      author_id: 5,
      created_at: '2026-11-27T10:00:00Z',
      updated_at: '2026-11-27T10:00:00Z',
      system: false,
      type: null,
      action: 'create',
      internal: false,
      discussion_id: discussion,
    },
    merge_request: { id: 900, iid: options.iid ?? 7, title: 'Ship the export page' },
  }
}

function mergeRequest(action: string, extra: { by?: string; iid?: number; oldrev?: string; changes?: object; path?: string; source?: string; state?: string } = {}) {
  const iid = extra.iid ?? 7
  const path = extra.path ?? 'acme/platform/web'
  return {
    object_kind: 'merge_request',
    user: person(extra.by ?? 'bo'),
    project: projectOf(42, path),
    object_attributes: {
      iid,
      title: 'Ship the export page',
      url: `${MR_URL}/${iid}`,
      action,
      state: extra.state ?? 'opened',
      last_commit: { id: 'a1b2c3d4e5f6a7b8' },
      source: { path_with_namespace: extra.source ?? path },
      target: { path_with_namespace: path },
      ...(extra.oldrev ? { oldrev: extra.oldrev } : {}),
    },
    changes: extra.changes ?? {},
  }
}

function issue(action: string, by = 'ada') {
  return {
    object_kind: 'issue',
    user: person(by),
    project: projectOf(42, 'acme/platform/web'),
    object_attributes: { iid: 3, title: 'Export page is blank', url: 'https://gitlab.test/acme/platform/web/-/issues/3', action },
    changes: {},
  }
}

function pipeline(id: number, status: string, options: { project?: { id: number; path: string }; target?: number; iid?: number; variables?: object[] } = {}) {
  const project = options.project ?? { id: 42, path: 'acme/platform/web' }
  const iid = options.iid ?? 7
  return {
    object_kind: 'pipeline',
    user: person('bo'),
    project: projectOf(project.id, project.path),
    object_attributes: { id, status, sha: 'a1b2c3d4e5f6a7b8', url: `https://gitlab.test/${project.path}/-/pipelines/${id}`, variables: options.variables ?? [] },
    merge_request: { iid, url: `${MR_URL}/${iid}`, state: 'opened', source_project_id: project.id, target_project_id: options.target ?? project.id },
  }
}

const mergeRequestRoot = (app: App, iid = 7) =>
  eventually(async () => (await channel(app, 'gitlab/platform')).find((message) => message.re === null && message.labels.mr === `acme/platform/web!${iid}`))
const mirrored = ({ status: _triage, ...labels }: Record<string, string>) => labels
const repliesOf = (found: { replies: { text: string }[] }) => found.replies.map((reply) => reply.text)

test('each sync entry is on only when its variables are given', async () => {
  const entries = async (env: Record<string, string>) => {
    const discovery = (await (await board(syncFromEnv(env))(new Request(URL_))).json()) as { sync: { key: string }[] }
    return discovery.sync.map((entry) => entry.key).sort()
  }
  const credentials = JSON.stringify({ client_email: 'board@chat.iam.gserviceaccount.com', private_key: 'unused' })

  assert.deepEqual(await entries({}), [])
  assert.deepEqual(await entries({ GITLAB_API_URL: GITLAB_API, GOOGLE_CHAT_PROJECT_NUMBER: '1' }), [])
  assert.deepEqual(await entries({ GITLAB_TOKEN: 't', GITLAB_WEBHOOK_SECRET: 's', GITLAB_API_URL: GITLAB_API }), ['gitlab'])
  assert.deepEqual(await entries({ GOOGLE_CHAT_CREDENTIALS: credentials, GOOGLE_CHAT_PROJECT_NUMBER: '1' }), ['gchat'])
  assert.throws(() => syncFromEnv({ GITLAB_TOKEN: 't' }), /GitLab sync needs GITLAB_WEBHOOK_SECRET, GITLAB_API_URL/)
})

test('a malformed Google Chat key fails the start, naming the variable and not repeating it', () => {
  for (const value of ['{"private_key": "-----BEGIN sekrit', '{"client_email": "sekrit@example.com"}']) {
    assert.throws(
      () => syncFromEnv({ GOOGLE_CHAT_CREDENTIALS: value, GOOGLE_CHAT_PROJECT_NUMBER: '1' }),
      (error: Error) => /GOOGLE_CHAT_CREDENTIALS/.test(error.message) && !error.message.includes('sekrit'),
    )
  }
})

test('a GitLab event named like an object property is answered like any other unknown event', async () => {
  const app = board({ gitlab: gitlabSync() })
  for (const event of ['constructor', 'toString', '__proto__']) assert.equal((await gitlabHook(app, event, mergeRequest('open'))).status, 200)
})

test('a GitLab comment with the webhook secret lands in its subgroup channel, one thread per merge request', async () => {
  const app = board({ gitlab: gitlabSync() })
  assert.equal((await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))).status, 200)
  assert.equal((await gitlabHook(app, 'Note Hook', note(1002, 'd2', 'one more thing'))).status, 200)

  const root = await mergeRequestRoot(app)
  assert.equal(root.text, `MR !7: Ship the export page\n${MR_URL}/7`)
  assert.deepEqual(mirrored(root.labels), { mr: 'acme/platform/web!7', state: 'open', head: 'a1b2c3d4e5f6a7b8' })
  const found = await until(app, root.id, ({ replies }) => replies.length === 2)
  assert.deepEqual(repliesOf(found).sort(), ['looks good', 'one more thing'])
})

test('a GitLab webhook without the secret is refused and stores nothing', async () => {
  const app = board({ gitlab: gitlabSync() })
  assert.equal((await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'), 'wrong')).status, 401)
  assert.deepEqual(await inbox(app, 'gitlab'), [])
})

test('the inbox keeps no pipeline variables or other payload fields the sync does not use', async () => {
  const app = board({ gitlab: gitlabSync() })
  await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good', { email: 'ada-sekrit@example.com' }))
  await gitlabHook(app, 'Pipeline Hook', pipeline(300, 'failed', { variables: [{ key: 'DEPLOY_TOKEN', value: 'glpat-sekrit' }] }))
  const stored = await eventually(async () => {
    const events = await inbox(app, 'gitlab')
    return events.length === 2 ? events : undefined
  })
  assert.doesNotMatch(JSON.stringify(stored), /sekrit|DEPLOY_TOKEN/)
})

test('an excluded namespace is answered and never stored, wherever the payload names it', async () => {
  const app = board({ gitlab: gitlabSync(['acme/hiring']) })
  const hiring = { id: 50, path: 'acme/hiring/pipeline' }
  const sent = [
    await gitlabHook(app, 'Note Hook', note(2001, 'd9', 'candidate notes', { path: hiring.path, projectId: 50 })),
    await gitlabHook(app, 'Merge Request Hook', mergeRequest('open', { path: hiring.path })),
    await gitlabHook(app, 'Merge Request Hook', mergeRequest('open', { source: hiring.path })),
    await gitlabHook(app, 'Pipeline Hook', pipeline(301, 'failed', { project: hiring })),
    await gitlabHook(app, 'Pipeline Hook', pipeline(302, 'failed', { project: { id: 77, path: 'acme/forks/web' }, target: 50 })),
    await gitlabHook(app, 'Pipeline Hook', pipeline(303, 'failed', { project: { id: 77, path: 'acme/forks/web' }, target: 404 })),
  ]
  assert.deepEqual(sent.map((response) => response.status), [200, 200, 200, 200, 200, 200])
  assert.equal((await gitlabHook(app, 'Note Hook', note(2002, 'd9', 'candidate notes', { path: hiring.path, projectId: 50 }), 'wrong')).status, 401)
  assert.equal((await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))).status, 200)
  await mergeRequestRoot(app)
  assert.equal((await inbox(app, 'gitlab')).length, 1)

  const metrics = await (await app(new Request('https://board.test/metrics'))).text()
  assert.match(metrics, /^board_sync_dropped_total\{entry="gitlab",reason="excluded_path"\} 5$/m)
  assert.match(metrics, /^board_sync_dropped_total\{entry="gitlab",reason="unreadable_project"\} 1$/m)
  assert.match(metrics, /^board_sync_dropped_total\{entry="gitlab",reason="unsigned"\} 1$/m)
  assert.match(metrics, /^board_sync_excluded_paths\{entry="gitlab"\} 1$/m)
  assert.ok(logged.some((line) => line === '[board] gitlab dropped: excluded path acme/hiring'))
  assert.ok(!logged.some((line) => line.includes('candidate notes') || line.includes('pipeline')))
})

test('exclusions match namespaces whatever their case', async () => {
  const app = board({ gitlab: gitlabSync(['acme/Hiring']) })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('open', { path: 'acme/hiring/pipeline' }))
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('open', { path: 'acme/HIRING/pipeline' }))
  await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))
  await mergeRequestRoot(app)
  assert.equal((await inbox(app, 'gitlab')).length, 1)
})

test('a board thread attached to a GitLab merge request by hand gets nothing, and one imported from GitLab still does', async () => {
  const app = board({ gitlab: gitlabSync() })
  await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))
  const imported = await mergeRequestRoot(app)
  const own = ((await (await asAda(app, 'POST', '/messages', { channel: 'general', text: 'a plan' })).json()) as { message: { id: string } }).message
  assert.equal((await asAda(app, 'POST', `/messages/${own.id}/sync`, { target: 'gitlab:42:mr:8' })).status, 200)
  assert.equal((await asAda(app, 'POST', `/messages/${imported.id}/sync`, { target: 'gitlab:42:mr:9' })).status, 200)

  await asAda(app, 'POST', '/messages', { re: own.id, text: 'posted by the bot?' })
  await asAda(app, 'POST', '/messages', { re: imported.id, text: 'thanks' })
  await eventually(async () => (posted.some((path) => path.startsWith('/projects/42/merge_requests/7/')) ? true : undefined))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(posted.filter((path) => /\/merge_requests\/(8|9)\//.test(path)), [])
  assert.ok(logged.some((line) => line === '[board] gitlab dropped: unimported target'))
  assert.match(await (await app(new Request('https://board.test/metrics'))).text(), /^board_sync_dropped_total\{entry="gitlab",reason="unimported_target"\} [1-9]/m)
})

test('a project moved into an excluded group gets no more posts from the board', async () => {
  const app = board({ gitlab: gitlabSync(['acme/hiring']) })
  await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))
  const root = await mergeRequestRoot(app)
  await asAda(app, 'POST', '/messages', { re: root.id, text: 'first' })
  await eventually(async () => (bodies.some((body) => body.includes('first')) ? true : undefined))

  api['/projects/42'] = { ...(api['/projects/42'] as object), path_with_namespace: 'acme/hiring/web' }
  await asAda(app, 'POST', '/messages', { re: root.id, text: 'second' })
  await eventually(async () => (logged.includes('[board] gitlab dropped: excluded target acme/hiring') ? true : undefined))
  assert.ok(!bodies.some((body) => body.includes('second')))
})

test('a reply sent to GitLab runs no quick action, whichever line it puts one on', async () => {
  const app = board({ gitlab: gitlabSync() })
  await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))
  const root = await mergeRequestRoot(app)
  await asAda(app, 'POST', '/messages', { re: root.id, text: '/close\nthanks\n  /label ~bug\n\n/approve' })
  const sent = await eventually(async () => bodies.find((body) => body.includes('thanks')))
  const markdown = (JSON.parse(sent) as { body: string }).body
  assert.doesNotMatch(markdown, /^\s*\//m)
  assert.equal(markdown, '**ada**: /close\nthanks\n  \\/label ~bug\n\n\\/approve')

  const reply = (await thread(app, root.id)).replies.find((message) => message.text.startsWith('/close'))!
  await asAda(app, 'POST', `/messages/${reply.id}/edit`, { text: 'thanks\n/merge' })
  const edited = await eventually(async () => bodies.find((body) => body.includes('merge')))
  assert.equal((JSON.parse(edited) as { body: string }).body, '**ada**: thanks\n\\/merge')
})

test('a new thread from GitLab is labelled for triage and announced', async () => {
  const app = board({ gitlab: gitlabSync(), triageChannel: 'triage' })
  const own = ((await (await asAda(app, 'POST', '/messages', { channel: 'gitlab/notes', text: 'written on the board' })).json()) as { message: { id: string } }).message

  await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))
  const root = await eventually(async () => (await channel(app, 'gitlab/platform')).find((message) => message.re === null && message.labels.status))
  assert.equal(root.labels.status, 'triage')
  const announced = await eventually(async () => (await channel(app, 'triage'))[0])
  assert.equal(announced.text, `gitlab/platform #${root.id}: MR !7: Ship the export page`)
  assert.equal((await channel(app, 'gitlab/notes')).find((message) => message.id === own.id)?.labels.status, undefined)
})

test("a merge request's life is one thread: its state, title, approvals and merge, as GitLab has them now", async () => {
  const app = board({ gitlab: gitlabSync() })
  const mr = '/projects/42/merge_requests/7'
  setItem(mr, { draft: true })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('open'))
  const root = await mergeRequestRoot(app)
  assert.equal(root.text, `MR !7: Ship the export page\n${MR_URL}/7`)
  assert.deepEqual(mirrored(root.labels), { mr: 'acme/platform/web!7', state: 'draft', head: 'a1b2c3d4e5f6a7b8' })

  setItem(mr, { draft: false })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('update', { changes: { draft: { previous: true, current: false } } }))
  await until(app, root.id, ({ message }) => message.labels.state === 'open')
  setItem(mr, { title: 'Ship the export page today' })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('update', { changes: { title: { previous: 'Ship the export page', current: 'Ship the export page today' } } }))
  await until(app, root.id, ({ message }) => message.text.startsWith('MR !7: Ship the export page today'))
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('approval', { by: 'ada' }))
  setItem(`${mr}/approvals`, { approved: true })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('approved', { by: 'bo' }))
  await until(app, root.id, ({ message }) => message.labels.review === 'approved')
  setItem(mr, { state: 'merged' })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('merge', { by: 'julian' }))
  const merged = await until(app, root.id, ({ message, replies }) => message.labels.state === 'merged' && replies.length === 3)
  assert.deepEqual(repliesOf(merged), ['approved by ada', 'approved by bo', 'merged by julian'])
  assert.ok(merged.replies.every((reply) => reply.labels.status === undefined))
})

test('a close that arrives after the reopen still says so, and leaves the state GitLab has', async () => {
  const app = board({ gitlab: gitlabSync() })
  const mr = '/projects/42/merge_requests/8'
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('open', { iid: 8 }))
  const root = await mergeRequestRoot(app, 8)
  setItem(mr, { state: 'closed' })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('close', { iid: 8, by: 'ada' }))
  await until(app, root.id, ({ message }) => message.labels.state === 'closed')
  setItem(mr, { state: 'opened', draft: true })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('reopen', { iid: 8, by: 'ada' }))
  await until(app, root.id, ({ message }) => message.labels.state === 'draft')
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('close', { iid: 8, by: 'bo' }))
  const late = await until(app, root.id, ({ replies }) => replies.length === 3)
  assert.deepEqual(repliesOf(late), ['closed by ada', 'reopened by ada', 'closed by bo'])
  assert.equal(late.message.labels.state, 'draft')
})

test('a failure of the head pipeline labels and replies; a superseded run, or one GitLab has since passed, stays off', async () => {
  const app = board({ gitlab: gitlabSync() })
  const mr = '/projects/42/merge_requests/7'
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('open'))
  const root = await mergeRequestRoot(app)
  setItem(mr, { head_pipeline: { id: 300, status: 'failed', sha: 'a1b2c3d4e5f6a7b8' } })
  await gitlabHook(app, 'Pipeline Hook', pipeline(299, 'canceled'))
  await gitlabHook(app, 'Pipeline Hook', pipeline(300, 'canceled'))
  await gitlabHook(app, 'Pipeline Hook', pipeline(300, 'failed'))
  const failed = await until(app, root.id, ({ message }) => message.labels['ci.42-7.pipeline'] === 'failed')
  assert.deepEqual(repliesOf(failed), [`pipeline failed on acme/platform/web!7 at a1b2c3d4: https://gitlab.test/acme/platform/web/-/pipelines/300`])

  setItem(mr, { head_pipeline: { id: 300, status: 'success', sha: 'a1b2c3d4e5f6a7b8' } })
  await gitlabHook(app, 'Pipeline Hook', pipeline(300, 'success'))
  await until(app, root.id, ({ message }) => message.labels['ci.42-7.pipeline'] === undefined)
  await gitlabHook(app, 'Pipeline Hook', pipeline(300, 'failed'))
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('approval', { by: 'ada' }))
  const after = await until(app, root.id, ({ replies }) => replies.length === 2)
  assert.deepEqual(repliesOf(after).slice(1), ['approved by ada'])
  assert.equal(after.message.labels['ci.42-7.pipeline'], undefined)
})

test('losing approvals unsets review, whichever event GitLab sends for it, and a late approval does not bring it back', async () => {
  const app = board({ gitlab: gitlabSync() })
  const approvals = '/projects/42/merge_requests/7/approvals'
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('open'))
  const root = await mergeRequestRoot(app)
  for (const event of ['unapproval', 'unapproved']) {
    setItem(approvals, { approved: true })
    await gitlabHook(app, 'Merge Request Hook', mergeRequest('approved', { by: 'ada' }))
    await until(app, root.id, ({ message }) => message.labels.review === 'approved')
    setItem(approvals, { approved: false })
    await gitlabHook(app, 'Merge Request Hook', mergeRequest(event, { by: 'ada' }))
    await until(app, root.id, ({ message }) => message.labels.review === undefined)
  }
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('approved', { by: 'bo' }))
  const late = await until(app, root.id, ({ replies }) => replies.at(-1)?.text === 'approved by bo')
  assert.equal(late.message.labels.review, undefined)
})

test("a closed merge request's draft flag changing opens no thread", async () => {
  const app = board({ gitlab: gitlabSync() })
  setItem('/projects/42/merge_requests/8', { state: 'closed' })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('update', { iid: 8, state: 'closed', changes: { draft: { previous: true, current: false } } }))
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('open'))
  await mergeRequestRoot(app)
  await eventually(async () => ((await inbox(app, 'gitlab')).length === 2 ? true : undefined))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal((await channel(app, 'gitlab/platform')).filter((message) => message.re === null).length, 1)
})

test("a fork's pipeline lands on the target project's merge request", async () => {
  const app = board({ gitlab: gitlabSync() })
  setItem('/projects/42/merge_requests/7', { head_pipeline: { id: 400, status: 'failed', sha: 'a1b2c3d4e5f6a7b8' } })
  await gitlabHook(app, 'Pipeline Hook', pipeline(400, 'failed', { project: { id: 77, path: 'acme/forks/web' }, target: 42 }))
  const root = await mergeRequestRoot(app)
  const failed = await until(app, root.id, ({ message }) => message.labels['ci.42-7.pipeline'] === 'failed')
  assert.match(repliesOf(failed)[0]!, /^pipeline failed on acme\/platform\/web!7 at a1b2c3d4: https:\/\/gitlab\.test\/acme\/forks\/web\/-\/pipelines\/400$/)
})

test('a new commit on a merge request moves its head and clears its pipeline labels', async () => {
  const app = board({ gitlab: gitlabSync() })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('open'))
  const root = await mergeRequestRoot(app)
  setItem('/projects/42/merge_requests/7', { head_pipeline: { id: 300, status: 'failed', sha: 'a1b2c3d4e5f6a7b8' } })
  await gitlabHook(app, 'Pipeline Hook', pipeline(300, 'failed'))
  await until(app, root.id, ({ message }) => message.labels['ci.42-7.pipeline'] === 'failed')
  setItem('/projects/42/merge_requests/7', { sha: 'b2c3d4e5f6a7b8c9', head_pipeline: { id: 301, status: 'running', sha: 'b2c3d4e5f6a7b8c9' } })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('update', { oldrev: 'a1b2c3d4e5f6a7b8' }))
  const pushed = await until(app, root.id, ({ message }) => message.labels.head === 'b2c3d4e5f6a7b8c9')
  assert.equal(pushed.message.labels['ci.42-7.pipeline'], undefined)
  assert.equal(pushed.replies.length, 1)
})

test("a push GitLab sends after the new head's pipeline has failed keeps that failure", async () => {
  const app = board({ gitlab: gitlabSync() })
  setItem('/projects/42/merge_requests/7', { sha: 'b2c3d4e5f6a7b8c9', head_pipeline: { id: 301, status: 'failed', sha: 'b2c3d4e5f6a7b8c9' } })
  await gitlabHook(app, 'Pipeline Hook', pipeline(301, 'failed'))
  const root = await mergeRequestRoot(app)
  await until(app, root.id, ({ message }) => message.labels['ci.42-7.pipeline'] === 'failed')
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('update', { oldrev: 'a1b2c3d4e5f6a7b8' }))
  await eventually(async () => ((await inbox(app, 'gitlab')).length === 2 ? true : undefined))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal((await thread(app, root.id)).message.labels['ci.42-7.pipeline'], 'failed')
})

test("an issue's opening, closing and reopening land in its thread", async () => {
  const app = board({ gitlab: gitlabSync() })
  const item = '/projects/42/issues/3'
  await gitlabHook(app, 'Issue Hook', issue('open'))
  const root = await eventually(async () => (await channel(app, 'gitlab/platform')).find((message) => message.labels.issue === 'acme/platform/web#3'))
  assert.equal(root.text, 'Issue #3: Export page is blank\nhttps://gitlab.test/acme/platform/web/-/issues/3')
  assert.equal(root.labels.state, 'open')
  setItem(item, { state: 'closed' })
  await gitlabHook(app, 'Issue Hook', issue('close', 'bo'))
  await until(app, root.id, ({ message }) => message.labels.state === 'closed')
  setItem(item, { state: 'opened' })
  await gitlabHook(app, 'Issue Hook', issue('reopen', 'bo'))
  const reopened = await until(app, root.id, ({ message, replies }) => message.labels.state === 'open' && replies.length === 2)
  assert.deepEqual(repliesOf(reopened), ['closed by bo', 'reopened by bo'])
})

test('an issue or merge request from before the sync gets its root from GitLab when its first event comes', async () => {
  const app = board({ gitlab: gitlabSync() })
  setItem('/projects/42/issues/3', { state: 'closed' })
  await gitlabHook(app, 'Issue Hook', issue('close', 'bo'))
  const closed = await eventually(async () => (await channel(app, 'gitlab/platform')).find((message) => message.labels.issue === 'acme/platform/web#3'))
  assert.equal(closed.text, 'Issue #3: Export page is blank\nhttps://gitlab.test/acme/platform/web/-/issues/3')
  assert.equal(closed.labels.state, 'closed')
  assert.deepEqual(repliesOf(await until(app, closed.id, ({ replies }) => replies.length === 1)), ['closed by bo'])

  setItem('/projects/42/merge_requests/7', { head_pipeline: { id: 300, status: 'failed', sha: 'a1b2c3d4e5f6a7b8' } })
  await gitlabHook(app, 'Pipeline Hook', pipeline(300, 'failed'))
  const root = await mergeRequestRoot(app)
  assert.equal(root.text, `MR !7: Ship the export page\n${MR_URL}/7`)
  const failed = await until(app, root.id, ({ replies }) => replies.length === 1)
  assert.equal(failed.message.labels['ci.42-7.pipeline'], 'failed')
  assert.equal((await thread(app, root.id)).message.labels.state, 'open')

  setItem('/projects/42/merge_requests/8', { head_pipeline: { id: 310, status: 'success', sha: 'a1b2c3d4e5f6a7b8' } })
  await gitlabHook(app, 'Pipeline Hook', pipeline(310, 'success', { iid: 8 }))
  assert.equal((await mergeRequestRoot(app, 8)).labels.state, 'open')
})

test('a confidential issue stays off the board, even from an event sent before it became confidential', async () => {
  const app = board({ gitlab: gitlabSync() })
  setItem('/projects/42/issues/3', { confidential: true, title: 'Layoffs in the platform team' })
  await gitlabHook(app, 'Issue Hook', issue('close', 'bo'))
  await gitlabHook(app, 'Note Hook', { ...note(1003, 'd3', 'see the plan'), object_attributes: { ...note(1003, 'd3', 'see the plan').object_attributes, noteable_type: 'Issue' }, merge_request: undefined, issue: { id: 901, iid: 3, title: 'Export page is blank' } })
  await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))
  await mergeRequestRoot(app)
  await eventually(async () => (logged.filter((line) => line === '[board] gitlab dropped: confidential').length === 2 ? true : undefined))
  assert.ok(!JSON.stringify(await channel(app, 'gitlab/platform')).includes('Layoffs'))
})

test('a comment that first brings an approved merge request with a failing head onto the board says both', async () => {
  const app = board({ gitlab: gitlabSync() })
  setItem('/projects/42/merge_requests/7', { head_pipeline: { id: 300, status: 'failed', sha: 'a1b2c3d4e5f6a7b8' } })
  setItem('/projects/42/merge_requests/7/approvals', { approved: true })
  await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))
  const root = await mergeRequestRoot(app)
  assert.equal(root.labels.review, 'approved')
  assert.equal(root.labels['ci.42-7.pipeline'], 'failed')
})

test('an issue comment is checked against GitLab before it is stored, and a project moved since the webhook left is too', async () => {
  const app = board({ gitlab: gitlabSync(['acme/hiring']) })
  const onIssue = { ...note(1003, 'd3', 'see the plan'), merge_request: undefined, issue: { id: 901, iid: 3, title: 'Export page is blank' } }
  setItem('/projects/42/issues/3', { confidential: true })
  await gitlabHook(app, 'Note Hook', onIssue)
  setItem('/projects/42/issues/3', { confidential: false })
  api['/projects/42'] = { ...(api['/projects/42'] as object), path_with_namespace: 'acme/hiring/web' }
  await gitlabHook(app, 'Note Hook', onIssue)
  assert.deepEqual(await inbox(app, 'gitlab'), [])
  const metrics = await (await app(new Request('https://board.test/metrics'))).text()
  assert.match(metrics, /^board_sync_dropped_total\{entry="gitlab",reason="confidential"\} 1$/m)
  assert.match(metrics, /^board_sync_dropped_total\{entry="gitlab",reason="excluded_path"\} 1$/m)
})

test('a webhook whose issue turns confidential, or whose project moves into an excluded group, while it waits in the inbox stays off the board', async () => {
  const app = board({ gitlab: gitlabSync(['acme/hiring']) })
  const reads = { project: 0, issue: 0 }
  api['/projects/42'] = () => projectOf(42, reads.project++ === 0 ? 'acme/platform/web' : 'acme/hiring/web')
  await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))
  await eventually(async () => (logged.includes('[board] gitlab dropped: excluded path acme/hiring') ? true : undefined))

  api['/projects/42'] = projectOf(42, 'acme/platform/web')
  api['/projects/42/issues/3'] = () => issueItem({ confidential: reads.issue++ > 0 })
  await gitlabHook(app, 'Note Hook', { ...note(1003, 'd3', 'see the plan'), merge_request: undefined, issue: { id: 901, iid: 3, title: 'Export page is blank' } })
  await eventually(async () => (logged.includes('[board] gitlab dropped: confidential') ? true : undefined))
  assert.deepEqual(await channel(app, 'gitlab/platform'), [])
})

test('a merge request whose target moved into an excluded group is dropped at once, however recently its old path was seen', async () => {
  const app = board({ gitlab: gitlabSync(['acme/hiring']) })
  const fork = { id: 77, path: 'acme/forks/web' }
  await gitlabHook(app, 'Pipeline Hook', pipeline(400, 'failed', { project: fork, target: 42 }))
  await eventually(async () => ((await inbox(app, 'gitlab')).length === 1 ? true : undefined))
  api['/projects/42'] = { ...(api['/projects/42'] as object), path_with_namespace: 'acme/hiring/web' }
  await gitlabHook(app, 'Pipeline Hook', pipeline(401, 'failed', { project: fork, target: 42 }))
  assert.equal((await inbox(app, 'gitlab')).length, 1)
  assert.ok(logged.includes('[board] gitlab dropped: excluded path acme/hiring'))
})
