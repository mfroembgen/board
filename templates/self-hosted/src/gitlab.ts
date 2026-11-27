import { createHash, timingSafeEqual } from 'node:crypto'
import { createGitLabAdapter, type GitLabAdapter } from '@chat-adapter/gitlab'
import type { MessageView } from '@vercel/board'
import type { ExternalAuthor, Receive, ReceivedEvent, SyncFn, SyncOverrides, SyncProvider, SyncRoot } from '@vercel/board/sync'
import { chatSdk, type ChatSdkEvent } from '@vercel/board/sync-chat-sdk'
import { segment } from './channels.ts'
import type { DropReason, Drops } from './drops.ts'

export type GitLabSync = {
  token: string
  webhookSecret: string
  apiUrl: string
  botUserId?: number
  excludedPaths?: string[]
}

type Lifecycle = Extract<ReceivedEvent['event'], { kind: 'lifecycle' }>
type Kind = 'mr' | 'issue'
type Change = Omit<Lifecycle, 'kind' | 'channel' | 'thread' | 'author'> & { kind: Kind; iid: number; project: number }
type Pipeline = { id: number; status: string; sha: string; url: string }
type Kept = { pipeline: Pipeline } | null

type User = {
  id?: number
  username?: string
  name?: string
  avatar_url?: string | null
  bot?: boolean
}
type ProjectRef = { path_with_namespace?: string }
type Hook = {
  user?: User
  project?: { id?: number; path_with_namespace?: string; web_url?: string }
  object_attributes?: {
    id?: number
    iid?: number
    title?: string
    url?: string
    action?: string
    state?: string
    oldrev?: string
    status?: string
    sha?: string
    source?: ProjectRef
    target?: ProjectRef
    source_project_id?: number
    target_project_id?: number
  }
  changes?: Record<string, unknown>
  merge_request?: {
    iid?: number
    url?: string
    source_project_id?: number
    target_project_id?: number
    source?: ProjectRef
    target?: ProjectRef
  }
}
type Noteable = {
  iid: number
  title: string
  web_url: string
  state: string
  draft?: boolean
  sha?: string
  references?: { full?: string }
  head_pipeline?: { id?: number; status?: string } | null
  author: User
}

const PIPELINE_FAILED = ['failed', 'canceled']
const PATH_TTL_MS = 10 * 60 * 1000
const GITLAB_CI: ExternalAuthor = { id: 'gitlab:user:gitlab-ci', handle: 'gitlab-ci', name: 'GitLab CI', avatar: null, isBot: true }

export function gitlabChannel(path: string): string {
  const parts = path.split('/')
  return `gitlab/${segment(parts.length > 2 ? parts[1]! : parts[0]!)}`
}

export const pipelineLabel = (project: number | string, iid: number | string) => `ci.${project}-${iid}.pipeline`

const ciPrefix = (project: number, iid: number) => `ci.${project}-${iid}.`
const native = (key: string, id: string) => id.slice(key.length + 1)
const noteableThread = (thread: string) => thread.split(':').slice(0, 3).join(':')

const BOT_USERNAME = /^(project|group)_\d+_bot(_|$)/

function authorOf(user: User | undefined): ExternalAuthor {
  const handle = user?.username ?? 'someone'
  const isBot = user?.bot === true || BOT_USERNAME.test(handle)
  return { id: `gitlab:user:${user?.id ?? handle}`, handle, name: user?.name || handle, avatar: user?.avatar_url ?? null, isBot }
}

function mergeRequestState(item: Noteable): string {
  if (item.state === 'merged' || item.state === 'closed') return item.state
  return item.draft ? 'draft' : 'open'
}

function rootOf(kind: Kind, item: Noteable): Omit<SyncRoot, 'raw'> {
  const author = authorOf(item.author)
  if (kind === 'mr') {
    const labels = { mr: item.references?.full ?? '', state: mergeRequestState(item), ...(item.sha ? { head: item.sha } : {}) }
    return { text: `MR !${item.iid}: ${item.title}\n${item.web_url}`, labels, author }
  }
  const labels = { issue: item.references?.full ?? '', state: item.state === 'closed' ? 'closed' : 'open' }
  return { text: `Issue #${item.iid}: ${item.title}\n${item.web_url}`, labels, author }
}

function mergeRequestChanges(hook: Hook, project: number): Change[] {
  const mr = hook.object_attributes!
  const who = hook.user?.username ?? 'someone'
  const base = { kind: 'mr' as const, iid: mr.iid!, project, title: `MR !${mr.iid}: ${mr.title}`, url: mr.url ?? null, labels: {}, unset: [], reply: null, createRoot: true }
  switch (mr.action) {
    case 'open':
      return [{ ...base, type: 'mr.opened' }]
    case 'reopen':
      return [{ ...base, type: 'mr.reopened', reply: `reopened by ${who}` }]
    case 'close':
      return [{ ...base, type: 'mr.closed', reply: `closed by ${who}` }]
    case 'merge':
      return [{ ...base, type: 'mr.merged', reply: `merged by ${who}` }]
    case 'approval':
      return [{ ...base, type: 'mr.approval', reply: `approved by ${who}` }]
    case 'approved':
      return [{ ...base, type: 'mr.approved', labels: { review: 'approved' }, reply: `approved by ${who}` }]
    case 'unapproval':
    case 'unapproved':
      return [{ ...base, type: 'mr.unapproved', unset: ['review'], createRoot: false }]
    case 'update':
      return mergeRequestUpdates(hook, base)
    default:
      return []
  }
}

function mergeRequestUpdates(hook: Hook, base: Omit<Change, 'type'>): Change[] {
  const changes = hook.changes ?? {}
  const updates: Change[] = []
  if (changes.title) updates.push({ ...base, type: 'mr.edited', retitled: true, createRoot: false })
  if ('draft' in changes || 'work_in_progress' in changes) updates.push({ ...base, type: 'mr.state', createRoot: hook.object_attributes?.state === 'opened' })
  if (hook.object_attributes?.oldrev) updates.push({ ...base, type: 'mr.synchronized', owns: [ciPrefix(base.project, base.iid)], createRoot: false })
  return updates
}

function issueChanges(hook: Hook, project: number): Change[] {
  const issue = hook.object_attributes!
  const who = hook.user?.username ?? 'someone'
  const base = { kind: 'issue' as const, iid: issue.iid!, project, title: `Issue #${issue.iid}: ${issue.title}`, url: issue.url ?? null, labels: {}, unset: [], reply: null, createRoot: true }
  switch (issue.action) {
    case 'open':
      return [{ ...base, type: 'issue.opened' }]
    case 'reopen':
      return [{ ...base, type: 'issue.reopened', reply: `reopened by ${who}` }]
    case 'close':
      return [{ ...base, type: 'issue.closed', reply: `closed by ${who}` }]
    case 'update':
      return hook.changes?.title ? [{ ...base, type: 'issue.edited', retitled: true, createRoot: false }] : []
    default:
      return []
  }
}

function pipelineChanges(hook: Hook, project: number): Change[] {
  const iid = hook.merge_request?.iid
  const status = hook.object_attributes?.status ?? ''
  if (!iid || (status !== 'success' && !PIPELINE_FAILED.includes(status))) return []
  const target = hook.merge_request?.target_project_id ?? project
  const key = pipelineLabel(target, iid)
  const failed = status !== 'success'
  return [{
    kind: 'mr',
    iid,
    project: target,
    type: failed ? 'ci.failed' : 'ci.passed',
    title: `MR !${iid}`,
    url: hook.merge_request?.url ?? null,
    labels: failed ? { [key]: status } : {},
    unset: failed ? [] : [key],
    reply: failed ? `pipeline ${status}` : null,
    createRoot: failed,
  }]
}

function pipelineOf(hook: Hook): Pipeline {
  const pipeline = hook.object_attributes ?? {}
  return { id: pipeline.id ?? 0, status: pipeline.status ?? '', sha: pipeline.sha ?? '', url: pipeline.url ?? `${hook.project?.web_url}/-/pipelines/${pipeline.id}` }
}

const HOOKS = new Map<string, (hook: Hook, project: number) => Change[]>([
  ['Merge Request Hook', mergeRequestChanges],
  ['Issue Hook', issueChanges],
  ['Pipeline Hook', pipelineChanges],
])

function parsed(body: string): Hook | null {
  try {
    const hook = JSON.parse(body) as unknown
    return hook && typeof hook === 'object' ? (hook as Hook) : null
  } catch {
    return null
  }
}

export function lifecycleEvents(key: string, headers: Headers, body: string): ReceivedEvent[] {
  const event = headers.get('x-gitlab-event') ?? ''
  const changesOf = HOOKS.get(event)
  const hook = changesOf ? parsed(body) : null
  const project = hook?.project?.id
  if (!changesOf || !hook?.object_attributes || typeof project !== 'number') return []
  const delivery = headers.get('idempotency-key') ?? headers.get('x-gitlab-event-uuid') ?? createHash('sha256').update(body).digest('base64url')
  const author = event === 'Pipeline Hook' ? GITLAB_CI : authorOf(hook.user)
  const kept: Kept = event === 'Pipeline Hook' ? { pipeline: pipelineOf(hook) } : null
  return changesOf(hook, project).map(({ kind, iid, project: target, ...change }, index) => ({
    event: { kind: 'lifecycle', channel: `${key}:${target}`, thread: `${key}:${target}:${kind}:${iid}`, author, ...change },
    raw: kept,
    dedupe: `lifecycle:${delivery}:${index}`,
  }))
}

function namedProjects(hook: Hook): { paths: string[]; ids: number[] } {
  const refs = [hook.project, hook.object_attributes?.source, hook.object_attributes?.target, hook.merge_request?.source, hook.merge_request?.target]
  const ids = [hook.object_attributes?.source_project_id, hook.object_attributes?.target_project_id, hook.merge_request?.source_project_id, hook.merge_request?.target_project_id]
  return {
    paths: refs.flatMap((ref) => (typeof ref?.path_with_namespace === 'string' ? [ref.path_with_namespace] : [])),
    ids: ids.filter((id): id is number => typeof id === 'number' && id !== hook.project?.id),
  }
}

function sameSecret(expected: string, given: string | null): boolean {
  if (!given) return false
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(expected), digest(given))
}

const withoutQuickActions = (markdown: string) => markdown.replace(/^(\s*)\//gm, '$1\\/')

const keptOnly = (emit: Receive): Receive => (received) => emit({ ...received, raw: received.event.kind === 'lifecycle' ? received.raw : null })

export function gitlab(options: GitLabSync, drops: Drops, threadRoot: (message: string) => Promise<MessageView>): SyncProvider {
  const adapter: GitLabAdapter = createGitLabAdapter({
    token: options.token,
    webhookSecret: options.webhookSecret,
    webhookSigningToken: '',
    apiUrl: options.apiUrl,
    ...(options.botUserId ? { botUserId: options.botUserId } : {}),
  })
  const excludedPaths = (options.excludedPaths ?? []).map((path) => path.toLowerCase())
  drops.exclusions('gitlab', excludedPaths)
  const excludedBy = (path: string) => {
    const lower = path.toLowerCase()
    return excludedPaths.find((prefix) => lower === prefix || lower.startsWith(`${prefix}/`))
  }
  const paths = new Map<string, { path: Promise<string>; until: number }>()
  const pathOf = (project: number | string, fresh = false) => {
    const cached = paths.get(String(project))
    if (cached && !fresh && cached.until > Date.now()) return cached.path
    const path = adapter.fetchChannelInfo(`gitlab:${project}`).then((info) => info.name ?? Promise.reject(new Error(`GitLab project ${project} has no path`)))
    path.catch(() => paths.delete(String(project)))
    paths.set(String(project), { path, until: Date.now() + PATH_TTL_MS })
    return path
  }
  const exclusion = async (hook: Hook): Promise<[DropReason, string?] | null> => {
    if (excludedPaths.length === 0) return null
    const { paths: named, ids } = namedProjects(hook)
    for (const path of named) {
      const prefix = excludedBy(path)
      if (prefix) return ['excluded_path', prefix]
    }
    for (const id of ids) {
      const path = await pathOf(id).catch(() => null)
      if (path === null) return ['unreadable_project']
      const prefix = excludedBy(path)
      if (prefix) return ['excluded_path', prefix]
    }
    return null
  }
  const noteableOf = (project: string, kind: string, iid: string) =>
    adapter.request<Noteable>('GET', `/projects/${project}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`)

  const reconciled = (event: Lifecycle, kind: Kind, item: Noteable, kept: Kept): SyncOverrides | null => {
    const current = rootOf(kind, item)
    const state = kind === 'mr' ? { state: current.labels.state!, ...(item.sha ? { head: item.sha } : {}) } : { state: current.labels.state! }
    const overrides: SyncOverrides = { labels: { ...event.labels, ...state }, root: () => ({ text: current.text, labels: current.labels }) }
    if (!event.type.startsWith('ci.')) return overrides
    const head = item.head_pipeline
    const pipeline = kept?.pipeline
    if (!pipeline || head?.id !== pipeline.id || PIPELINE_FAILED.includes(head.status ?? '') !== PIPELINE_FAILED.includes(pipeline.status)) return null
    if (event.type === 'ci.passed') return overrides
    return { ...overrides, text: `pipeline ${pipeline.status} on ${item.references?.full ?? `!${item.iid}`} at ${pipeline.sha.slice(0, 8)}: ${pipeline.url}` }
  }

  const sync: SyncFn<ChatSdkEvent<'gitlab'>> = async (sync) => {
    if (sync.direction === 'out') {
      if (sync.target === null) return
      const thread = noteableThread(native(sync.key, sync.target))
      const root = await threadRoot(sync.message.id)
      if (root.from !== sync.key || root.origin?.thread !== `${sync.key}:${thread}`) return drops.record('gitlab', 'unimported_target')
      const prefix = excludedPaths.length ? excludedBy(await pathOf(thread.split(':')[0]!, true)) : undefined
      if (prefix) return drops.record('gitlab', 'excluded_target', prefix)
      return sync.deliver()
    }
    const event = sync.event
    if (event.kind !== 'message' && event.kind !== 'lifecycle') return void (await sync.import())
    const [project, kind, iid] = native(sync.key, event.thread).split(':') as [string, Kind, string]
    const channel = gitlabChannel(await pathOf(project))
    if (event.kind === 'message') return void (await sync.import(channel))
    const overrides = reconciled(event, kind, await noteableOf(project, kind, iid), event.raw as Kept)
    if (overrides) await sync.import(channel, overrides)
  }

  const provider = chatSdk(
    {
      adapter,
      platform: 'gitlab',
      groupThread: noteableThread,
      intercept: lifecycleEvents,
      fetchRoot: async (thread) => {
        const [project, kind, iid] = thread.split(':') as [string, Kind, string]
        return rootOf(kind, await noteableOf(project, kind, iid))
      },
    },
    sync,
  )

  const receive = provider.receive.bind(provider)
  provider.receive = async (key, request, emit) => {
    if (!sameSecret(options.webhookSecret, request.headers.get('x-gitlab-token'))) {
      drops.record('gitlab', 'unsigned')
      return receive(key, request, keptOnly(emit))
    }
    const hook = parsed(await request.clone().text())
    const dropped = hook ? await exclusion(hook) : null
    if (dropped) {
      drops.record('gitlab', ...dropped)
      return new Response('ok')
    }
    return receive(key, request, keptOnly(emit))
  }
  const post = provider.post.bind(provider)
  provider.post = (target, kind, body) => post(target, kind, { ...body, markdown: withoutQuickActions(body.markdown) })
  const edit = provider.edit.bind(provider)
  provider.edit = (thread, message, body) => edit(thread, message, { ...body, markdown: withoutQuickActions(body.markdown) })
  return provider
}
