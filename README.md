# Ravex

![Ravex](assets/ravex-main.webp)

Plug-and-play, real-time chat system powered by Socket.IO and TypeScript.

Ravex provides a modular, fully-typed architecture to quickly add production-ready chat functionality to any application. It handles the complexities of real-time messaging, presence tracking, room isolation, and typing indicators, providing a clean promise-based client API and a robust backend engine.

## Packages

This is a monorepo built using `pnpm` workspaces, containing the following packages:

| Package | Description | Version |
|---|---|---|
| **[`@ravex/server`](./packages/server/README.md)** | The core chat engine. Binds to your Node.js HTTP server. Handles rate limiting, memory management, and socket routing. | `0.1.0` |
| **[`@ravex/client`](./packages/client/README.md)** | The frontend SDK. Provides a clean, Promise-based abstraction over `socket.io-client` with full TypeScript inference. | `0.1.0` |

## Features

- **End-to-End Type Safety**: Shared typings guarantee that client events match server expectations perfectly.
- **Promise-based API**: The `@ravex/client` package turns asynchronous socket emissions into standard `async/await` flows via server acknowledgments.
- **Built-in Systems**:
  - Presence (Online / Away / Offline with heartbeat)
  - Typing Indicators
  - Message Read Receipts
  - Emoji Reactions
  - Rate Limiting
- **Agnostic Persistence**: Bring your own database by passing a simple `PersistenceAdapter` to the server engine.

## Local Development

Ravex is managed using `pnpm`.

### Setup

```bash
# Clone the repository
git clone https://github.com/ravex-io/ravex.git
cd ravex

# Install dependencies across all workspaces
pnpm install

# Build all packages (ESM & CJS + Type declarations)
pnpm build
```

### Testing

The project uses `vitest` for end-to-end integration testing. Tests instantiate real HTTP servers and real Socket.IO clients to verify true behavior.

```bash
# Run the test suite
pnpm test

# Generate a coverage report
pnpm test:coverage
```

### Linting & Formatting

We use `oxlint` and `oxfmt` for extremely fast code verification and formatting.

```bash
# Check for linting errors
pnpm lint

# Auto-format all code
pnpm format
```

## Contributing

We welcome contributions! Please follow these steps:
1. Ensure all code passes strict TypeScript compilation (`pnpm build`).
2. Add or update integration tests in `packages/tests` if adding new functionality.
3. Ensure the test suite passes (`pnpm test`).
4. Keep the codebase completely free of `any` types.

## License

MIT © [gs-rumana](https://gs-rumana.com)
