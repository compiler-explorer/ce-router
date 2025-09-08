import {Command} from 'commander';
import express from 'express';
import type {Request, Response} from 'express';
import {forwardToEnvironmentUrl} from './services/http-forwarder.js';
import {ResultWaiter} from './services/result-waiter.js';
import {lookupCompilerRouting, sendToSqs} from './services/routing.js';
import {WebSocketManager} from './services/websocket-manager.js';
import {createErrorResponse, createSuccessResponse, generateGuid} from './utils/index.js';

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

    const resultWaiter = new ResultWaiter(wsManager);

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

    // Helper function to handle both compile and cmake requests
    const handleCompilationRequest = async (req: CompilerRequest, res: Response, isCmake: boolean) => {
        try {
            // Generate unique GUID for this request immediately
            const guid = generateGuid();
            const {compilerid} = req.params;
            const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
            const headers = req.headers;
            const queryStringParameters = req.query as Record<string, string>;

            const endpoint = isCmake ? 'cmake' : 'compile';
            console.log(`Received ${endpoint} request for compiler: ${compilerid}`);
            console.log('Content-Type:', headers['content-type']);
            console.log(`Request GUID: ${guid}`);

            // Start WebSocket subscription as early as possible
            try {
                await resultWaiter.subscribe(guid);
                // Add small delay to ensure subscription is processed
                await new Promise(resolve => setTimeout(resolve, 50));
            } catch (error) {
                console.error('Failed to subscribe to WebSocket:', error);
                const errorResponse = createErrorResponse(
                    500,
                    `Failed to setup result subscription: ${(error as Error).message}`,
                );
                return res.status(errorResponse.statusCode).set(errorResponse.headers).send(errorResponse.body);
            }

            // Determine routing strategy for this compiler
            const routingInfo = await lookupCompilerRouting(compilerid);

            if (routingInfo.type === 'url') {
                // Direct URL forwarding - unsubscribe from WebSocket
                await resultWaiter.unsubscribe(guid);

                try {
                    const response = await forwardToEnvironmentUrl(
                        compilerid,
                        routingInfo.target,
                        body,
                        isCmake,
                        headers as Record<string, string | string[]>,
                    );

                    // Ensure CORS headers are present
                    const responseHeaders = {
                        ...response.headers,
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
                    };

                    return res.status(response.statusCode).set(responseHeaders).send(response.body);
                } catch (error) {
                    console.error('URL forwarding error:', error);
                    const errorResponse = createErrorResponse(
                        500,
                        `Failed to forward request: ${(error as Error).message}`,
                    );
                    return res.status(errorResponse.statusCode).set(errorResponse.headers).send(errorResponse.body);
                }
            }

            // Queue-based routing
            const queueUrl = routingInfo.target;
            let resultPromise: Promise<any> | null = null;

            try {
                // Send request to SQS queue
                await sendToSqs(
                    guid,
                    compilerid,
                    body,
                    isCmake,
                    headers as Record<string, string | string[]>,
                    queryStringParameters,
                    queueUrl,
                );

                // Start waiting for result
                resultPromise = resultWaiter.waitForResult(guid, TIMEOUT_SECONDS);

                // Wait for compilation result
                const result = await resultPromise;

                // Get Accept header for response formatting
                const filterAnsi = queryStringParameters.filterAnsi === 'true';
                const acceptHeader = (headers.accept || headers.Accept || '') as string;
                const successResponse = createSuccessResponse(result, filterAnsi, acceptHeader);
                return res.status(successResponse.statusCode).set(successResponse.headers).send(successResponse.body);
            } catch (error) {
                // Handle both SQS errors and compilation result errors
                if (!resultPromise) {
                    console.error('SQS error:', error);
                    const errorResponse = createErrorResponse(
                        500,
                        `Failed to queue compilation request: ${(error as Error).message}`,
                    );
                    return res.status(errorResponse.statusCode).set(errorResponse.headers).send(errorResponse.body);
                } else if ((error as Error).message.includes('No response received')) {
                    console.error('Timeout waiting for compilation result:', error);
                    const errorResponse = createErrorResponse(408, `Compilation timeout: ${(error as Error).message}`);
                    return res.status(errorResponse.statusCode).set(errorResponse.headers).send(errorResponse.body);
                } else {
                    console.error('Unexpected error during compilation:', error);
                    const errorResponse = createErrorResponse(
                        500,
                        `Failed to complete compilation: ${(error as Error).message}`,
                    );
                    return res.status(errorResponse.statusCode).set(errorResponse.headers).send(errorResponse.body);
                }
            }
        } catch (error) {
            console.error('Unexpected error in compilation handler:', error);
            const errorResponse = createErrorResponse(500, `Internal server error: ${(error as Error).message}`);
            return res.status(errorResponse.statusCode).set(errorResponse.headers).send(errorResponse.body);
        }
    };

    // Compiler compile endpoint
    app.post('/api/compiler/:compilerid/compile', async (req: CompilerRequest, res: Response) => {
        await handleCompilationRequest(req, res, false);
    });

    // Compiler cmake endpoint
    app.post('/api/compiler/:compilerid/cmake', async (req: CompilerRequest, res: Response) => {
        await handleCompilationRequest(req, res, true);
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
