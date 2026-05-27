# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
