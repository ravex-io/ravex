# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-04

### Added
- `authenticate` option on `ChatEngine` to verify who is connecting (e.g. from a token or cookie in the handshake).
- `insecureTrustClientUser` option to trust the client-provided `auth.user` during local development.
- Optional `moderation` option on `ChatEngine` that blocks abusive messages with Jev (TypeSafe AI), using your own API key. Sent and edited text is screened before it is delivered; blocked requests are rejected with `MESSAGE_BLOCKED`. Includes `failMode`, `threshold`, `policy`, `model`, `detectInjection`, `timeoutMs` and `baseUrl` options and an `onFlagged` callback. Off by default: without it no requests are made. While it is on, edits count towards `rateLimit` and respect mutes and `maxMessageLength`, and messages with bidi override characters are rejected.
- `ChatRequestError` in `@ravex/client`: request methods now reject with an `Error` subclass that carries the server's error `code` (e.g. `MESSAGE_BLOCKED`, `ROOM_NOT_FOUND`). The message text is unchanged.

### Security
- **Breaking:** the server no longer trusts the `auth.user` object sent by the client by default, which let anyone connect as any user. Without `authenticate` every connection is rejected; set `authenticate`, or `insecureTrustClientUser: true` for development only.
- Client-provided user objects are reduced to known fields (`id`, `username`, `displayName`, `avatar`, `status`, `metadata`), and `id` must be a non-empty string.

## [0.1.1] - 2026-05-24
### Added
- Support for Common JS imports

## [0.1.0] - 2026-05-24

### Added
- **Core Platform (`@ravex/server`)**
  - Fully-typed `ChatEngine` built on top of Socket.IO.
  - Native integration with standard `http.Server`, supporting all major frameworks (Express, Fastify, NestJS, Koa, Hono).
  - Robust Room Management (Create, Join, Leave, Kick, Member Tracking).
  - Built-in Presence System with auto-away heartbeats and custom status payloads.
  - Efficient Typing Indicators with debounce and throttle handling.
  - Message Management supporting text editing, message deletion, read receipts, and emoji reactions.
  - Token-bucket based Rate Limiting to prevent spam and abuse.
  - `PersistenceAdapter` interface allowing seamless database integration (PostgreSQL, MongoDB, Redis, etc.) for chat history.

- **Frontend SDK (`@ravex/client`)**
  - Clean, Promise-based `ChatClient` wrapper around `socket.io-client`.
  - Transforms standard callback-based socket events into modern `async/await` methodology via server acknowledgments.
  - Native TypeScript inference for all event payloads and listeners.

- **Types (`@ravex/types`)**
  - Shared TypeScript interfaces ensuring perfectly synced client-server communication.
  - Strict definitions for `ClientToServerEvents`, `ServerToClientEvents`, and data models (`Message`, `Room`, `User`).

### Security
- Secure connection handshake requiring strict `auth.user` payloads.
- Strict room isolation ensuring messages are only broadcast to authorized and active room members.
- Validation checks for empty messages, oversized payloads, and invalid characters.
