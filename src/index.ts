import {Command} from 'commander';
import {CompilerExplorerRouter} from './compiler-explorer-router.js';
import {initialiseLogging, logger} from './lib/logger.js';

// Environment variables
const TIMEOUT_SECONDS = Number.parseInt(process.env.TIMEOUT_SECONDS || '60', 10);

/**
 * Parses a command line option into a number.
 */
function parsePortNumberForOptions(value: string): number {
    // Ensure string contains only digits
    if (!/^\d+$/.test(value)) {
        throw new Error(`Invalid port number: "${value}"`);
    }

    const parsedValue = Number.parseInt(value, 10);
    if (Number.isNaN(parsedValue) || parsedValue > 65535) {
        throw new Error(`Invalid port number: "${value}"`);
    }
    return parsedValue;
}

/**
 * Validates environment parameter.
 */
function validateEnvironment(value: string): string {
    const validEnvironments = ['prod', 'beta', 'staging'];
    if (!validEnvironments.includes(value)) {
        throw new Error(`Invalid environment: "${value}". Must be one of: ${validEnvironments.join(', ')}`);
    }
    return value;
}

// Parse command line arguments
const program = new Command();
program
    .name('ce-router')
    .description('Compiler Explorer Router Service')
    .version('1.0.0')
    .option('-p, --port <port>', 'port to run the server on', '10240')
    .option('-w, --websocket <url>', 'WebSocket server URL')
    .option('--logHost, --log-host <hostname>', 'Hostname for remote logging')
    .option('--logPort, --log-port <port>', 'Port for remote logging', parsePortNumberForOptions)
    .option('--env <environment>', 'Environment (prod, beta, staging) [required]', validateEnvironment)
    .option('--sqs-max-size <bytes>', 'Maximum SQS message size in bytes (default: 262144)')
    .option('--s3-overflow-bucket <bucket>', 'S3 bucket for overflow messages')
    .option('--s3-overflow-prefix <prefix>', 'S3 key prefix for overflow messages (default: sqs-overflow/)')
    .parse();

const options = program.opts();
const PORT = process.env.PORT || options.port;

// Environment-based configuration
function getEnvironmentConfig(env: string) {
    const configs = {
        prod: {
            websocketUrl: 'wss://events.compiler-explorer.com/prod',
            environmentName: 'prod',
        },
        beta: {
            websocketUrl: 'wss://events.compiler-explorer.com/beta',
            environmentName: 'beta',
        },
        staging: {
            websocketUrl: 'wss://events.compiler-explorer.com/staging',
            environmentName: 'staging',
        },
    };
    return configs[env as keyof typeof configs];
}

const ENV = options.env || process.env.ENVIRONMENT;
if (!ENV) {
    console.error('Error: Environment must be specified via --env option or ENVIRONMENT environment variable');
    console.error('Valid environments: prod, beta, staging');
    process.exit(1);
}
const envConfig = getEnvironmentConfig(ENV);
const WEBSOCKET_URL = process.env.WEBSOCKET_URL || options.websocket || envConfig.websocketUrl;

// Set environment name for other services to use
process.env.ENVIRONMENT_NAME = envConfig.environmentName;

// Set S3 overflow configuration from command line options
if (options.sqsMaxSize) {
    process.env.SQS_MAX_MESSAGE_SIZE = options.sqsMaxSize;
}
if (options.s3OverflowBucket) {
    process.env.S3_OVERFLOW_BUCKET = options.s3OverflowBucket;
}
if (options.s3OverflowPrefix) {
    process.env.S3_OVERFLOW_KEY_PREFIX = options.s3OverflowPrefix;
}

async function main() {
    // Initialize logging
    const logHost = options.logHost || process.env.LOG_HOST;
    initialiseLogging({
        debug: process.env.NODE_ENV !== 'production',
        logHost: logHost,
        logPort: options.logPort || (process.env.LOG_PORT ? Number.parseInt(process.env.LOG_PORT, 10) : undefined),
        suppressConsoleLog: !!logHost,
        paperTrailIdentifier: `router.${envConfig.environmentName}`,
    });

    logger.info('Starting CE Router Service...');

    // Create the router with configuration
    const router = new CompilerExplorerRouter({
        timeoutSeconds: TIMEOUT_SECONDS,
        websocketUrl: WEBSOCKET_URL,
    });

    // Start the WebSocket connection
    try {
        await router.start();
        logger.info('CE Router Service started successfully');
    } catch (error) {
        logger.error('Failed to start WebSocket connection:', error);
        // Continue without WebSocket - can be handled gracefully
    }

    // Start the Express server
    const app = router.getApp();
    const server = app.listen(PORT, () => {
        logger.info(`Express server listening on port ${PORT}`);
    });

    // Graceful shutdown handler
    const gracefulShutdown = (signal: string) => {
        logger.info(`${signal} received, shutting down gracefully...`);
        server.close(() => {
            logger.info('HTTP server closed');
            router.stop();
            process.exit(0);
        });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Add error handlers for debugging 502 issues
    process.on('uncaughtException', error => {
        logger.error('Uncaught Exception:', error);
        logger.error('Stack:', error.stack);
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });
}

main().catch(error => {
    logger.error('Unhandled error:', error);
    process.exit(1);
});
