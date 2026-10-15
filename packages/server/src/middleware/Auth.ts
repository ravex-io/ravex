import type { User, UserStatus } from '@ravex/types'
import type { TypedSocket } from '../ChatEngine.js'
import { logger } from '../utils/logger.js'

/** The socket.io handshake (headers, query, `auth` payload, address…) of a connecting client. */
export type Handshake = TypedSocket['handshake']

/** The identity `authenticate` resolves to. Only `id` is required; `username` defaults to `id`. */
export interface AuthenticatedUser {
  id: string
  username?: string
  displayName?: string
  avatar?: string
  status?: UserStatus
  metadata?: Record<string, unknown>
}

export type Authenticate = (
  handshake: Handshake,
) => AuthenticatedUser | null | undefined | Promise<AuthenticatedUser | null | undefined>

/** Generic on purpose: never tell an unauthenticated client why it was rejected. */
export const AUTH_FAILED_MESSAGE = 'Authentication failed'

const STATUSES: readonly UserStatus[] = ['online', 'offline', 'away', 'busy']

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/**
 * Builds a clean `User` from an untrusted identity object, copying only known fields.
 * Returns null when there is no usable non-empty string `id`.
 */
export const toUser = (identity: unknown): User | null => {
  if (typeof identity !== 'object' || identity === null) return null
  const raw = identity as Record<string, unknown>
  const id = raw.id
  if (typeof id !== 'string' || id.trim() === '') return null

  const status = STATUSES.find((s) => s === raw.status) ?? 'online'
  const metadata = typeof raw.metadata === 'object' && raw.metadata !== null && !Array.isArray(raw.metadata)
    ? (raw.metadata as Record<string, unknown>)
    : undefined

  return {
    id,
    username: optionalString(raw.username) || id,
    displayName: optionalString(raw.displayName),
    avatar: optionalString(raw.avatar),
    status,
    metadata,
    socketIds: [],
  }
}

export interface AuthOptions {
  authenticate?: Authenticate
  insecureTrustClientUser?: boolean
}

const warned = new Set<'insecure' | 'reject-all'>()

/** Explains the auth setup once per process, at startup, when it is not production-safe. */
export const warnAuthConfig = ({ authenticate, insecureTrustClientUser }: AuthOptions): void => {
  if (authenticate) return
  const kind = insecureTrustClientUser ? 'insecure' : 'reject-all'
  if (warned.has(kind)) return
  warned.add(kind)
  logger.warn(
    kind === 'insecure'
      ? '`insecureTrustClientUser` is enabled: the user object sent by the client is trusted, ' +
          'so anyone can connect as any user. Use `authenticate` in production.'
      : 'No `authenticate` option set: every connection will be rejected. Set `authenticate` to verify users, ' +
          'or `insecureTrustClientUser: true` for local development.',
  )
}

/**
 * Resolves the user for a connecting socket. Returns null to reject the connection.
 * - With `authenticate`: the server decides who the user is; `handshake.auth.user` is ignored.
 * - With `insecureTrustClientUser`: the client-provided `handshake.auth.user` is trusted (development only).
 * - Otherwise: every connection is rejected.
 */
export const resolveUser = async (handshake: Handshake, options: AuthOptions): Promise<User | null> => {
  if (options.authenticate) return toUser(await options.authenticate(handshake))
  if (!options.insecureTrustClientUser) return null
  const auth = handshake.auth as { user?: unknown } | undefined
  return toUser(auth?.user)
}
