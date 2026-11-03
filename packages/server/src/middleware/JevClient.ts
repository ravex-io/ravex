/**
 * Minimal client for Jev, TypeSafe AI's decision model (POST /v1/systemone).
 * Uses the global `fetch` (Node 18+), so moderation adds no dependency. Never throws: every
 * outcome, including network errors and timeouts, comes back as a `JevResult`.
 */

export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai'
const SYSTEM_ONE_PATH = '/v1/systemone'
const REQUEST_ID_HEADER = 'x-typesafe-request-id'

/** One attempt never waits longer than this (TypeSafe's guidance for interactive paths). */
const ATTEMPT_TIMEOUT_MS = 2000
const MAX_RETRIES = 1
const RETRY_DELAY_MS = 250
/** Don't start a retry that would have less time than this to answer. */
const MIN_ATTEMPT_MS = 250
const MS_PER_SECOND = 1000
/** Error details from Jev are cut to this length before they reach a log. */
const MAX_DETAIL_LENGTH = 200

const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_REQUEST_TIMEOUT = 408
const HTTP_PAYLOAD_TOO_LARGE = 413
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_SERVER_ERROR = 500
const HTTP_OVERLOADED = 529

export interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria: { true: string; false: string }
}

export interface SystemOneRequest {
  model: string
  state: Record<string, unknown>
  questions: Record<string, NoulQuestion>
}

/**
 * - timeout: our per-attempt timer fired, or HTTP 408
 * - network: DNS, refused or reset connection, blocked redirect
 * - rate_limited: 429; overloaded: 529; server_error: any other 5xx
 * - auth: 401 / 403, a missing or invalid API key
 * - rejected: 400 / 413, Jev refused this input (e.g. over its token limit)
 * - config: any other 4xx, a wrong model, base URL or request shape
 * - invalid_response: 2xx without the answers we asked for
 */
export type JevFailureKind =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'overloaded'
  | 'server_error'
  | 'auth'
  | 'rejected'
  | 'config'
  | 'invalid_response'

export interface JevFailure {
  ok: false
  kind: JevFailureKind
  status?: number
  requestId?: string
  retryAfterMs?: number
  /** Safe to log: an error code or field path from the response, or Node's own network error. Never response text. */
  detail?: string
}

export interface JevAnswers {
  ok: true
  /** The versioned model that answered, e.g. 'jev-1.14.0'. */
  model: string
  /** Probability (0..1) per question name. */
  nouls: Record<string, number>
  requestId?: string
}

export type JevResult = (JevAnswers | JevFailure) & { attempts: number }

const RETRYABLE = new Set<JevFailureKind>([
  'timeout',
  'network',
  'rate_limited',
  'overloaded',
  'server_error',
])

type Post = (body: string, signal: AbortSignal) => Promise<Response>

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const kindForStatus = (status: number): JevFailureKind => {
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return 'auth'
  if (status === HTTP_REQUEST_TIMEOUT) return 'timeout'
  if (status === HTTP_TOO_MANY_REQUESTS) return 'rate_limited'
  if (status === HTTP_OVERLOADED) return 'overloaded'
  if (status >= HTTP_SERVER_ERROR) return 'server_error'
  if (status === HTTP_BAD_REQUEST || status === HTTP_PAYLOAD_TOO_LARGE) return 'rejected'
  return 'config'
}

/** `Retry-After` as delta-seconds or an HTTP date, in ms. */
export const parseRetryAfter = (value: string | null, now = Date.now()): number | undefined => {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * MS_PER_SECOND
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

/** What a code-like diagnostic field (error type, field name, request id) may contain; anything else is dropped. */
const DIAGNOSTIC_TOKEN = /^[\w.:-]{1,128}$/u

const diagnostic = (value: unknown): string | undefined =>
  typeof value === 'string' && DIAGNOSTIC_TOKEN.test(value) ? value : undefined

/** A validation error's `loc`, e.g. body.state.message.text. */
const fieldPath = (loc: unknown): string | undefined => {
  if (!Array.isArray(loc) || loc.length === 0) return undefined
  return loc
    .map((part) => (Number.isInteger(part) ? String(part) : (diagnostic(part) ?? '?')))
    .join('.')
}

const truncate = (text: string): string | undefined => {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  return trimmed.length > MAX_DETAIL_LENGTH ? `${trimmed.slice(0, MAX_DETAIL_LENGTH)}…` : trimmed
}

/**
 * The part of an error response that may reach a log. Only fields that hold codes are kept: the
 * `error_type` of an error object, and the `type` and `loc` of a validation error's first problem.
 * Free text (`message`, `msg`, `input`, a string `detail`, a body that isn't JSON) can echo the
 * screened message, so it is dropped.
 */
const responseDetail = (body: string): string => {
  const parsed = parseJson(body)
  const detail = isRecord(parsed) ? parsed.detail : undefined
  if (isRecord(detail)) return diagnostic(detail.error_type) ?? ''
  const first: unknown = Array.isArray(detail) ? detail[0] : undefined
  if (!isRecord(first)) return ''
  const type = diagnostic(first.type)
  const path = fieldPath(first.loc)
  return [type, path === undefined ? undefined : `at ${path}`]
    .filter((part) => part !== undefined)
    .join(' ')
}

interface PreparedRequest {
  body: string
  names: string[]
  model: string
}

const parseAnswers = (
  body: string,
  { names, model: requestedModel }: PreparedRequest,
): JevAnswers | undefined => {
  const parsed = parseJson(body)
  if (!isRecord(parsed) || !isRecord(parsed.answers)) return undefined
  const nouls: Record<string, number> = {}
  for (const name of names) {
    const answer = parsed.answers[name]
    if (!isRecord(answer) || answer.type !== 'noul') return undefined
    const { noul } = answer
    if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) return undefined
    nouls[name] = noul
  }
  const model = typeof parsed.model === 'string' ? parsed.model : requestedModel
  return { ok: true, model, nouls }
}

export class JevClient {
  // The key lives only in this closure, so inspecting the engine never shows it.
  private readonly post: Post
  /** Removes the key from text that reaches a log, in case an error ever echoes it, and caps its length. */
  private readonly redact: (text: string) => string | undefined
  private readonly inFlight = new Set<AbortController>()
  private readonly sleeping = new Set<() => void>()
  private destroyed = false

  constructor(apiKey: string, baseUrl: string) {
    const url = baseUrl.replace(/\/+$/u, '') + SYSTEM_ONE_PATH
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    // `fetch` is looked up on every call, not captured at load time. redirect: 'error' keeps the
    // Authorization header from ever following a redirect to another host.
    this.post = (body, signal) =>
      fetch(url, { method: 'POST', headers, body, signal, redirect: 'error' })
    this.redact = (text) => truncate(text.split(apiKey).join('[redacted]'))
  }

  /** Asks the questions, retrying transient failures once, all within `budgetMs`. */
  async systemOne(request: SystemOneRequest, budgetMs: number): Promise<JevResult> {
    const deadline = Date.now() + budgetMs
    const prepared = {
      body: JSON.stringify(request),
      names: Object.keys(request.questions),
      model: request.model,
    }
    let attempts = 0
    for (;;) {
      attempts++
      // eslint-disable-next-line no-await-in-loop
      const result = await this.attempt(
        prepared,
        Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now()),
      )
      if (result.ok || !RETRYABLE.has(result.kind) || attempts > MAX_RETRIES || this.destroyed) {
        return { ...result, attempts }
      }
      const delay = result.retryAfterMs ?? RETRY_DELAY_MS
      if (Date.now() + delay + MIN_ATTEMPT_MS > deadline) return { ...result, attempts }
      // eslint-disable-next-line no-await-in-loop
      await this.sleep(delay)
    }
  }

  /** Aborts every request in flight and ends retry waits; later calls fail at once. */
  destroy(): void {
    this.destroyed = true
    for (const controller of this.inFlight) controller.abort()
    for (const wake of this.sleeping) wake()
    this.inFlight.clear()
    this.sleeping.clear()
  }

  /** A wait that destroy() ends early, so a long retry-after never holds up shutdown. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        this.sleeping.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      this.sleeping.add(wake)
    })
  }

  private async attempt(
    request: PreparedRequest,
    timeoutMs: number,
  ): Promise<JevAnswers | JevFailure> {
    if (this.destroyed) return { ok: false, kind: 'network', detail: 'moderation was shut down' }
    const controller = new AbortController()
    this.inFlight.add(controller)
    let timedOut = false
    // Armed until the body has been read, so a response that stalls mid-body also times out.
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const res = await this.post(request.body, controller.signal)
      const requestId = diagnostic(res.headers.get(REQUEST_ID_HEADER))
      const text = await res.text()
      if (!res.ok) {
        return {
          ok: false,
          kind: kindForStatus(res.status),
          status: res.status,
          requestId,
          retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
          detail: this.redact(responseDetail(text)),
        }
      }
      const answers = parseAnswers(text, request)
      return answers
        ? { ...answers, requestId }
        : { ok: false, kind: 'invalid_response', status: res.status, requestId }
    } catch (err) {
      if (timedOut) return { ok: false, kind: 'timeout' }
      // fetch rejects with a generic "fetch failed"; the useful reason (ECONNREFUSED, …) is its cause.
      // Node writes these messages itself, from the connection, never from the response body.
      const cause: unknown = (err as { cause?: unknown } | undefined)?.cause
      const reason = cause instanceof Error ? cause : err
      return {
        ok: false,
        kind: 'network',
        detail: this.redact(reason instanceof Error ? reason.message : String(reason)),
      }
    } finally {
      clearTimeout(timer)
      this.inFlight.delete(controller)
    }
  }
}
