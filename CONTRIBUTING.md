# Contributing to Ravex

First off, thank you for considering contributing to Ravex! It's people like you that make Ravex a robust and developer-friendly real-time chat system.

This document outlines the architecture of the monorepo, how the different packages connect, and the workflow for making changes.

## Architecture Overview

Ravex is organized as a monorepo using `pnpm` workspaces. It consists of four main packages that work together to provide an end-to-end typed chat experience:

### 1. `@ravex/types` (`packages/types`)
This is the **single source of truth** for the entire platform. It contains:
- Core data models (`User`, `Room`, `Message`).
- Socket event mappings (`ClientToServerEvents` and `ServerToClientEvents`).
- All payload types used by both the client and server.
**Note**: If you add a new feature or event, you *must* start by defining its types here.

### 2. `@ravex/server` (`packages/server`)
The backend engine. It exports the `ChatEngine` class, which takes a standard HTTP server and turns it into a socket powerhouse.
Internally, it is broken down into:
- **Core Managers** (`RoomManager`, `UserManager`): Handle state and memory.
- **Handlers** (`MessageHandler`, `PresenceHandler`, `TypingHandler`): Manage the business logic for specific domains.
- **Middleware** (`RateLimiter`): Protects against spam.

### 3. `@ravex/client` (`packages/client`)
The frontend SDK. It wraps `socket.io-client` in a modern, developer-friendly class (`ChatClient`).
- **Promise-based API**: Instead of firing an event and listening for a callback, the client wraps `socket.emit` with acknowledgments into native Promises (e.g., `await client.sendMessage(...)`).
- **Listeners**: Exposes clean, typed methods for subscribing to server streams (e.g., `client.onMessage(callback)`).

### 4. `@ravex/tests` (`packages/tests`)
A fully-isolated, black-box integration test suite powered by **Vitest**.
Instead of mocking the server or client, the test suite imports both packages organically, spins up real HTTP servers on ephemeral ports, connects real clients, and tests the physical wire transfer.

---

## Development Setup

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher)
- [pnpm](https://pnpm.io/) (v8 or higher)

### Installation
Clone the repo and install dependencies across all workspaces:

```bash
git clone https://github.com/ravex-io/ravex.git
cd ravex
pnpm install
```

### Building the Code
Because the packages depend on each other (e.g., `server` depends on `types`), you must build the monorepo before testing changes:

```bash
pnpm build
```
This command uses `tsup` to compile ESM/CJS bundles and TypeScript declaration files for all packages simultaneously.

---

## Workflow for Making Changes

1. **Update Types First**: If your change involves new data or new socket events, add them to `@ravex/types` first. Run `pnpm build` so the other packages can see your new types.
2. **Implement Server Logic**: Add the handling logic in `@ravex/server`.
3. **Implement Client API**: Expose the new functionality in `@ravex/client`.
4. **Write Tests**: Open `packages/tests/src/` and write integration tests for your new feature. Ensure the feature behaves correctly under real network conditions.
5. **Verify**:
   ```bash
   pnpm build
   pnpm test
   ```

---

## Linting & Formatting

Ravex uses **Oxlint** and **Oxfmt** for lightning-fast code analysis and formatting. The codebase is configured strictly—you must resolve all warnings and formatting issues before committing.

```bash
# Check for linting errors
pnpm lint

# Auto-format all code
pnpm format
```

### TypeScript Constraints
- **No `any`**: The `tsconfig.json` files are incredibly strict. Do not use `any`. Use `unknown` if a type is truly dynamic, or properly genericize your functions.
- **No Magic Numbers**: Constants must be extracted and named clearly.

---

## Pull Request Guidelines

- Ensure `pnpm test` passes completely (100% success rate required).
- If adding a new feature, write the corresponding integration tests in the `@ravex/tests` package.
- If altering public APIs, update the respective `README.md` files.
- Document any breaking changes in the PR description.

Thank you for contributing!
