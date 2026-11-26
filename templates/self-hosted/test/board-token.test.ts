import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'

const BOARD = 'https://board.test/api/board'
const script = join(import.meta.dirname, '..', 'bin', 'board-token.ts')

let refreshes = 0
const authkit = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk: Buffer) => (body += chunk))
  request.on('end', () => {
    const grant = new URLSearchParams(body).get('grant_type')
    if (request.url !== '/oauth2/token' || grant !== 'refresh_token') return void response.writeHead(400).end('{}')
    refreshes++
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ access_token: `access-${refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 300 }))
  })
})
await new Promise<void>((resolve) => authkit.listen(0, '127.0.0.1', resolve))
const issuer = `http://127.0.0.1:${(authkit.address() as AddressInfo).port}`
const home = await mkdtemp(join(tmpdir(), 'board-token-'))
after(async () => {
  authkit.close()
  await rm(home, { recursive: true, force: true })
})

async function signedIn(accessToken: string, left: number) {
  const digest = createHash('sha256').update(`${issuer}\n${BOARD}`).digest('hex')
  const dir = join(home, '.config', 'board-token')
  await mkdir(dir, { recursive: true })
  const saved = {
    clientId: 'client',
    redirectUri: 'http://127.0.0.1:1/callback',
    refreshToken: 'refresh-0',
    accessToken,
    expiresAt: Date.now() + left,
  }
  await writeFile(join(dir, `board.test-${digest.slice(0, 16)}.json`), JSON.stringify(saved))
}

async function token(args: string[] = [], env: Record<string, string> = {}) {
  const run = promisify(execFile)
  const environment = { ...process.env, HOME: home, BOARD_URL: BOARD, AUTHKIT_ISSUER: issuer, ...env }
  return (await run(process.execPath, [script, ...args], { env: environment })).stdout
}

test('refreshes a token with two minutes or less left, and keeps one with more', async () => {
  await signedIn('nearly-expired', 90_000)
  assert.equal(await token(), 'access-1')
  assert.equal(await token(), 'access-1')
  assert.equal(refreshes, 1)
})

test('refreshes a fresh token with --refresh or BOARD_TOKEN_REFRESH=1', async () => {
  await signedIn('refused', 240_000)
  const before = refreshes
  assert.equal(await token(), 'refused')
  assert.equal(await token(['--refresh']), `access-${before + 1}`)
  assert.equal(await token([], { BOARD_TOKEN_REFRESH: '1' }), `access-${before + 2}`)
})
