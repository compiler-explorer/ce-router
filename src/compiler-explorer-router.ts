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

        // Compiler compile endpoint
        this.app.post('/api/compiler/:compilerid/compile', (req: CompilerRequest, res: Response) => {
            this.handleCompilationRequest(req, res, false);
        });

        // Compiler cmake endpoint
        this.app.post('/api/compiler/:compilerid/cmake', (req: CompilerRequest, res: Response) => {
            this.handleCompilationRequest(req, res, true);
        });
    }

    private handleHealthCheck(_req: Request, res: Response): void {
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

            res.status(response.statusCode).set(responseHeaders).send(response.body);
        } catch (error) {
            logger.error('URL forwarding error:', error);
            const errorResponse = createErrorResponse(500, `Failed to forward request: ${(error as Error).message}`);
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
