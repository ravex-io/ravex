// Creates two ChatEngines with the auth options given as JSON in argv[2], in a fresh process,
// so the once-per-process startup warning can be counted on stderr.
import { createServer } from 'http'
import { ChatEngine } from '@ravex/server'

const options = JSON.parse(process.argv[2] ?? '{}')
if (options.authenticate) options.authenticate = () => ({ id: 'u1' })
for (let i = 0; i < 2; i++) {
  const engine = new ChatEngine(createServer(), { ...options, presence: { heartbeat: false } })
  engine.destroy()
  engine.io.close()
}
