import express from 'express';
import type {Request, Response} from 'express';
import {Command} from 'commander';
import {WebSocketManager} from './services/websocket-manager.js';

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

interface CompilerRequest extends Request {
    params: {
        compilerid: string;
    };
}

async function main() {
    console.log('Starting CE Router Service...');

    const app = express();
    
    // Middleware - handle multiple content types
    app.use(express.json({limit: '16mb'}));
    app.use(express.text({limit: '16mb', type: 'text/plain'}));
    app.use(express.urlencoded({extended: true, limit: '16mb'})); // Form data
    app.use(express.raw({limit: '16mb', type: 'application/octet-stream'})); // Binary data
    
    // CORS middleware
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
        
        if (req.method === 'OPTIONS') {
            res.sendStatus(200);
            return;
        }
        next();
    });

    const wsManager = new WebSocketManager({
        url: WEBSOCKET_URL,
        reconnectInterval: 5000,
        maxReconnectAttempts: 10,
        pingInterval: 30000,
    });

    wsManager.on('connected', () => {
        console.log('Connected to WebSocket server');
    });

    wsManager.on('disconnected', ({code, reason}) => {
        console.log(`Disconnected from WebSocket server: ${code} - ${reason}`);
    });

    wsManager.on('error', error => {
        console.error('WebSocket error:', error);
    });

    wsManager.on('message', message => {
        console.log('Received message:', message);
    });

    // Compiler compile endpoint
    app.post('/api/compiler/:compilerid/compile', async (req: CompilerRequest, res: Response) => {
        try {
            const {compilerid} = req.params;
            const body = req.body;
            const headers = req.headers;
            // Query parameters available for future use
            // const query = req.query;

            console.log(`Received compile request for compiler: ${compilerid}`);
            console.log('Content-Type:', headers['content-type']);
            console.log('Request body:', typeof body === 'string' ? body : JSON.stringify(body, null, 2));

            // TODO: Implement compilation logic
            // This is where you would:
            // 1. Generate a unique GUID for the request
            // 2. Subscribe to WebSocket for results
            // 3. Route to appropriate queue or URL based on compiler
            // 4. Wait for and return compilation results

            res.json({
                status: 'success',
                message: `Compilation request received for ${compilerid}`,
                compilerid,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error('Error handling compile request:', error);
            res.status(500).json({
                status: 'error',
                message: 'Internal server error',
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    });

    // Compiler cmake endpoint
    app.post('/api/compiler/:compilerid/cmake', async (req: CompilerRequest, res: Response) => {
        try {
            const {compilerid} = req.params;
            const body = req.body;
            const headers = req.headers;
            // Query parameters available for future use
            // const query = req.query;

            console.log(`Received cmake request for compiler: ${compilerid}`);
            console.log('Content-Type:', headers['content-type']);
            console.log('Request body:', typeof body === 'string' ? body : JSON.stringify(body, null, 2));

            // TODO: Implement cmake logic
            // Similar to compile but for cmake requests

            res.json({
                status: 'success',
                message: `CMake request received for ${compilerid}`,
                compilerid,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error('Error handling cmake request:', error);
            res.status(500).json({
                status: 'error',
                message: 'Internal server error',
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    });

    // Health check endpoint
    app.get('/healthcheck', (_req, res) => {
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            websocket: wsManager.isConnected() ? 'connected' : 'disconnected',
        });
    });

    const server = app.listen(PORT, () => {
        console.log(`Express server listening on port ${PORT}`);
    });

    const gracefulShutdown = (signal: string) => {
        console.log(`${signal} received, shutting down gracefully...`);
        server.close(() => {
            console.log('HTTP server closed');
            wsManager.close();
            process.exit(0);
        });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    try {
        await wsManager.connect();
        console.log('CE Router Service started successfully');
    } catch (error) {
        console.error('Failed to start WebSocket connection:', error);
        // Continue without WebSocket - can be handled gracefully
    }
}

main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
