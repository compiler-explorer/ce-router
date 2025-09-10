import {GetObjectCommand} from '@aws-sdk/client-s3';
import {logger} from '../lib/logger.js';
import {CompilationResult} from '../utils/index.js';
import {s3Client} from './aws-clients.js';
import {WebSocketManager} from './websocket-manager.js';

export class ResultWaiter {
    private subscriptions = new Map<
        string,
        {
            resolve: (result: CompilationResult) => void;
            reject: (error: Error) => void;
            timeout: NodeJS.Timeout;
        }
    >();

    constructor(private wsManager: WebSocketManager) {
        // Listen for messages from WebSocket
        this.wsManager.on('message', message => {
            this.handleMessage(message);
        });
    }

    private async handleMessage(message: any) {
        try {
            // Check if this is a compilation result message with a GUID
            if (message && typeof message === 'object' && message.guid) {
                const guid = message.guid;
                const subscription = this.subscriptions.get(guid);

                if (subscription) {
                    logger.info(`Received result for GUID: ${guid}`);
                    clearTimeout(subscription.timeout);

                    // Send acknowledgment immediately upon receiving the result
                    try {
                        if (this.wsManager.isConnected()) {
                            await this.wsManager.sendAck(guid);
                            logger.debug(`Sent acknowledgment for GUID: ${guid}`);
                        }
                    } catch (ackError) {
                        logger.warn(`Failed to send acknowledgment for GUID ${guid}:`, ackError);
                    }

                    // Mark subscription as received to remove from pending list
                    this.wsManager.markSubscriptionReceived(guid);

                    try {
                        const resolvedMessage = await this.resolveS3FileIfNeeded(message);
                        subscription.resolve(resolvedMessage as CompilationResult);
                    } catch (error) {
                        logger.error(`Failed to resolve S3 files for GUID: ${guid}:`, error);
                        subscription.resolve(message as CompilationResult);
                    }

                    this.subscriptions.delete(guid);

                    // Send unsubscribe command to free server resources
                    try {
                        if (this.wsManager.isConnected()) {
                            logger.info(`WebSocket unsubscribe sending for GUID: ${guid}`);
                            await this.wsManager.unsubscribe(guid);
                        }
                    } catch (unsubError) {
                        logger.warn(`Failed to send unsubscribe for GUID ${guid}:`, unsubError);
                    }
                }
            }
        } catch (error) {
            logger.error('Error handling WebSocket message:', error);
        }
    }

    private async fetchResultFromS3(s3Key: string): Promise<any> {
        const bucketName = process.env.COMPILATION_RESULTS_BUCKET || 'storage.godbolt.org';
        const prefix = process.env.COMPILATION_RESULTS_PREFIX || 'cache/';
        const fullKey = `${prefix}${s3Key}`;

        logger.info(`Fetching large compilation result from S3: ${bucketName}/${fullKey}`);

        const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: fullKey,
        });

        const response = await s3Client.send(command);

        if (!response.Body) {
            throw new Error('No data returned from S3');
        }

        const bodyContent = await response.Body.transformToString();
        const s3Content = JSON.parse(bodyContent);
        logger.info(`Successfully fetched and parsed S3 compilation result for ${s3Key}`);
        return s3Content;
    }

    async subscribe(guid: string): Promise<void> {
        try {
            await this.wsManager.subscribe(guid);
            logger.debug(`Subscribed to WebSocket for GUID: ${guid}`);
        } catch (error) {
            logger.error(`Failed to subscribe to WebSocket for GUID ${guid}:`, error);
            throw error;
        }
    }

    async waitForResult(guid: string, timeoutSeconds: number): Promise<CompilationResult> {
        return new Promise<CompilationResult>((resolve, reject) => {
            // Set up timeout
            const timeout = setTimeout(async () => {
                this.subscriptions.delete(guid);
                // Send unsubscribe on timeout
                try {
                    if (this.wsManager.isConnected()) {
                        await this.wsManager.unsubscribe(guid);
                    }
                } catch (error) {
                    logger.warn(`Failed to unsubscribe on timeout for GUID ${guid}:`, error);
                }
                reject(new Error(`No response received within ${timeoutSeconds} seconds for GUID: ${guid}`));
            }, timeoutSeconds * 1000);

            // Store the subscription
            this.subscriptions.set(guid, {
                resolve,
                reject,
                timeout,
            });

            logger.debug(`Waiting for compilation result for GUID: ${guid}`);
        });
    }

    async unsubscribe(guid: string): Promise<void> {
        try {
            await this.wsManager.unsubscribe(guid);
            logger.debug(`Unsubscribed from WebSocket for GUID: ${guid}`);
        } catch (error) {
            logger.error(`Failed to unsubscribe from WebSocket for GUID ${guid}:`, error);
        }
    }

    /**
     * Check if a compilation result needs S3 resolution and fetch complete data if so
     * Detects lightweight messages with s3Key field that are missing typical result data
     */
    private async resolveS3FileIfNeeded(message: any): Promise<any> {
        // Only process objects that could be compilation results
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            return message;
        }

        // Check if this message has an s3Key field
        if (!message.s3Key) {
            return message;
        }

        // Check if this is a lightweight message missing typical result data
        const hasTypicalResultData =
            message.asm ||
            message.stdout ||
            message.stderr ||
            message.code !== undefined ||
            message.output ||
            message.result;

        if (hasTypicalResultData) {
            // Message already has result data, no need to fetch from S3
            logger.info('Message has s3Key but already contains result data, skipping S3 fetch');
            return message;
        }

        // This appears to be a lightweight message - fetch complete result from S3
        try {
            const s3Content = await this.fetchResultFromS3(message.s3Key);

            return {
                ...s3Content,
                ...message,
            };
        } catch (error) {
            logger.error(`Failed to fetch S3 compilation result for ${message.s3Key}:`, error);

            // Return a user-friendly error message in the compilation result format
            return {
                code: -1,
                okToCache: false,
                stdout: [],
                stderr: [{text: 'An internal error has occurred while retrieving the compilation result'}],
                execTime: 0,
                timedOut: false,
                guid: message.guid,
            };
        }
    }
}
