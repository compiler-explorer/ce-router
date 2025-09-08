# CE Router

A TypeScript-based router service for Compiler Explorer that handles compilation requests and routes them to appropriate backend services.

## Features

- **Environment-based routing**: Support for production, beta, and staging environments
- **Multiple routing modes**: Queue-based (SQS) and URL-based forwarding
- **WebSocket integration**: Real-time compilation results via WebSocket connections
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
| `--help` | `-h` | Show help information | | |
| `--version` | `-V` | Show version number | | |

## Environment Variables

- `SQS_QUEUE_URL_BLUE_PROD` - Production SQS queue URL
- `SQS_QUEUE_URL_BLUE_BETA` - Beta SQS queue URL  
- `SQS_QUEUE_URL_BLUE_STAGING` - Staging SQS queue URL
- AWS credentials for SQS, DynamoDB, and SSM access

## License

MIT