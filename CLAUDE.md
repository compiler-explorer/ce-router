# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm run dev` - Start development server with hot reload using tsx watch
- `npm run build` - Compile TypeScript to JavaScript in dist/ directory
- `npm start` - Run the built application from dist/
- `npm test` - Run all tests using Vitest
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage report
- `npm run lint` - Format and lint code using Biome (auto-fixes issues)
- `npm run lint:check` - Check linting without auto-fixing
- `npm run typecheck` - Run TypeScript type checking without compilation

## Project Architecture

### Core Services
- **Express Router Service**: Main HTTP server handling compilation and cmake requests for Compiler Explorer
- **WebSocket Manager** (`src/services/websocket-manager.ts`): Robust WebSocket client with automatic reconnection, subscription management, and ping/pong keepalive
- **AWS Clients** (`src/services/aws-clients.ts`): Pre-configured AWS SDK v3 clients for DynamoDB, S3, SQS, SSM, and STS

### Key Endpoints
- `POST /api/compiler/:compilerid/compile` - Handles compilation requests for specific compilers
- `POST /api/compiler/:compilerid/cmake` - Handles CMake build requests
- `GET /healthcheck` - Health status including WebSocket connection state

### WebSocket Integration
The service maintains a persistent WebSocket connection to `wss://events.compiler-explorer.com/beta` (configurable) for real-time communication. The WebSocketManager provides:
- Automatic reconnection with exponential backoff
- Topic-based subscription/unsubscription
- Message serialization/deserialization
- Connection health monitoring via ping/pong

### Configuration
- Port: Environment variable `PORT` or CLI flag `--port` (default: 3000)
- WebSocket URL: Environment variable `WEBSOCKET_URL` or CLI flag `--websocket`
- AWS Region: Environment variable `AWS_REGION` (default: us-east-1)

### Build & Tooling
- **TypeScript**: ES2022 target with NodeNext module resolution
- **Biome**: Used for both linting and formatting (4-space indentation, 120 char line width)
- **Vitest**: Test runner with coverage support and mocking
- **ESM**: Project uses ES modules with .js extensions in imports

### Code Style
- 4-space indentation
- Single quotes for strings
- Trailing commas
- 120 character line width
- Strict TypeScript configuration with unused parameter/local detection

The codebase is a TypeScript replacement for an AWS Lambda function, designed to handle Compiler Explorer routing requests with WebSocket-based real-time communication.
- always lint and check the code when you have finished code changes