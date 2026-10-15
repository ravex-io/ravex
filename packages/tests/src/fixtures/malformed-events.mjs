// Runs a real ChatEngine in its own process and throws malformed events at it.
// Prints "ALIVE" if the server survived and still handles a normal request afterwards.
//
//   node malformed-events.mjs <event>   emit <event> with no payload and no ack
//   node malformed-events.mjs fuzz      emit every event with many invalid argument combinations
import { createServer } from 'http'
import { ChatEngine } from '@ravex/server'
import { ChatClient } from '@ravex/client'

const EVENTS = [
  'message:send', 'message:edit', 'message:delete', 'message:read', 'message:react', 'message:history',
  'typing:start', 'typing:stop',
  'room:join', 'room:leave', 'room:create', 'room:delete', 'room:members', 'room:list',
  'presence:ping', 'presence:status',
]

const noop = () => {}
const PAYLOADS = [
  [], [null], [undefined], [42], ['text'], [true], [[]], [[1, 2]], [noop],
  [{}], [{ roomId: null }], [{ roomId: {} }], [{ roomId: 123, content: {} }],
  [{ members: 5, type: 'group' }], [{ status: 'nope' }],
]

const http = createServer()
// insecureTrustClientUser lets this test client connect with a plain auth.user
// (servers reject unauthenticated connections by default once the authenticate option lands).
new ChatEngine(http, {
  insecureTrustClientUser: true,
  presence: { heartbeat: false },
  message: { allowEdits: true, allowDeletes: true },
})
await new Promise((resolve) => http.listen(0, resolve))

const client = new ChatClient({
  url: `http://localhost:${http.address().port}`,
  auth: { user: { id: 'u1', username: 'u1', status: 'online', socketIds: [] } },
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

client.on('connect', async () => {
  const mode = process.argv[2]
  if (mode === 'fuzz') {
    for (const event of EVENTS) {
      for (const args of PAYLOADS) {
        client.rawSocket.emit(event, ...args)
        client.rawSocket.emit(event, ...args, noop)
      }
    }
  } else {
    client.rawSocket.emit(mode)
  }
  await sleep(300)

  // The server must still work for normal requests.
  const room = await client.createRoom({ type: 'group' })
  await client.sendMessage({ roomId: room.id, content: 'still alive' })
  console.log('ALIVE')
  process.exit(0)
})
