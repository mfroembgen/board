import type { Watcher } from '@vercel/board'
import type { SyncProvider } from '@vercel/board/sync'
import { gchat, type GoogleChatSync } from './gchat.ts'
import { gitlab, type GitLabSync } from './gitlab.ts'

export type { GitLabSync, GoogleChatSync }

export type SyncOptions = {
  gitlab?: GitLabSync
  gchat?: GoogleChatSync
  triageChannel?: string
}

type Env = Record<string, string | undefined>

function settings(env: Env, entry: string, switches: string[], names: string[]): Record<string, string> | undefined {
  if (!switches.some((name) => env[name])) return undefined
  const given = Object.fromEntries(names.flatMap((name) => (env[name] ? [[name, env[name]]] : [])))
  const missing = names.filter((name) => !given[name])
  if (missing.length) throw new Error(`${entry} sync needs ${missing.join(', ')} too`)
  return given
}

function list(value: string | undefined): string[] {
  const items = (value ?? '').split(',').map((item) => item.trim())
  return items.filter(Boolean)
}

function spaceMap(value: string | undefined): Record<string, string> {
  return Object.fromEntries(
    list(value).map((pair) => {
      const [space, channel] = pair.split('=').map((part) => part.trim())
      if (!space?.startsWith('spaces/') || !channel) throw new Error(`GOOGLE_CHAT_SPACES takes spaces/<id>=<channel> pairs, not ${pair}`)
      return [space, channel]
    }),
  )
}

function serviceAccountKey(value: string): GoogleChatSync['credentials'] {
  let key: unknown
  try {
    key = JSON.parse(value)
  } catch {
    key = null
  }
  const { client_email, private_key } = (key ?? {}) as Record<string, unknown>
  if (typeof client_email !== 'string' || typeof private_key !== 'string') throw new Error('GOOGLE_CHAT_CREDENTIALS must be a service account key in JSON, with client_email and private_key')
  return { client_email, private_key }
}

export function syncFromEnv(env: Env): SyncOptions {
  const options: SyncOptions = {}
  const gitlab = settings(env, 'GitLab', ['GITLAB_TOKEN', 'GITLAB_WEBHOOK_SECRET'], ['GITLAB_TOKEN', 'GITLAB_WEBHOOK_SECRET', 'GITLAB_API_URL'])
  if (gitlab) {
    options.gitlab = {
      token: gitlab.GITLAB_TOKEN!,
      webhookSecret: gitlab.GITLAB_WEBHOOK_SECRET!,
      apiUrl: gitlab.GITLAB_API_URL!,
      ...(env.GITLAB_BOT_USER_ID ? { botUserId: Number(env.GITLAB_BOT_USER_ID) } : {}),
      excludedPaths: list(env.GITLAB_EXCLUDE),
    }
  }
  const gchat = settings(env, 'Google Chat', ['GOOGLE_CHAT_CREDENTIALS'], ['GOOGLE_CHAT_CREDENTIALS', 'GOOGLE_CHAT_PROJECT_NUMBER'])
  if (gchat) {
    options.gchat = {
      credentials: serviceAccountKey(gchat.GOOGLE_CHAT_CREDENTIALS!),
      projectNumber: gchat.GOOGLE_CHAT_PROJECT_NUMBER!,
      ...(env.GOOGLE_CHAT_BOT_USER_ID ? { botUserId: env.GOOGLE_CHAT_BOT_USER_ID } : {}),
      channelsBySpace: spaceMap(env.GOOGLE_CHAT_SPACES),
    }
  }
  if (env.BOARD_TRIAGE_CHANNEL) options.triageChannel = env.BOARD_TRIAGE_CHANNEL
  return options
}

export function syncEntries(options: SyncOptions, boardUrl: string): Record<string, SyncProvider> {
  return {
    ...(options.gitlab ? { gitlab: gitlab(options.gitlab) } : {}),
    ...(options.gchat ? { gchat: gchat(options.gchat, `${boardUrl.replace(/\/+$/, '')}/webhooks/gchat`) } : {}),
  }
}

export function triage(channel?: string): Watcher {
  return {
    tail: 'gitlab/ --source gitlab',
    run: async ({ event, board }) => {
      const message = event.message
      if (event.type !== 'message.posted' || !message || message.re !== null) return
      await board.label(message.id, { set: { status: 'triage' } })
      if (channel) await board.post(channel, `${message.channel} #${message.id}: ${message.text.split('\n')[0]}`)
    },
  }
}
