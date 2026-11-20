# CE Router

A TypeScript-based router service for Compiler Explorer that handles compilation requests and routes them to appropriate backend services.

## Features

- **Environment-based routing**: Support for production, beta, and staging environments
- **Multiple routing modes**: Queue-based (SQS) and URL-based forwarding
- **WebSocket integration**: Real-time compilation results via WebSocket connections
- **S3 overflow support**: Automatic handling of large compilation outputs via S3 storage
- **Compilation cache check**: A compile request whose result is already in the workers' compilation cache is answered
  from there instead of being queued; hits, misses and skipped checks are counted on `GET /metrics`
- **Comprehensive logging**: Winston-based structured logging with remote logging support
- **CORS support**: Cross-origin request handling for web frontends

## Development

```bash
# Install dependencies
npm install

# Run in development mode with hot reload
npm run dev

# Build for production
npm run build

# Run tests
npm run test

# Lint and format code
npm run lint

# Type check
npm run typecheck
```

## Usage

### From Release Archive

Download the latest release archive from [GitHub Releases](../../releases) and extract it:

```bash
# Extract the release archive
unzip ce-router-v1.0.0.zip
cd ce-router-v1.0.0

# Start the server (environment is required)
node index.js --env prod

# With custom port
node index.js --env prod --port 8080

# With remote logging
node index.js --env prod --logHost logs.example.com --logPort 514

# With custom WebSocket URL
node index.js --env prod --websocket wss://custom.websocket.url
```

### From Source

```bash
# Start the server (environment is required)
node dist/index.js --env prod

# With custom port
node dist/index.js --env prod --port 8080

# With remote logging
node dist/index.js --env prod --logHost logs.example.com --logPort 514

# With custom WebSocket URL
node dist/index.js --env prod --websocket wss://custom.websocket.url
```

## CLI Parameters

| Parameter | Short | Description | Default | Required |
|-----------|-------|-------------|---------|----------|
| `--env` | | Environment: `prod`, `beta`, or `staging` | | ✅ |
| `--port` | `-p` | Port to run the server on | `10240` | |
| `--websocket` | `-w` | WebSocket server URL | Environment-specific | |
| `--logHost` | | Hostname for remote logging | | |
| `--logPort` | | Port for remote logging | | |
| `--sqs-max-size` | | Maximum SQS message size in bytes | `262144` | |
| `--s3-overflow-bucket` | | S3 bucket for overflow messages | `temp-storage.godbolt.org` | |
| `--s3-overflow-prefix` | | S3 key prefix for overflow messages | `sqs-overflow/` | |
| `--help` | `-h` | Show help information | | |
| `--version` | `-V` | Show version number | | |

## Environment Variables

- AWS credentials for SQS, DynamoDB, and SSM access, and read access to the compilation cache in S3
- `COMPILATION_CACHE_CHECK=false` turns the compilation cache check off
- `COMPILER_LIST_URL` overrides where the compiler settings for the cache check come from (default: the environment's
  `/api/compilers` on godbolt.org)

## License

MIT