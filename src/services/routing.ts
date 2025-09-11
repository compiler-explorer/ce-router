import {GetItemCommand} from '@aws-sdk/client-dynamodb';
import {PutObjectCommand} from '@aws-sdk/client-s3';
import {SendMessageCommand} from '@aws-sdk/client-sqs';
import {GetParameterCommand} from '@aws-sdk/client-ssm';
import {logger} from '../lib/logger.js';
import {parseRequestBody} from '../utils/index.js';
import {dynamoDBClient, s3Client, sqsClient, ssmClient} from './aws-clients.js';

// Cache for active color (with TTL)
let activeColorCache = {
    color: null as string | null,
    timestamp: 0,
    TTL: 30000, // 30 seconds TTL
};

// In-memory cache for routing lookups
const routingCache = new Map<string, RoutingInfo>();

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

function getCompilerRoutingTableName(): string {
    return process.env.COMPILER_ROUTING_TABLE || 'CompilerRouting';
}

export async function lookupCompilerRouting(compilerId: string): Promise<RoutingInfo> {
    try {
        // Create composite key with environment prefix for isolation
        const environmentName = getEnvironmentName();
        const compositeKey = `${environmentName}#${compilerId}`;

        // Check cache first
        const cacheKey = compositeKey;
        const cachedEntry = routingCache.get(cacheKey);
        if (cachedEntry) {
            logger.debug(`Routing cache hit for compiler: ${compilerId}`);
            return cachedEntry;
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

        if (item) {
            const routingType = item.routingType?.S || 'queue';

            if (routingType === 'url') {
                const targetUrl = item.targetUrl?.S || '';
                if (targetUrl) {
                    const result: RoutingInfo = {
                        type: 'url',
                        target: targetUrl,
                        environment: item.environment?.S || '',
                    };
                    // Cache the result
                    routingCache.set(cacheKey, result);
                    logger.info(`Compiler ${compilerId} routed to URL: ${targetUrl}`);
                    logger.debug(`Routing lookup complete for compiler: ${compilerId}`);
                    return result;
                }
            } else {
                // Queue routing - use queueName from DynamoDB to build full queue URL
                const queueName = item.queueName?.S;
                if (queueName) {
                    const activeColor = await getActiveColor();
                    const queueUrl = buildQueueUrl(queueName, activeColor);
                    const result: RoutingInfo = {
                        type: 'queue',
                        target: queueUrl,
                        environment: item.environment?.S || '',
                    };
                    // Cache the result
                    routingCache.set(cacheKey, result);
                    logger.info(`Compiler ${compilerId} routed to queue: ${queueName} (${queueUrl})`);
                    logger.debug(`Routing lookup complete for compiler: ${compilerId}`);
                    return result;
                }
                // Fallback to colored queue if no queueName specified
                const queueUrl = await getColoredQueueUrl();
                const result: RoutingInfo = {
                    type: 'queue',
                    target: queueUrl,
                    environment: item.environment?.S || '',
                };
                // Cache the result
                routingCache.set(cacheKey, result);
                logger.info(`Compiler ${compilerId} routed to colored queue (no queueName in DynamoDB)`);
                logger.debug(`Routing lookup complete for compiler: ${compilerId}`);
                return result;
            }
        }

        // No routing found, use colored queue
        logger.info(`No routing found for compiler ${compilerId}, using colored queue`);
        const queueUrl = await getColoredQueueUrl();
        const result: RoutingInfo = {
            type: 'queue',
            target: queueUrl,
            environment: 'unknown',
        };
        // Cache the result
        routingCache.set(cacheKey, result);
        logger.debug(`Routing lookup complete for compiler: ${compilerId}, using colored queue`);
        return result;
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

export async function sendToSqs(
    guid: string,
    compilerId: string,
    body: string,
    isCmake: boolean,
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
        isCMake: isCmake,
        headers,
        queryStringParameters,
        ...requestData, // Merge all fields from the original request first
    };

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
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const s3Key = `${overflowConfig.keyPrefix}${environmentName}/${timestamp}/${guid}.json`;

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
