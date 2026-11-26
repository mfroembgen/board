import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { vercel } from '../src/backend-vercel/index.ts'
import { connect } from '../src/client/node.ts'
import { bearer, BOARD_URL, personToken, testBoard } from './harness.ts'
import { fakeMessageboard } from './messageboard.ts'

const dirs: string[] = []

const clean = () => {
  const ours = Object.keys(process.env).filter((key) => /^(BOARD|VERCEL|ACTIONS_ID_TOKEN)/.test(key))
  for (const key of ours) vi.stubEnv(key, '')
}

async function tokenCommand(first: string, next?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'board-token-command-'))
  dirs.push(dir)
  await writeFile(join(dir, 'token'), first)
  if (next !== undefined) await writeFile(join(dir, 'next'), next)
  await writeFile(join(dir, 'print.sh'), 'cd "$(dirname "$0")"\necho "run${BOARD_TOKEN_REFRESH:+ refresh}" >> runs\ncat token\nif [ -f next ]; then mv next token; fi\n')
  vi.stubEnv('BOARD_TOKEN_COMMAND', `sh '${join(dir, 'print.sh')}'`)
  const runs = async () => {
    const log = await readFile(join(dir, 'runs'), 'utf8').catch(() => '')
    return log.split('\n').filter(Boolean)
  }
  return { runs, print: (token: string) => writeFile(join(dir, 'token'), token) }
}

function onBoard(team: ReturnType<typeof testBoard>, sending: (request: Request) => void = () => {}, url = BOARD_URL) {
  const transport = connect(url, {
    fetch: (input, init) => {
      const request = new Request(input, init)
      sending(request)
      return team.fetch(request)
    },
  })
  return { transport, client: board({ backend: http(url, { fetch: transport.fetch }) }).as(null) }
}

async function commandScript(body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'board-token-command-'))
  dirs.push(dir)
  const head = 'cd "$(dirname "$0")"\necho "run${BOARD_TOKEN_REFRESH:+ refresh}" >> runs\nn=$(wc -l < runs | tr -d " ")\n'
  const gate = 'wait_for_go() { while [ ! -f go ]; do sleep 0.02; done; }\n'
  await writeFile(join(dir, 'print.sh'), `${head}${gate}${body}\n`)
  vi.stubEnv('BOARD_TOKEN_COMMAND', `sh '${join(dir, 'print.sh')}'`)
  const runs = async () => {
    const log = await readFile(join(dir, 'runs'), 'utf8').catch(() => '')
    return log.split('\n').filter(Boolean)
  }
  return { runs, go: () => writeFile(join(dir, 'go'), '') }
}

function fakeBoard(...accepted: string[]) {
  const sent: (string | null)[] = []
  const gates: (() => void)[] = []
  const cancels: (() => void)[] = []
  let holding = 0
  let stalling = false
  const stalledBody = () => new ReadableStream({ cancel: () => new Promise<void>((resolve) => cancels.push(resolve)) })
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? null
    sent.push(token)
    if (holding > 0) {
      holding -= 1
      await new Promise<void>((resolve) => gates.push(resolve))
    }
    if (token && accepted.includes(token)) return new Response(null, { status: 200 })
    const body = stalling ? stalledBody() : null
    stalling = false
    return new Response(body, { status: 401 })
  }
  const release = (...held: number[]) => held.forEach((index) => gates[index]!())
  const accept = (...tokens: string[]) => void accepted.splice(0, accepted.length, ...tokens)
  return {
    fetch,
    sent,
    accept,
    release,
    hold: (count: number) => void (holding += count),
    held: () => gates.length,
    stallCancel: () => void (stalling = true),
    cancelling: () => cancels.length,
    finishCancels: () => cancels.forEach((resolve) => resolve()),
  }
}

const handled = <T>(pending: Promise<T>) => {
  pending.catch(() => {})
  return pending
}

const ME = `${BOARD_URL}/me`

async function refusalDuringARun(second: string) {
  const command = await commandScript(`if [ -n "$BOARD_TOKEN_REFRESH" ]; then echo good; elif [ "$n" = 1 ]; then echo first; else ${second}; fi`)
  const team = fakeBoard('first', 'good')
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
  const start = Date.now()
  const connection = connect(BOARD_URL, { fetch: team.fetch })
  expect((await connection.fetch(ME)).status).toBe(200)
  team.hold(1)
  const refused = handled(connection.fetch(ME))
  await vi.waitFor(() => expect(team.held()).toBe(1))
  team.accept('good')
  vi.setSystemTime(start + 4 * 60_000 + 30_000)
  const during = handled(connection.fetch(new Request(ME)))
  await vi.waitFor(async () => expect(await command.runs()).toHaveLength(2))
  return { command, team, connection, refused, during }
}

const later = (ms: number) => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
  vi.setSystemTime(Date.now() + ms)
}

describe('BOARD_TOKEN_COMMAND', () => {
  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('runs once while its token is fresh, ahead of BOARD_TOKEN, and again a minute before it expires', async () => {
    clean()
    const team = testBoard()
    const command = await tokenCommand(await personToken('u_julian'))
    vi.stubEnv('BOARD_TOKEN', await personToken('u_ada'))
    const { transport, client } = onBoard(team)
    const [me] = await Promise.all([client.me(), client.channel('dev').messages()])
    expect(me.principal).toBe('vercel:user:u_julian')
    await client.post('dev', 'one')
    await client.me()
    expect(await command.runs()).toEqual(['run'])
    expect(transport.source()).toBe('BOARD_TOKEN_COMMAND')

    later(59 * 60_000 + 30_000)
    await command.print(await personToken('u_bob'))
    expect((await client.me()).principal).toBe('vercel:user:u_bob')
    await client.me()
    expect(await command.runs()).toEqual(['run', 'run'])
  })

  it("fails with what went wrong, and none of what it printed, when the command doesn't print one token", async () => {
    clean()
    const team = testBoard()
    const refused = {
      'exit 3': 'exited with 3',
      true: 'printed nothing',
      "printf 'secret-one secret-two'": "printed something that isn't a bearer token",
      "printf 'secret\\001'": "printed something that isn't a bearer token",
      "head -c 70000 /dev/zero | tr '\\0' s": 'printed more than 64 KiB',
      'yes é | head -c 70000': 'printed more than 64 KiB',
    }
    for (const [command, why] of Object.entries(refused)) {
      vi.stubEnv('BOARD_TOKEN_COMMAND', command)
      const failed = await onBoard(team).client.me().catch((error: Error) => error)
      expect(failed).toMatchObject({ code: 'no_token', message: `BOARD_TOKEN_COMMAND ${why}, so there's no token to send.` })
      expect(JSON.stringify(failed)).not.toMatch(/secret|sss/)
    }
  })

  it('runs without a BOARD_TOKEN_REFRESH it inherited until the board refuses a token', async () => {
    clean()
    const command = await tokenCommand(await personToken('u_julian'))
    vi.stubEnv('BOARD_TOKEN_REFRESH', '1')
    const { client } = onBoard(testBoard())
    await client.me()
    expect(await command.runs()).toEqual(['run'])
  })

  it('runs again once, with BOARD_TOKEN_REFRESH set, and resends when the board refuses its token', async () => {
    clean()
    const team = testBoard()
    const command = await tokenCommand(await personToken('u_julian', 'https://elsewhere.test/api/board'), await personToken('u_julian'))
    const { client } = onBoard(team)
    expect((await client.post('dev', 'after a refusal')).by.principal).toBe('vercel:user:u_julian')
    expect(await command.runs()).toEqual(['run', 'run refresh'])
    const { messages } = await client.channel('dev').messages()
    expect(messages.map((m) => m.text)).toEqual(['after a refusal'])
  })

  it("gives up on a refusal when the command prints the refused token again, and sends it once", async () => {
    clean()
    const team = testBoard()
    const command = await tokenCommand(await personToken('u_julian', 'https://elsewhere.test/api/board'))
    const sent: string[] = []
    const { client } = onBoard(team, (request) => void sent.push(new URL(request.url).pathname))
    const refused = { code: 'no_token', message: "BOARD_TOKEN_COMMAND printed a token the board refused, so there's no token to send." }
    await expect(client.me()).rejects.toMatchObject(refused)
    await expect(client.me()).rejects.toMatchObject(refused)
    expect(await command.runs()).toEqual(['run', 'run refresh', 'run refresh'])
    expect(sent.filter((path) => path === '/api/board/me')).toHaveLength(1)
  })

  it('runs the command for the board each connection calls, with its URL as BOARD_URL', async () => {
    clean()
    const other = 'http://other.test/api/board'
    vi.stubEnv('BOARD_URL', 'http://elsewhere.test/api/board')
    const dir = await mkdtemp(join(tmpdir(), 'board-token-command-'))
    dirs.push(dir)
    const julian = await personToken('u_julian')
    await writeFile(join(dir, BOARD_URL.split('/')[2]!), julian)
    await writeFile(join(dir, other.split('/')[2]!), await personToken('u_ada', other))
    await writeFile(join(dir, 'print.sh'), 'cd "$(dirname "$0")"\necho "$BOARD_URL${BOARD_TOKEN_REFRESH:+ refresh}" >> runs\ncat "$(echo "$BOARD_URL" | cut -d/ -f3)"\n')
    vi.stubEnv('BOARD_TOKEN_COMMAND', `sh '${join(dir, 'print.sh')}'`)
    const here = onBoard(testBoard()).client
    const toOther: (string | null)[] = []
    const there = onBoard(testBoard({ url: other }), (request) => void toOther.push(request.headers.get('authorization')), other).client
    expect((await here.me()).principal).toBe('vercel:user:u_julian')
    expect((await there.me()).principal).toBe('vercel:user:u_ada')
    await Promise.all([here.me(), there.me()])
    const runs = await readFile(join(dir, 'runs'), 'utf8')
    expect(runs.split('\n').filter(Boolean)).toEqual([BOARD_URL, other])
    expect(toOther).not.toContain(`Bearer ${julian}`)
  })

  it('keeps a live feed going past the token it started with', async () => {
    clean()
    const team = testBoard()
    const command = await tokenCommand(await personToken('u_julian'))
    const polls: (string | null)[] = []
    const { client } = onBoard(team, (request) => {
      if (new URL(request.url).pathname === '/api/board/events') polls.push(request.headers.get('authorization'))
    })
    const writer = board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => team.fetch(new Request(input, init)), () => personToken('u_ada')) }) }).as(null)
    const stop = new AbortController()
    const feed = client.events({ channel: 'dev' }, { signal: stop.signal })[Symbol.asyncIterator]()
    try {
      const first = feed.next()
      await vi.waitFor(() => expect(polls).toHaveLength(2))
      await writer.post('dev', 'one')
      expect((await first).value).toMatchObject({ message: { text: 'one' } })

      later(61 * 60_000)
      const fresh = await personToken('u_julian')
      await command.print(fresh)
      const second = feed.next()
      await vi.waitFor(() => expect(polls).toHaveLength(3))
      await writer.post('dev', 'two')
      expect((await second).value).toMatchObject({ message: { text: 'two' } })
      expect(polls[2]).toBe(`Bearer ${fresh}`)
      expect(await command.runs()).toEqual(['run', 'run'])
    } finally {
      stop.abort()
      await feed.return(undefined)
    }
  })

  it('keeps a refresh pending through a failed run, so the next request refreshes before it sends', async () => {
    clean()
    const refused = await personToken('u_julian', 'https://elsewhere.test/api/board')
    const good = await personToken('u_julian')
    const command = await commandScript(`case "$n" in 1) echo '${refused}' ;; 2) exit 1 ;; *) echo '${good}' ;; esac`)
    const sent: (string | null)[] = []
    const { client } = onBoard(testBoard(), (request) => {
      if (new URL(request.url).pathname === '/api/board/me') sent.push(request.headers.get('authorization'))
    })
    await expect(client.me()).rejects.toThrow('BOARD_TOKEN_COMMAND exited with 1')
    expect((await client.me()).principal).toBe('vercel:user:u_julian')
    expect(await command.runs()).toEqual(['run', 'run refresh', 'run refresh'])
    expect(sent).toEqual([`Bearer ${refused}`, `Bearer ${good}`])
  })

  it('stops an exec\'d helper past 6 minutes, and fails only once it is gone', async () => {
    clean()
    const dir = await mkdtemp(join(tmpdir(), 'board-token-command-'))
    dirs.push(dir)
    const helper = `"${process.execPath}" -e "require('fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000)"`
    vi.stubEnv('BOARD_TOKEN_COMMAND', `cd '${dir}' && exec ${helper}; echo after > after`)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const failed = onBoard(testBoard()).client.me().catch((error: Error) => error)
    while (!existsSync(join(dir, 'pid'))) await sleep(20)
    const pid = Number(await readFile(join(dir, 'pid'), 'utf8'))
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(await failed).toMatchObject({ code: 'no_token', message: expect.stringContaining('took longer than 6 minutes') })
    const alive = () => {
      try {
        return process.kill(pid, 0)
      } catch {
        return false
      }
    }
    expect(alive()).toBe(false)
    await sleep(200)
    expect(existsSync(join(dir, 'after'))).toBe(false)
  })

  it("is never run for a team's board in Vercel's API, even with BOARD_URL set", async () => {
    clean()
    vi.stubEnv('BOARD_URL', BOARD_URL)
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'vercel-login')
    const command = await tokenCommand('from-command')
    const api = fakeMessageboard({ teamId: 'team_acme', slug: 'acme', boards: [{ name: 'security' }], tokens: { 'vercel-login': 'user:u_ada' } })
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => api.fetch(input, init))
    const scoped = board({ backend: vercel({ team: 'acme' }) })
    const named = board({ backend: vercel({ team: 'acme' }), name: 'security' })
    expect((await scoped.me()).principal).toBe('vercel:user:u_ada')
    expect((await named.me()).principal).toBe('vercel:user:u_ada')
    expect(await command.runs()).toEqual([])
  })

  it("is never run for a URL on Vercel's API, so its token never goes there", async () => {
    clean()
    const command = await tokenCommand('from-command')
    const sent: (string | null)[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('authorization'))
      return Response.json({ error: { code: 'not_found', message: 'no board' } }, { status: 404 })
    })
    for (const url of ['https://api.vercel.com/v1/messageboard/boards/security', 'https://API.Vercel.com./v1/messageboard/boards/security']) {
      vi.stubEnv('BOARD_URL', url)
      await expect(board().me()).rejects.toThrow()
    }
    expect(await command.runs()).toEqual([])
    expect(sent).not.toContain('Bearer from-command')
  })

  it('keeps a token that names no expiry for five minutes from the run that printed it, on each connection', async () => {
    clean()
    const command = await tokenCommand('opaque-token')
    const answer = async () => Response.json({})
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    const start = Date.now()
    const first = connect(BOARD_URL, { fetch: answer })
    await first.fetch(ME)
    vi.setSystemTime(start + 3 * 60_000 + 30_000)
    const second = connect(BOARD_URL, { fetch: answer })
    await second.fetch(ME)
    await first.fetch(ME)
    expect(await command.runs()).toEqual(['run', 'run'])
    vi.setSystemTime(start + 4 * 60_000 + 30_000)
    await first.fetch(ME)
    await second.fetch(ME)
    expect(await command.runs()).toEqual(['run', 'run', 'run'])
  })

  it('refreshes when a refusal lands during a run that prints the refused token, and never sends what that run printed', async () => {
    clean()
    const { command, team, connection, refused, during } = await refusalDuringARun('wait_for_go; echo first')
    team.release(0)
    await command.go()
    expect((await refused).status).toBe(200)
    expect((await during).status).toBe(200)
    expect((await connection.fetch(new Request(ME))).status).toBe(200)
    expect(await command.runs()).toEqual(['run', 'run', 'run refresh'])
    expect(team.sent.filter((token) => token === 'first')).toHaveLength(2)
  })

  it('refreshes when a refusal lands during a run that then fails', async () => {
    clean()
    const { command, team, connection, refused, during } = await refusalDuringARun('wait_for_go; exit 1')
    team.release(0)
    await command.go()
    expect((await refused).status).toBe(200)
    await expect(during).rejects.toThrow('BOARD_TOKEN_COMMAND exited with 1')
    expect((await connection.fetch(ME)).status).toBe(200)
    expect(await command.runs()).toEqual(['run', 'run', 'run refresh'])
  })

  it('refreshes when a refusal lands just after a run failed', async () => {
    clean()
    const { command, team, refused, during } = await refusalDuringARun('exit 1')
    await expect(during).rejects.toThrow('BOARD_TOKEN_COMMAND exited with 1')
    team.release(0)
    expect((await refused).status).toBe(200)
    expect(await command.runs()).toEqual(['run', 'run', 'run refresh'])
  })

  it('keeps the new token through a late refusal of the one it replaced', async () => {
    clean()
    const command = await commandScript('if [ -n "$BOARD_TOKEN_REFRESH" ]; then echo good; else echo first; fi')
    const team = fakeBoard('first')
    const connection = connect(BOARD_URL, { fetch: team.fetch })
    expect((await connection.fetch(ME)).status).toBe(200)
    team.hold(2)
    const [refused, late] = [connection.fetch(ME), connection.fetch(ME)]
    await vi.waitFor(() => expect(team.held()).toBe(2))
    team.accept('good')
    team.release(0)
    expect((await refused).status).toBe(200)
    team.release(1)
    expect((await late).status).toBe(200)
    expect((await connection.fetch(ME)).status).toBe(200)
    expect(await command.runs()).toEqual(['run', 'run refresh'])
    later(4 * 60_000 + 30_000)
    expect((await connection.fetch(ME)).status).toBe(200)
    expect(await command.runs()).toEqual(['run', 'run refresh', 'run', 'run refresh'])
    expect(team.sent.filter((token) => token === 'first')).toHaveLength(3)
  })

  it.each(['two', 'one'])("shares one refresh between refusals of two tokens, and spends neither request's retry on a refused token when the refresh prints %s", async (reprinted) => {
    clean()
    const command = await commandScript(`case "$n" in 1) echo one ;; 2) echo two ;; 3) echo ${reprinted} ;; *) echo good ;; esac`)
    const team = fakeBoard('one')
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    const start = Date.now()
    const connection = connect(BOARD_URL, { fetch: team.fetch })
    expect((await connection.fetch(ME)).status).toBe(200)
    team.hold(1)
    const older = handled(connection.fetch(ME))
    await vi.waitFor(() => expect(team.held()).toBe(1))
    team.accept('two')
    vi.setSystemTime(start + 4 * 60_000 + 30_000)
    expect((await connection.fetch(ME)).status).toBe(200)
    team.hold(1)
    const newer = handled(connection.fetch(ME))
    await vi.waitFor(() => expect(team.held()).toBe(2))
    team.accept('good')
    team.release(1, 0)
    await expect(newer).rejects.toMatchObject({ code: 'no_token' })
    await expect(older).rejects.toMatchObject({ code: 'no_token' })
    expect((await connection.fetch(ME)).status).toBe(200)
    expect(team.sent).toEqual(['one', 'one', 'two', 'two', 'good'])
    expect(await command.runs()).toEqual(['run', 'run', 'run refresh', 'run refresh'])
  })

  it("fails with the command's failure when the refresh fails, without waiting for the refusal to be cancelled", async () => {
    clean()
    await commandScript('case "$n" in 1) echo a ;; *) exit 1 ;; esac')
    const team = fakeBoard('b')
    const connection = connect(BOARD_URL, { fetch: team.fetch })
    team.stallCancel()
    await expect(connection.fetch(ME)).rejects.toThrow('BOARD_TOKEN_COMMAND exited with 1')
    team.finishCancels()
  })

  it('retries with the token that replaced the one it picked while the refusal was being cancelled', async () => {
    clean()
    const command = await commandScript('case "$n" in 1) echo a ;; 2) echo b ;; *) echo c ;; esac')
    const team = fakeBoard('b')
    const connection = connect(BOARD_URL, { fetch: team.fetch })
    team.stallCancel()
    const first = handled(connection.fetch(ME))
    await vi.waitFor(() => expect(team.cancelling()).toBe(1))
    team.accept('c')
    const second = handled(connection.fetch(ME))
    expect((await second).status).toBe(200)
    team.finishCancels()
    expect((await first).status).toBe(200)
    expect(await command.runs()).toEqual(['run', 'run refresh', 'run refresh'])
  })

  it('refreshes on the next request after a 401 it could not retry: on a Request, or on the retry itself', async () => {
    clean()
    const command = await commandScript('case "$n" in 1) echo a ;; 2) echo b ;; 3) echo c ;; *) echo d ;; esac')
    const team = fakeBoard('d')
    const connection = connect(BOARD_URL, { fetch: team.fetch })
    expect((await connection.fetch(new Request(ME))).status).toBe(401)
    expect((await connection.fetch(ME)).status).toBe(401)
    expect((await connection.fetch(new Request(ME))).status).toBe(200)
    expect(team.sent).toEqual(['a', 'b', 'c', 'd'])
    expect(await command.runs()).toEqual(['run', 'run refresh', 'run refresh', 'run refresh'])
  })

  it('ends a live feed with the failure when the command fails, rather than retrying it', async () => {
    clean()
    vi.stubEnv('BOARD_TOKEN_COMMAND', 'exit 3')
    const feed = onBoard(testBoard()).client.events({ channel: 'dev' })[Symbol.asyncIterator]()
    const ended = feed.next().then(() => 'an event', (error: Error) => error)
    const settled = await Promise.race([ended, sleep(3_000).then(() => 'still retrying')])
    expect(settled).toMatchObject({ code: 'no_token', message: "BOARD_TOKEN_COMMAND exited with 3, so there's no token to send." })
  })
})
