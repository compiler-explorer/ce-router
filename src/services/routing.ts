import {GetItemCommand} from '@aws-sdk/client-dynamodb';
import {PutObjectCommand} from '@aws-sdk/client-s3';
import {SendMessageCommand} from '@aws-sdk/client-sqs';
import {GetParameterCommand} from '@aws-sdk/client-ssm';
import {logger} from '../lib/logger.js';
import {CMAKE_BUILD_SYSTEM, parseRequestBody} from '../utils/index.js';
import {dynamoDBClient, s3Client, sqsClient, ssmClient} from './aws-clients.js';

// Cache for active color (with TTL)
let activeColorCache = {
    color: null as string | null,
    timestamp: 0,
    TTL: 30000, // 30 seconds TTL
};

// In-memory cache of routing decisions. Deliberately holds only what the routing table
// says -- never a value derived from the active colour, which changes on every deploy.
// The colour is applied in resolveRouting() on each request, from activeColorCache, so a
// missed /admin/clear-cache costs at most that cache's TTL instead of lasting forever.
const routingCache = new Map<string, RoutingDecision>();

interface RoutingDecision {
    type: 'url' | 'queue';
    environment: string;
    targetUrl?: string;
    // Absent for queue routing means the environment's own coloured queue.
    queueName?: string;
}

export interface RoutingInfo {
    type: 'url' | 'queue';
    target: string;
    environment: string;
}

function getEnvironmentName(): string {
    return process.env.ENVIRONMENT_NAME || 'unknown';
}

function getBlueQueueUrl(): string {
    const env = getEnvironmentName();
    const defaultUrl = `https://sqs.us-east-1.amazonaws.com/052730242331/${env}-compilation-queue-blue.fifo`;
    return process.env[`SQS_QUEUE_URL_BLUE_${env.toUpperCase()}`] || process.env.SQS_QUEUE_URL_BLUE || defaultUrl;
}

function getGreenQueueUrl(): string {
    const env = getEnvironmentName();
    const defaultUrl = `https://sqs.us-east-1.amazonaws.com/052730242331/${env}-compilation-queue-green.fifo`;
    return process.env[`SQS_QUEUE_URL_GREEN_${env.toUpperCase()}`] || process.env.SQS_QUEUE_URL_GREEN || defaultUrl;
}

function getOverflowConfig() {
    return {
        maxMessageSize: Number.parseInt(process.env.SQS_MAX_MESSAGE_SIZE || '262144', 10), // 256 KiB default
        bucket: process.env.S3_OVERFLOW_BUCKET || 'temp-storage.godbolt.org',
        keyPrefix: process.env.S3_OVERFLOW_KEY_PREFIX || 'sqs-overflow/',
    };
}

async function getActiveColor(): Promise<string> {
    const now = Date.now();

    // Check cache
    if (activeColorCache.color && now - activeColorCache.timestamp < activeColorCache.TTL) {
        logger.debug(`Active color cache hit: ${activeColorCache.color}`);
        return activeColorCache.color;
    }

    const environmentName = getEnvironmentName();
    const paramName = `/compiler-explorer/${environmentName}/active-color`;

    try {
        logger.info(`Fetching active color from SSM: ${paramName}`);
        const response = await ssmClient.send(
            new GetParameterCommand({
                Name: paramName,
            }),
        );

        const color = (response as any).Parameter?.Value || 'blue';

        // Update cache
        activeColorCache = {
            color: color,
            timestamp: now,
            TTL: activeColorCache.TTL,
        };

        logger.info(`Active color from SSM: ${color}`);
        return color;
    } catch (error) {
        logger.warn('Failed to get active color from SSM, defaulting to blue:', error);
        return 'blue';
    }
}

async function getColoredQueueUrl(): Promise<string> {
    const activeColor = await getActiveColor();
    const queueUrl = activeColor === 'green' ? getGreenQueueUrl() : getBlueQueueUrl();

    if (!queueUrl) {
        throw new Error(`Queue URL for active color '${activeColor}' not configured in environment variables`);
    }

    logger.info(`Using ${activeColor} queue: ${queueUrl}`);
    return queueUrl;
}

function buildQueueUrl(queueName: string, activeColor: string): string {
    // Get the active color's queue URL as template
    const templateUrl = activeColor === 'green' ? getGreenQueueUrl() : getBlueQueueUrl();
    if (!templateUrl) {
        throw new Error(`Queue URL for active color '${activeColor}' not configured in environment variables`);
    }

    // Extract the base URL (everything before the last slash)
    const lastSlashIndex = templateUrl.lastIndexOf('/');
    if (lastSlashIndex === -1) {
        throw new Error('Invalid queue URL format');
    }

    const baseUrl = templateUrl.substring(0, lastSlashIndex + 1);

    // If queueName doesn't have a color suffix, add the active color
    let finalQueueName = queueName;
    if (!queueName.includes('-blue') && !queueName.includes('-green')) {
        finalQueueName = queueName.replace('.fifo', '') + `-${activeColor}`;
    }

    // Ensure queue name has .fifo suffix
    const fifoQueueName = finalQueueName.endsWith('.fifo') ? finalQueueName : finalQueueName + '.fifo';

    return baseUrl + fifoQueueName;
}

async function resolveRouting(decision: RoutingDecision): Promise<RoutingInfo> {
    if (decision.type === 'url') {
        return {type: 'url', target: decision.targetUrl || '', environment: decision.environment};
    }

    const queueUrl = decision.queueName
        ? buildQueueUrl(decision.queueName, await getActiveColor())
        : await getColoredQueueUrl();
    return {type: 'queue', target: queueUrl, environment: decision.environment};
}

function getCompilerRoutingTableName(): string {
    return process.env.COMPILER_ROUTING_TABLE || 'CompilerRouting';
}

function decisionFromItem(compilerId: string, item: Record<string, any> | undefined): RoutingDecision {
    const environment = item ? item.environment?.S || '' : 'unknown';
    const targetUrl = item?.routingType?.S === 'url' ? item.targetUrl?.S : undefined;

    if (targetUrl) {
        logger.info(`Compiler ${compilerId} routed to URL: ${targetUrl}`);
        return {type: 'url', targetUrl, environment};
    }

    const queueName = item?.routingType?.S === 'url' ? undefined : item?.queueName?.S;
    if (queueName) {
        logger.info(`Compiler ${compilerId} routed to queue: ${queueName}`);
        return {type: 'queue', queueName, environment};
    }

    if (item) {
        logger.info(`Compiler ${compilerId} routed to colored queue (no queueName in DynamoDB)`);
    } else {
        logger.info(`No routing found for compiler ${compilerId}, using colored queue`);
    }
    return {type: 'queue', environment};
}

export async function lookupCompilerRouting(compilerId: string): Promise<RoutingInfo> {
    try {
        // Create composite key with environment prefix for isolation
        const environmentName = getEnvironmentName();
        const compositeKey = `${environmentName}#${compilerId}`;

        // Check cache first
        const cacheKey = compositeKey;
        const cachedDecision = routingCache.get(cacheKey);
        if (cachedDecision) {
            logger.debug(`Routing cache hit for compiler: ${compilerId}`);
            return resolveRouting(cachedDecision);
        }

        // Look up compiler in DynamoDB routing table using composite key
        logger.debug(`DynamoDB routing lookup start for compiler: ${compilerId}`);
        const response = await dynamoDBClient.send(
            new GetItemCommand({
                TableName: getCompilerRoutingTableName(),
                Key: {
                    compilerId: {S: compositeKey},
                },
            }),
        );

        let item = response.Item;

        if (item) {
            logger.debug(`DynamoDB routing lookup end for compiler: ${compilerId}, using composite key`);
        } else {
            // Fallback: try old format (without environment prefix) for backward compatibility
            logger.debug(`Composite key not found for ${compositeKey}, trying legacy format`);
            const fallbackResponse = await dynamoDBClient.send(
                new GetItemCommand({
                    TableName: getCompilerRoutingTableName(),
                    Key: {
                        compilerId: {S: compilerId},
                    },
                }),
            );

            item = fallbackResponse.Item;
            if (item) {
                logger.warn(`Using legacy routing entry for ${compilerId} - consider migration`);
                logger.debug(`DynamoDB routing lookup end for compiler: ${compilerId}, using fallback: found`);
            } else {
                logger.debug(`DynamoDB routing lookup end for compiler: ${compilerId}, using fallback: not found`);
            }
        }

        const decision = decisionFromItem(compilerId, item);
        routingCache.set(cacheKey, decision);
        logger.debug(`Routing lookup complete for compiler: ${compilerId}`);
        return resolveRouting(decision);
    } catch (error) {
        // On any error, fall back to colored queue
        logger.warn(`Failed to lookup routing for compiler ${compilerId}:`, error);
        const queueUrl = await getColoredQueueUrl();
        return {
            type: 'queue',
            target: queueUrl,
            environment: 'unknown',
        };
    }
}

/**
 * Clears all routing and color caches.
 * Called via /admin/clear-cache at the end of a blue-green deployment, so the router
 * picks up the new active color and any routing-table changes immediately rather than
 * waiting for the active color cache's 30-second TTL. Only the routing-table half needs
 * this: routing decisions are cached without an expiry, since nothing else invalidates
 * them, while the color they are resolved with expires on its own.
 */
export function clearRoutingCaches(): void {
    // Clear active color cache
    activeColorCache = {
        color: null,
        timestamp: 0,
        TTL: activeColorCache.TTL,
    };

    // Clear routing cache
    routingCache.clear();

    logger.info('Routing caches cleared: active color cache and compiler routing cache');
}

export async function sendToSqs(
    guid: string,
    compilerId: string,
    body: string,
    buildSystem: string | undefined,
    headers: Record<string, string | string[]>,
    queryStringParameters: Record<string, string>,
    queueUrl: string,
): Promise<void> {
    if (!queueUrl) {
        throw new Error('No queue URL available');
    }

    // Parse body based on content type
    const contentType = (headers['content-type'] || headers['Content-Type'] || '') as string;
    const requestData = parseRequestBody(body, contentType);

    if (typeof requestData !== 'object') {
        logger.warn(`Request data is not an object: ${JSON.stringify(requestData).substring(0, 100)}...`);
    }

    // Start with Lambda-specific fields and merge with request data
    const messageBody: any = {
        guid,
        compilerId,
        headers,
        queryStringParameters,
        ...requestData, // Merge all fields from the original request first
    };

    // Set after the merge: the route the request came in on decides what to build, not the body. `isCMake` is the
    // original spelling of `buildSystem` and is still sent so that workers predating the generic field keep working.
    if (buildSystem) {
        messageBody.buildSystem = buildSystem;
        messageBody.isCMake = buildSystem === CMAKE_BUILD_SYSTEM;
    } else {
        messageBody.isCMake = false;
        delete messageBody.buildSystem;
    }

    // Add defaults for fields that are required by the consumer but might be missing
    messageBody.source = messageBody.source || '';
    messageBody.options = messageBody.options || [];
    messageBody.filters = messageBody.filters || {};
    messageBody.backendOptions = messageBody.backendOptions || {};
    messageBody.tools = messageBody.tools || [];
    messageBody.libraries = messageBody.libraries || [];
    messageBody.files = messageBody.files || [];
    messageBody.executeParameters = messageBody.executeParameters || {};

    try {
        const messageJson = JSON.stringify(messageBody);
        const messageSize = Buffer.byteLength(messageJson, 'utf8');

        let finalMessageBody: string;

        const overflowConfig = getOverflowConfig();

        // Check if message exceeds the configured size limit
        if (messageSize > overflowConfig.maxMessageSize) {
            logger.info(
                `Message size (${messageSize} bytes) exceeds limit (${overflowConfig.maxMessageSize} bytes), storing in S3`,
            );

            // Generate S3 key
            const environmentName = getEnvironmentName();
            const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
            const s3Key = `${overflowConfig.keyPrefix}${environmentName}/${date}/${guid}.json`;

            // Upload to S3
            await s3Client.send(
                new PutObjectCommand({
                    Bucket: overflowConfig.bucket,
                    Key: s3Key,
                    Body: messageJson,
                    ContentType: 'application/json',
                    Metadata: {
                        guid: guid,
                        compilerId: compilerId,
                        environment: environmentName,
                        originalSize: messageSize.toString(),
                    },
                }),
            );

            logger.info(`Message stored in S3: s3://${overflowConfig.bucket}/${s3Key}`);

            // Create a reference message for SQS
            finalMessageBody = JSON.stringify({
                type: 's3-overflow',
                guid,
                compilerId,
                s3Bucket: overflowConfig.bucket,
                s3Key,
                originalSize: messageSize,
                timestamp: new Date().toISOString(),
            });
        } else {
            finalMessageBody = messageJson;
        }

        logger.debug(`SQS send start for GUID: ${guid} to queue`);
        await sqsClient.send(
            new SendMessageCommand({
                QueueUrl: queueUrl,
                MessageBody: finalMessageBody,
                MessageGroupId: 'default',
                MessageDeduplicationId: guid,
            }),
        );
        logger.debug(`SQS send end for GUID: ${guid}`);
    } catch (error) {
        logger.error(`Failed to send message to SQS (${queueUrl}):`, error);
        throw new Error(`Failed to send message to SQS (${queueUrl}): ${(error as Error).message}`);
    }
}
