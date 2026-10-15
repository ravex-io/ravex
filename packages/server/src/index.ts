export {
  ChatEngine,
  type ChatEngineOptions,
  type HttpServerInstance,
  type PersistenceAdapter,
  type MessageMiddleware,
  type SocketData,
  type TypedNamespace,
} from './ChatEngine.js'

export { ChatError, ErrorCodes } from './utils/errors.js'
export type { Authenticate, AuthenticatedUser, Handshake } from './middleware/Auth.js'

export type { ServerOptions } from 'socket.io'
