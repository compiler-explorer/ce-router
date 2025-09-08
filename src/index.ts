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

// Parse command line arguments
const program = new Command();
program
    .name('ce-router')
    .description('Compiler Explorer Router Service')
    .version('1.0.0')
    .option('-p, --port <port>', 'port to run the server on', '3000')
    .option('-w, --websocket <url>', 'WebSocket server URL', 'wss://events.compiler-explorer.com/beta')
    .option('--logHost, --log-host <hostname>', 'Hostname for remote logging')
    .option('--logPort, --log-port <port>', 'Port for remote logging', parsePortNumberForOptions)
    .parse();

const options = program.opts();
const PORT = process.env.PORT || options.port;
const WEBSOCKET_URL = process.env.WEBSOCKET_URL || options.websocket;

async function main() {
    // Initialize logging
    initialiseLogging({
        debug: process.env.NODE_ENV !== 'production',
        logHost: options.logHost || process.env.LOG_HOST,
        logPort: options.logPort || (process.env.LOG_PORT ? Number.parseInt(process.env.LOG_PORT, 10) : undefined),
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
}

main().catch(error => {
    logger.error('Unhandled error:', error);
    process.exit(1);
});
