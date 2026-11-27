import assert from 'node:assert/strict'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createApp } from '../src/app.ts'
import type { SyncOptions } from '../src/sync.ts'

export const URL_ = 'https://board.test/api/board'
const AUTHKIT = 'https://tenant.authkit.test'

const people = await generateKeyPair('RS256')
const peopleJwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(people.publicKey)), kid: 'k', alg: 'RS256' }] })
export const ada = await new SignJWT({ sub: 'user_ada' })
  .setProtectedHeader({ alg: 'RS256', kid: 'k' })
  .setIssuer(AUTHKIT)
  .setAudience(URL_)
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(people.privateKey)

export function board(sync: SyncOptions) {
  return createApp({
    url: URL_,
    dir: { memory: true },
    people: {
      issuer: AUTHKIT,
      domain: 'example.com',
      jwks: peopleJwks,
      fetch: async () => Response.json({ sub: 'user_ada', email: 'ada@example.com', email_verified: true }),
    },
    sync,
  })
}

export type App = ReturnType<typeof board>
export type Message = { id: string; re: string | null; channel: string; text: string; labels: Record<string, string> }
export type Thread = { message: Message; replies: Message[] }

export const asAda = (app: App, method: string, path: string, body?: unknown) =>
  app(new Request(`${URL_}${path}`, {
    method,
    headers: { authorization: `Bearer ${ada}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))

export async function read<T>(app: App, path: string): Promise<T> {
  const response = await asAda(app, 'GET', path)
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()) as T
}

export const channel = async (app: App, path: string) => (await read<{ messages: Message[] }>(app, `/messages?channel=${encodeURIComponent(path)}`)).messages
export const inbox = async (app: App, key: string) => (await read<{ events: unknown[] }>(app, `/inbox/${key}`)).events
export const thread = (app: App, id: string) => read<Thread>(app, `/messages/${id}`)

export async function eventually<T>(check: () => Promise<T | undefined>, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const found = await check()
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export const until = (app: App, id: string, done: (found: Thread) => boolean) =>
  eventually(async () => {
    const found = await thread(app, id)
    return done(found) ? found : undefined
  })
