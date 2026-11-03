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
export {
  DEFAULT_MODERATION_MODEL,
  DEFAULT_MODERATION_POLICY,
  type ModerationAction,
  type ModerationFlag,
  type ModerationOptions,
  type ModerationPolicy,
} from './middleware/Moderation.js'

export type { ServerOptions } from 'socket.io'
