import {createHash} from 'node:crypto';
import express from 'express';
import type {Application, Request, Response} from 'express';
import {logger} from './lib/logger.js';
import {forwardToEnvironmentUrl} from './services/http-forwarder.js';
import {ResultWaiter} from './services/result-waiter.js';
import {RoutingInfo, lookupCompilerRouting, sendToSqs} from './services/routing.js';
import {WebSocketManager, WebSocketManagerOptions} from './services/websocket-manager.js';
import {createErrorResponse, createSuccessResponse, generateGuid} from './utils/index.js';

export interface CompilerExplorerRouterConfig {
    timeoutSeconds?: number;
    websocketUrl?: string;
    websocketOptions?: Partial<WebSocketManagerOptions>;
}

export interface CompilerRequest extends Request {
    params: {
        compilerid: string;
        env?: string;
    };
}

export class CompilerExplorerRouter {
    private app: Application;
    private wsManager: WebSocketManager;
    private resultWaiter: ResultWaiter;
    private timeoutSeconds: number;

    constructor(config: CompilerExplorerRouterConfig = {}, wsManager?: WebSocketManager, resultWaiter?: ResultWaiter) {
        this.timeoutSeconds = config.timeoutSeconds || 60;
        this.app = express();

        // Allow dependency injection for testing
        if (wsManager && resultWaiter) {
            this.wsManager = wsManager;
            this.resultWaiter = resultWaiter;
        } else {
            this.wsManager = new WebSocketManager({
                url: config.websocketUrl || 'wss://events.compiler-explorer.com/beta',
                reconnectInterval: 5000,
                maxReconnectAttempts: 10,
                pingInterval: 30000,
                ...config.websocketOptions,
            });
            this.resultWaiter = new ResultWaiter(this.wsManager);
        }

        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocketHandlers();
    }

    private setupMiddleware(): void {
        // Middleware - handle multiple content types
        this.app.use(express.json({limit: '16mb'}));
        this.app.use(express.text({limit: '16mb', type: 'text/plain'}));
        this.app.use(express.urlencoded({extended: true, limit: '16mb'}));
        this.app.use(express.raw({limit: '16mb', type: 'application/octet-stream'}));

        // CORS middleware
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');

            if (req.method === 'OPTIONS') {
                res.sendStatus(200);
                return;
            }
            next();
        });
    }

    private setupWebSocketHandlers(): void {
        this.wsManager.on('connected', () => {
            logger.info('Connected to WebSocket server');
        });

        this.wsManager.on('disconnected', ({code, reason}) => {
            logger.info(`Disconnected from WebSocket server: ${code} - ${reason}`);
        });

        this.wsManager.on('error', error => {
            logger.error('WebSocket error:', error);
        });

        this.wsManager.on('message', message => {
            logger.debug('Received message:', message);
        });
    }

    private setupRoutes(): void {
        // Health check endpoint
        this.app.get('/healthcheck', (req, res) => this.handleHealthCheck(req, res));

        // Environment-prefixed routes (for beta, staging)
        this.app.post('/:env/api/compiler/:compilerid/compile', (req: CompilerRequest, res: Response) => {
            this.handleCompilationRequest(req, res, false);
        });

        this.app.post('/:env/api/compiler/:compilerid/cmake', (req: CompilerRequest, res: Response) => {
            this.handleCompilationRequest(req, res, true);
        });

        // Production routes (no environment prefix)
        this.app.post('/api/compiler/:compilerid/compile', (req: CompilerRequest, res: Response) => {
            this.handleCompilationRequest(req, res, false);
        });

        this.app.post('/api/compiler/:compilerid/cmake', (req: CompilerRequest, res: Response) => {
            this.handleCompilationRequest(req, res, true);
        });

        // Add error handler for Express
        this.app.use((err: any, req: Request, res: Response, _next: any) => {
            logger.error('Express error handler caught error:', err);
            logger.error('Error stack:', err.stack);
            logger.error('Request URL:', req.url);
            logger.error('Request method:', req.method);

            if (!res.headersSent) {
                logger.error('Sending 502 response due to Express error');
                res.status(502).json({error: 'Internal server error'});
            } else {
                logger.error('Headers already sent, cannot send error response');
            }
        });
    }

    private handleHealthCheck(_req: Request, res: Response): void {
        logger.info('Received healthcheck request');
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            websocket: this.wsManager.isConnected() ? 'connected' : 'disconnected',
        });
    }

    private async handleCompilationRequest(req: CompilerRequest, res: Response, isCmake: boolean): Promise<void> {
        try {
            // Generate unique GUID for this request immediately
            const guid = generateGuid();
            const {compilerid} = req.params;
            const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
            const headers = req.headers;
            const queryStringParameters = req.query as Record<string, string>;

            const endpoint = isCmake ? 'cmake' : 'compile';
            logger.info(`Received ${endpoint} request for compiler: ${compilerid}`);
            logger.debug('Content-Type:', headers['content-type']);
            logger.info(`Request GUID: ${guid}`);

            // Start WebSocket subscription as early as possible
            try {
                await this.resultWaiter.subscribe(guid);
                // Add small delay to ensure subscription is processed
                await new Promise(resolve => setTimeout(resolve, 50));
            } catch (error) {
                logger.error('Failed to subscribe to WebSocket:', error);
                const errorResponse = createErrorResponse(
                    500,
                    `Failed to setup result subscription: ${(error as Error).message}`,
                );
                res.status(errorResponse.statusCode).set(errorResponse.headers).send(errorResponse.body);
                return;
            }

            // Determine routing strategy for this compiler
            const routingInfo = await this.getRoutingInfo(compilerid);

            if (routingInfo.type === 'url') {
                await this.handleUrlRouting(res, guid, compilerid, body, isCmake, headers, routingInfo);
            } else {
                await this.handleQueueRouting(
                    res,
                    guid,
                    compilerid,
                    body,
                    isCmake,
                    headers,
                    queryStringParameters,
                    routingInfo,
                );
            }
        } catch (error) {
            logger.error('Unexpected error in compilation handler:', error);
            const errorResponse = createErrorResponse(500, `Internal server error: ${(error as Error).message}`);
            res.status(errorResponse.statusCode).set(errorResponse.headers).send(errorResponse.body);
        }
    }

    protected async getRoutingInfo(compilerid: string): Promise<RoutingInfo> {
        return lookupCompilerRouting(compilerid);
    }

    protected async sendToQueue(
        guid: string,
        compilerid: string,
        body: string,
        isCmake: boolean,
        headers: Record<string, string | string[]>,
        queryStringParameters: Record<string, string>,
        queueUrl: string,
    ): Promise<void> {
        return sendToSqs(guid, compilerid, body, isCmake, headers, queryStringParameters, queueUrl);
    }

    private async handleUrlRouting(
        res: Response,
        guid: string,
        compilerid: string,
        body: string,
        isCmake: boolean,
        headers: any,
        routingInfo: RoutingInfo,
    ): Promise<void> {
        // Direct URL forwarding - unsubscribe from WebSocket
        await this.resultWaiter.unsubscribe(guid);

        try {
            logger.info(`Starting URL forwarding for ${compilerid} to ${routingInfo.target}`);
            const response = await forwardToEnvironmentUrl(
                compilerid,
                routingInfo.target,
                body,
                isCmake,
                headers as Record<string, string | string[]>,
            );

            logger.info(
                `Got response from forwardToEnvironmentUrl: status=${response.statusCode}, body length=${response.body.length}`,
            );

            // Ensure CORS headers are present
            const responseHeaders: Record<string, string> = {
                ...response.headers,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
            };

            // Check if response was already sent
            if (res.headersSent) {
                logger.error(`Headers already sent for ${compilerid}, cannot send response`);
                return;
            }

            logger.info(
                `Sending response to client with status ${response.statusCode}, body length ${response.body.length}`,
            );

            // Set content-length header explicitly to help proxies
            const bodyBuffer = Buffer.from(response.body);
            const bodyHash = createHash('md5').update(bodyBuffer).digest('hex');
            responseHeaders['content-length'] = bodyBuffer.length.toString();
            logger.info(`Response body is ${bodyBuffer.length} bytes, MD5: ${bodyHash}, setting content-length header`);

            // Check if response is too large for some proxies (ALB limit is 1MB)
            if (bodyBuffer.length > 1000000) {
                logger.warn(`Response body size ${bodyBuffer.length} bytes exceeds 1MB - may cause ALB issues`);
            }

            // Log response body type and sample
            if (typeof response.body === 'string') {
                const preview = response.body.length > 100 ? response.body.substring(0, 100) + '...' : response.body;
                logger.info(`Response body (string): ${preview}`);
            } else {
                const bodyType = typeof response.body;
                const constructorName = response.body && typeof response.body === 'object' ? (response.body as any).constructor?.name : 'unknown';
                logger.info(`Response body type: ${bodyType}, constructor: ${constructorName}`);
            }

            // Send the response
            try {
                logger.info(`About to send response with status ${response.statusCode}`);
                res.status(response.statusCode);
                logger.info('Status set successfully');
                res.set(responseHeaders);
                logger.info('Headers set successfully');
                const endStartTime = Date.now();
                res.end(bodyBuffer, () => {
                    const endDuration = Date.now() - endStartTime;
                    logger.info(`Response sent successfully for ${compilerid} - res.end took ${endDuration}ms`);
                });

                // Handle any response errors
                res.on('error', err => {
                    logger.error('Error sending response:', err);
                });

                // Handle response finish event
                res.on('finish', () => {
                    logger.info(`Response finished for ${compilerid}`);
                });

                // Handle response close event
                res.on('close', () => {
                    logger.info(`Response connection closed for ${compilerid}`);
                });
                logger.info(`Called res.end for ${compilerid} with status ${response.statusCode}`);
            } catch (sendError) {
                logger.error(`Error sending response to client: ${(sendError as Error).message}`);
                logger.error('Send error stack:', (sendError as Error).stack);
                throw sendError; // Re-throw to be caught by outer catch
            }
        } catch (error) {
            logger.error('URL forwarding error:', error);
            logger.error('Error stack:', (error as Error).stack);
            logger.error('Error occurred after receiving response, might be a send issue');

            // Check if response was already sent
            if (res.headersSent) {
                logger.error('Headers already sent, cannot send error response');
                return;
            }

            const errorResponse = createErrorResponse(502, `Failed to forward request: ${(error as Error).message}`);
            logger.info(`Sending error response with status ${errorResponse.statusCode}`);
            res.status(errorResponse.statusCode).set(errorResponse.headers).send(errorResponse.body);
        }
    }

    private async handleQueueRouting(
        res: Response,
        guid: string,
        compilerid: string,
        body: string,
        isCmake: boolean,
        headers: any,
        queryStringParameters: Record<string, string>,
        routingInfo: RoutingInfo,
    ): Promise<void> {
        // Queue-based routing
        const queueUrl = routingInfo.target;
        let resultPromise: Promise<any> | null = null;

        try {
            // Send request to SQS queue
            await this.sendToQueue(
                guid,
                compilerid,
                body,
                isCmake,
                headers as Record<string, string | string[]>,
                queryStringParameters,
                queueUrl,
            );

            // Start waiting for result
            resultPromise = this.resultWaiter.waitForResult(guid, this.timeoutSeconds);

            // Wait for compilation result
            const result = await resultPromise;

            // Get Accept header for response formatting
            const filterAnsi = queryStringParameters.filterAnsi === 'true';
            const acceptHeader = (headers.accept || headers.Accept || '') as string;
            const successResponse = createSuccessResponse(result, filterAnsi, acceptHeader);
            res.status(successResponse.statusCode).set(successResponse.headers).send(successResponse.body);
        } catch (error) {
            // Handle both SQS errors and compilation result errors
            if (!resultPromise) {
                logger.error('SQS error:', error);
                const errorResponse = createErrorResponse(
                    500,
                    `Failed to queue compilation request: ${(error as Error).message}`,
                );
                res.status(errorResponse.statusCode).set(errorResponse.headers).send(errorResponse.body);
            } else if ((error as Error).message.includes('No response received')) {
                logger.error('Timeout waiting for compilation result:', error);
                const errorResponse = createErrorResponse(408, `Compilation timeout: ${(error as Error).message}`);
                res.status(errorResponse.statusCode).set(errorResponse.headers).send(errorResponse.body);
            } else {
                logger.error('Unexpected error during compilation:', error);
                const errorResponse = createErrorResponse(
                    500,
                    `Failed to complete compilation: ${(error as Error).message}`,
                );
                res.status(errorResponse.statusCode).set(errorResponse.headers).send(errorResponse.body);
            }
        }
    }

    public async start(): Promise<WebSocketManager> {
        await this.wsManager.connect();
        logger.info('WebSocket connection established');
        return this.wsManager;
    }

    public stop(): void {
        this.wsManager.close();
    }

    public getApp(): Application {
        return this.app;
    }

    public getWebSocketManager(): WebSocketManager {
        return this.wsManager;
    }

    public getResultWaiter(): ResultWaiter {
        return this.resultWaiter;
    }
}
