import {logger} from '../lib/logger.js';
import {CompilationResult} from '../utils/index.js';
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

    private handleMessage(message: any) {
        try {
            // Check if this is a compilation result message with a GUID
            if (message && typeof message === 'object' && message.guid) {
                const guid = message.guid;
                const subscription = this.subscriptions.get(guid);

                if (subscription) {
                    logger.info(`Received compilation result for GUID: ${guid}`);
                    clearTimeout(subscription.timeout);
                    this.subscriptions.delete(guid);
                    subscription.resolve(message as CompilationResult);
                }
            }
        } catch (error) {
            logger.error('Error handling WebSocket message:', error);
        }
    }

    async subscribe(guid: string): Promise<void> {
        try {
            await this.wsManager.subscribe(`guid:${guid}`);
            logger.debug(`Subscribed to WebSocket for GUID: ${guid}`);
        } catch (error) {
            logger.error(`Failed to subscribe to WebSocket for GUID ${guid}:`, error);
            throw error;
        }
    }

    async waitForResult(guid: string, timeoutSeconds: number): Promise<CompilationResult> {
        return new Promise<CompilationResult>((resolve, reject) => {
            // Set up timeout
            const timeout = setTimeout(() => {
                this.subscriptions.delete(guid);
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
            await this.wsManager.unsubscribe(`guid:${guid}`);
            logger.debug(`Unsubscribed from WebSocket for GUID: ${guid}`);
        } catch (error) {
            logger.error(`Failed to unsubscribe from WebSocket for GUID ${guid}:`, error);
        }
    }
}
