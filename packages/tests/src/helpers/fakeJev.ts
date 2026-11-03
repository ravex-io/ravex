import { createServer, type IncomingHttpHeaders } from 'http'
import type { AddressInfo } from 'net'

/** A stand-in for TypeSafe's Jev API (POST /v1/systemone), so tests never call the real, billed API. */

export interface JevCall {
  /** When the request arrived (ms). */
  at: number
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: {
    model: string
    state: { message: { text: string } }
    questions: Record<
      string,
      { type: string; instructions: string; criteria?: { true: string; false: string } }
    >
  }
}

export interface JevReply {
  status?: number
  /** Sent as JSON. */
  body?: unknown
  /** Sent as-is instead of `body`. */
  raw?: string
  headers?: Record<string, string>
  /** Wait this long before answering. */
  delayMs?: number
}

export type Responder = (call: JevCall, index: number) => JevReply

export const REQUEST_ID = 'req_test_123'

/** A successful answer with the given probabilities. */
export const scores = (abusive: number, injection = 0.01, model = 'jev-1.14.0'): JevReply => ({
  body: {
    model,
    answers: {
      abusive: { type: 'noul', noul: abusive },
      injection: { type: 'noul', noul: injection },
    },
    usage: { input_tokens: 60, output_tokens: 4 },
  },
  headers: { 'x-typesafe-request-id': REQUEST_ID },
})

export const failure = (
  status: number,
  detail: unknown = 'error',
  headers: Record<string, string> = {},
): JevReply => ({
  status,
  body: { detail },
  headers: { 'x-typesafe-request-id': REQUEST_ID, ...headers },
})

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export interface FakeJev {
  url: string
  calls: JevCall[]
  /** Replaces how the next requests are answered. */
  reply(responder: Responder): void
  /** Answers the requests in order with these replies; the last one repeats. */
  replies(...list: JevReply[]): void
  /** Holds the next request until `release` is called. `aborted` resolves if the caller gives up first. */
  hold(): { started: Promise<JevCall>; release: (reply: JevReply) => void; aborted: Promise<void> }
  close(): Promise<void>
}

export async function startFakeJev(): Promise<FakeJev> {
  const calls: JevCall[] = []
  let responder: Responder = () => scores(0.01)
  let gate:
    | { started: (call: JevCall) => void; released: Promise<JevReply>; aborted: () => void }
    | undefined

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const call: JevCall = {
      at: Date.now(),
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as JevCall['body'],
    }
    calls.push(call)
    let reply: JevReply
    const current = gate
    gate = undefined
    if (current) {
      res.on('close', () => {
        if (!res.writableEnded) current.aborted()
      })
      current.started(call)
      reply = await current.released
    } else {
      reply = responder(call, calls.length - 1)
    }
    if (reply.delayMs) await sleep(reply.delayMs)
    if (res.destroyed) return
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers })
    res.end(reply.raw ?? JSON.stringify(reply.body ?? {}))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    reply(next) {
      responder = next
    },
    replies(...list) {
      let next = 0
      responder = () => list[Math.min(next++, list.length - 1)]
    },
    hold() {
      let started!: (call: JevCall) => void
      let release!: (reply: JevReply) => void
      let aborted!: () => void
      const startedP = new Promise<JevCall>((r) => {
        started = r
      })
      const releasedP = new Promise<JevReply>((r) => {
        release = r
      })
      const abortedP = new Promise<void>((r) => {
        aborted = r
      })
      gate = { started, released: releasedP, aborted }
      return { started: startedP, release, aborted: abortedP }
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}
