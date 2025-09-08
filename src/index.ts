import {Command} from 'commander';
import {CompilerExplorerRouter} from './compiler-explorer-router.js';

// Environment variables
const TIMEOUT_SECONDS = Number.parseInt(process.env.TIMEOUT_SECONDS || '60', 10);

// Parse command line arguments
const program = new Command();
program
    .name('ce-router')
    .description('Compiler Explorer Router Service')
    .version('1.0.0')
    .option('-p, --port <port>', 'port to run the server on', '3000')
    .option('-w, --websocket <url>', 'WebSocket server URL', 'wss://events.compiler-explorer.com/beta')
    .parse();

const options = program.opts();
const PORT = process.env.PORT || options.port;
const WEBSOCKET_URL = process.env.WEBSOCKET_URL || options.websocket;

async function main() {
    console.log('Starting CE Router Service...');

    // Create the router with configuration
    const router = new CompilerExplorerRouter({
        timeoutSeconds: TIMEOUT_SECONDS,
        websocketUrl: WEBSOCKET_URL,
    });

    // Start the WebSocket connection
    try {
        await router.start();
        console.log('CE Router Service started successfully');
    } catch (error) {
        console.error('Failed to start WebSocket connection:', error);
        // Continue without WebSocket - can be handled gracefully
    }

    // Start the Express server
    const app = router.getApp();
    const server = app.listen(PORT, () => {
        console.log(`Express server listening on port ${PORT}`);
    });

    // Graceful shutdown handler
    const gracefulShutdown = (signal: string) => {
        console.log(`${signal} received, shutting down gracefully...`);
        server.close(() => {
            console.log('HTTP server closed');
            router.stop();
            process.exit(0);
        });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
