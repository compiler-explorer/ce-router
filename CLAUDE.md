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
- **HTTP Forwarder** (`src/services/http-forwarder.ts`): Direct HTTP forwarding to target URLs with proper header handling
- **WebSocket Manager** (`src/services/websocket-manager.ts`): Robust WebSocket client with automatic reconnection, subscription management, and ping/pong keepalive
- **AWS Clients** (`src/services/aws-clients.ts`): Pre-configured AWS SDK v3 clients for DynamoDB, S3, SQS, SSM, and STS

### Key Endpoints
- `POST /api/compiler/:compilerid/compile` - Handles compilation requests for specific compilers
- `POST /api/compiler/:compilerid/cmake` - Handles CMake build requests
- `POST /:env/api/compiler/:compilerid/compile` - Environment-prefixed compilation requests (beta, staging)
- `POST /:env/api/compiler/:compilerid/cmake` - Environment-prefixed CMake requests
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

## Routing Architecture

The service supports two routing methods:

### Queue-based Routing (Default)
- Requests are sent to SQS queues for processing
- Results are returned via WebSocket connections
- Supports automatic failover and load balancing
- Used for most compilation requests

### URL-based Routing
- Direct HTTP forwarding to specific target URLs
- Configured via DynamoDB routing table
- Used for specialized compilers (e.g., GPU compilers)
- Handles HTTP header normalization to prevent protocol violations

### Important Notes
- HTTP responses automatically remove conflicting headers (e.g., `transfer-encoding` when setting `content-length`)
- Large responses (>1MB) are flagged with warnings due to ALB limits
- CORS headers are automatically added to all responses

The codebase is a TypeScript replacement for an AWS Lambda function, designed to handle Compiler Explorer routing requests with both WebSocket-based real-time communication and direct HTTP forwarding.

## Development Guidelines
- Always lint and check the code when you have finished code changes
- Use debug-level logging for detailed troubleshooting information
- Keep info-level logging for essential operational messages
- Prefer unit tests for pure functions over integration tests where possible