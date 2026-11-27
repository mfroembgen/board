import { createHash, timingSafeEqual } from 'node:crypto'
import { createGitLabAdapter, type GitLabAdapter } from '@chat-adapter/gitlab'
import type { ExternalAuthor, ReceivedEvent, SyncFn, SyncProvider, SyncRoot } from '@vercel/board/sync'
import { chatSdk, type ChatSdkEvent } from '@vercel/board/sync-chat-sdk'
import { segment } from './channels.ts'

export type GitLabSync = {
  token: string
  webhookSecret: string
  apiUrl: string
  botUserId?: number
  excludedPaths?: string[]
}

type Lifecycle = Extract<ReceivedEvent['event'], { kind: 'lifecycle' }>
type Change = Omit<Lifecycle, 'kind' | 'channel' | 'thread' | 'author'> & { noteable: 'mr' | 'issue'; iid: number }

type User = {
  id?: number
  username?: string
  name?: string
  avatar_url?: string | null
}
type Hook = {
  user?: User
  project?: { id?: number; path_with_namespace?: string; web_url?: string }
  object_attributes?: {
    id?: number
    iid?: number
    title?: string
    url?: string
    action?: string
    draft?: boolean
    work_in_progress?: boolean
    oldrev?: string
    last_commit?: { id?: string }
    status?: string
    sha?: string
  }
  changes?: Record<string, unknown>
  merge_request?: { iid?: number; url?: string }
}
type Noteable = {
  iid: number
  title: string
  web_url: string
  state: string
  draft?: boolean
  sha?: string
  references?: { full?: string }
  author: User & { bot?: boolean }
}

const PIPELINE_REPORTED = ['failed', 'canceled', 'success']
const GITLAB_CI: ExternalAuthor = { id: 'gitlab:user:gitlab-ci', handle: 'gitlab-ci', name: 'GitLab CI', avatar: null, isBot: true }

export function gitlabChannel(path: string): string {
  const parts = path.split('/')
  return `gitlab/${segment(parts.length > 2 ? parts[1]! : parts[0]!)}`
}

export const pipelineLabel = (project: number | string, iid: number | string) => `ci.${project}-${iid}.pipeline`

const ciPrefix = (project: number, iid: number) => `ci.${project}-${iid}.`
const native = (key: string, id: string) => id.slice(key.length + 1)
const noteableThread = (thread: string) => thread.split(':').slice(0, 3).join(':')

function authorOf(user: User | undefined): ExternalAuthor {
  const handle = user?.username ?? 'someone'
  return { id: `gitlab:user:${user?.id ?? handle}`, handle, name: user?.name || handle, avatar: user?.avatar_url ?? null, isBot: false }
}

function mergeRequestState(item: { state?: string; draft?: boolean; work_in_progress?: boolean }): string {
  if (item.state === 'merged' || item.state === 'closed') return item.state
  return item.draft || item.work_in_progress ? 'draft' : 'open'
}

function mergeRequestChanges(hook: Hook, path: string, project: number): Change[] {
  const mr = hook.object_attributes!
  const iid = mr.iid!
  const who = hook.user?.username ?? 'someone'
  const sha = mr.last_commit?.id
  const head: Record<string, string> = sha ? { head: sha } : {}
  const state = mergeRequestState({ draft: mr.draft, work_in_progress: mr.work_in_progress })
  const root = { mr: `${path}!${iid}`, ...head, state }
  const base = { noteable: 'mr' as const, iid, title: `MR !${iid}: ${mr.title}`, url: mr.url ?? null, labels: {}, unset: [], reply: null, createRoot: false }
  switch (mr.action) {
    case 'open':
      return [{ ...base, type: 'mr.opened', labels: root, createRoot: true }]
    case 'reopen':
      return [{ ...base, type: 'mr.reopened', labels: root, reply: `reopened by ${who}`, createRoot: true }]
    case 'close':
      return [{ ...base, type: 'mr.closed', labels: { state: 'closed' }, reply: `closed by ${who}` }]
    case 'merge':
      return [{ ...base, type: 'mr.merged', labels: { state: 'merged' }, reply: `merged by ${who}` }]
    case 'approval':
      return [{ ...base, type: 'mr.approval', reply: `approved by ${who}` }]
    case 'approved':
      return [{ ...base, type: 'mr.approved', labels: { review: 'approved' } }]
    case 'unapproved':
      return [{ ...base, type: 'mr.unapproved', unset: ['review'] }]
    case 'update':
      return mergeRequestUpdates(hook.changes ?? {}, Boolean(mr.oldrev), base, root, project)
    default:
      return []
  }
}

function mergeRequestUpdates(changes: Record<string, unknown>, pushed: boolean, base: Omit<Change, 'type'>, root: Record<string, string>, project: number): Change[] {
  const updates: Change[] = []
  if (changes.title) updates.push({ ...base, type: 'mr.edited', retitled: true })
  if ('draft' in changes || 'work_in_progress' in changes) {
    const ready = root.state === 'open'
    updates.push({ ...base, type: ready ? 'mr.ready' : 'mr.draft', labels: ready ? root : { state: 'draft' }, createRoot: ready })
  }
  if (pushed && root.head) updates.push({ ...base, type: 'mr.synchronized', labels: { head: root.head }, owns: [ciPrefix(project, base.iid)] })
  return updates
}

function issueChanges(hook: Hook, path: string): Change[] {
  const issue = hook.object_attributes!
  const iid = issue.iid!
  const who = hook.user?.username ?? 'someone'
  const root = { issue: `${path}#${iid}` }
  const base = { noteable: 'issue' as const, iid, title: `Issue #${iid}: ${issue.title}`, url: issue.url ?? null, labels: {}, unset: [], reply: null, createRoot: false }
  switch (issue.action) {
    case 'open':
      return [{ ...base, type: 'issue.opened', labels: { ...root, state: 'open' }, createRoot: true }]
    case 'reopen':
      return [{ ...base, type: 'issue.reopened', labels: { ...root, state: 'open' }, reply: `reopened by ${who}`, createRoot: true }]
    case 'close':
      return [{ ...base, type: 'issue.closed', labels: { state: 'closed' }, reply: `closed by ${who}` }]
    case 'update':
      return hook.changes?.title ? [{ ...base, type: 'issue.edited', retitled: true }] : []
    default:
      return []
  }
}

function pipelineChanges(hook: Hook, path: string, project: number): Change[] {
  const pipeline = hook.object_attributes!
  const iid = hook.merge_request?.iid
  const status = pipeline.status ?? ''
  if (!iid || !PIPELINE_REPORTED.includes(status)) return []
  const key = pipelineLabel(project, iid)
  const failed = status !== 'success'
  const link = pipeline.url ?? `${hook.project?.web_url}/-/pipelines/${pipeline.id}`
  return [{
    noteable: 'mr',
    iid,
    type: failed ? 'ci.failed' : 'ci.passed',
    title: `MR !${iid}`,
    url: hook.merge_request?.url ?? null,
    labels: failed ? { [key]: status } : {},
    unset: failed ? [] : [key],
    reply: failed ? `pipeline ${status} on ${path}!${iid} at ${(pipeline.sha ?? '').slice(0, 8)}: ${link}` : null,
    createRoot: false,
  }]
}

const HOOKS: Record<string, (hook: Hook, path: string, project: number) => Change[]> = {
  'Merge Request Hook': mergeRequestChanges,
  'Issue Hook': issueChanges,
  'Pipeline Hook': pipelineChanges,
}

export function lifecycleEvents(key: string, headers: Headers, body: string): ReceivedEvent[] {
  const changesOf = HOOKS[headers.get('x-gitlab-event') ?? '']
  if (!changesOf) return []
  let hook: Hook
  try {
    hook = JSON.parse(body) as Hook
  } catch {
    return []
  }
  const project = hook.project?.id
  const path = hook.project?.path_with_namespace
  if (typeof project !== 'number' || !path || !hook.object_attributes) return []
  const delivery = headers.get('idempotency-key') ?? headers.get('x-gitlab-event-uuid') ?? createHash('sha256').update(body).digest('base64url')
  const author = headers.get('x-gitlab-event') === 'Pipeline Hook' ? GITLAB_CI : authorOf(hook.user)
  return changesOf(hook, path, project).map(({ noteable, iid, ...change }, index) => ({
    event: { kind: 'lifecycle', channel: `${key}:${project}`, thread: `${key}:${project}:${noteable}:${iid}`, author, ...change },
    raw: hook,
    dedupe: `lifecycle:${delivery}:${index}`,
  }))
}

function rootOf(kind: string, item: Noteable): Omit<SyncRoot, 'raw'> {
  const author = { ...authorOf(item.author), isBot: item.author.bot === true }
  if (kind === 'mr') {
    const labels = { mr: item.references?.full ?? '', state: mergeRequestState(item), ...(item.sha ? { head: item.sha } : {}) }
    return { text: `MR !${item.iid}: ${item.title}\n${item.web_url}`, labels, author }
  }
  const labels = { issue: item.references?.full ?? '', state: item.state === 'closed' ? 'closed' : 'open' }
  return { text: `Issue #${item.iid}: ${item.title}\n${item.web_url}`, labels, author }
}

function sameSecret(expected: string, given: string | null): boolean {
  if (!given) return false
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(expected), digest(given))
}

function excludedPath(body: string, excludedPaths: string[]): boolean {
  let path: unknown
  try {
    path = (JSON.parse(body) as Hook).project?.path_with_namespace
  } catch {
    return false
  }
  return typeof path === 'string' && excludedPaths.some((prefix) => path === prefix || (path as string).startsWith(`${prefix}/`))
}

export function gitlab(options: GitLabSync): SyncProvider {
  const adapter: GitLabAdapter = createGitLabAdapter({
    token: options.token,
    webhookSecret: options.webhookSecret,
    apiUrl: options.apiUrl,
    ...(options.botUserId ? { botUserId: options.botUserId } : {}),
  })
  const paths = new Map<string, Promise<string>>()
  const pathOf = (project: string) => {
    let path = paths.get(project)
    if (!path) {
      path = adapter.fetchChannelInfo(`gitlab:${project}`).then((info) => info.name ?? Promise.reject(new Error(`GitLab project ${project} has no path`)))
      path.catch(() => paths.delete(project))
      paths.set(project, path)
    }
    return path
  }
  const isHeadPipeline = async (project: string, iid: string, raw: unknown) => {
    const mr = await adapter.request<{ head_pipeline?: { id?: number } | null }>('GET', `/projects/${project}/merge_requests/${iid}`)
    return mr.head_pipeline?.id !== undefined && mr.head_pipeline.id === (raw as Hook).object_attributes?.id
  }

  const sync: SyncFn<ChatSdkEvent<'gitlab'>> = async (sync) => {
    if (sync.direction === 'out') return sync.target === null ? undefined : sync.deliver()
    const event = sync.event
    if (event.kind !== 'message' && event.kind !== 'lifecycle') return void (await sync.import())
    const [project, , iid] = native(sync.key, event.thread).split(':') as [string, string, string]
    if (event.kind === 'lifecycle' && event.type.startsWith('ci.') && !(await isHeadPipeline(project, iid, event.raw))) return
    await sync.import(gitlabChannel(await pathOf(project)))
  }

  const provider = chatSdk(
    {
      adapter,
      platform: 'gitlab',
      groupThread: noteableThread,
      intercept: lifecycleEvents,
      fetchRoot: async (thread) => {
        const [project, kind, iid] = thread.split(':')
        const item = await adapter.request<Noteable>('GET', `/projects/${project}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`)
        return rootOf(kind!, item)
      },
    },
    sync,
  )

  const excludedPaths = options.excludedPaths ?? []
  if (excludedPaths.length === 0) return provider
  const receive = provider.receive.bind(provider)
  provider.receive = async (key, request, emit) => {
    const body = await request.clone().text()
    if (excludedPath(body, excludedPaths) && sameSecret(options.webhookSecret, request.headers.get('x-gitlab-token'))) return new Response('ok')
    return receive(key, request, emit)
  }
  return provider
}
