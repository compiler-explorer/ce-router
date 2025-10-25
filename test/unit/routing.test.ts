import {GetItemCommand} from '@aws-sdk/client-dynamodb';
import {PutObjectCommand} from '@aws-sdk/client-s3';
import {SendMessageCommand} from '@aws-sdk/client-sqs';
import {GetParameterCommand} from '@aws-sdk/client-ssm';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {clearRoutingCaches, lookupCompilerRouting, sendToSqs} from '../../src/services/routing.js';
import {mockDynamoDB, mockS3, mockSQS, mockSSM, resetAllMocks} from '../mocks/aws.js';

describe('Routing Service - S3 Overflow', () => {
    beforeEach(() => {
        resetAllMocks();
        // Reset environment variables to defaults
        delete process.env.SQS_MAX_MESSAGE_SIZE;
        delete process.env.S3_OVERFLOW_BUCKET;
        delete process.env.S3_OVERFLOW_KEY_PREFIX;
        process.env.ENVIRONMENT_NAME = 'test';
    });

    afterEach(() => {
        resetAllMocks();
        vi.clearAllMocks();
    });

    describe('sendToSqs', () => {
        const mockGuid = 'test-guid-123';
        const mockCompilerId = 'gcc-12';
        const mockQueueUrl = 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue.fifo';
        const mockHeaders = {'content-type': 'application/json'};
        const mockQueryParams = {};

        it('should send small messages directly to SQS without S3', async () => {
            // Create a small message
            const smallBody = JSON.stringify({
                source: 'int main() { return 0; }',
                options: ['-O2'],
            });

            // Mock SQS response
            mockSQS.on(SendMessageCommand).resolves({
                MessageId: 'msg-123',
                MD5OfMessageBody: 'abc123',
            });

            // Call the function
            await sendToSqs(mockGuid, mockCompilerId, smallBody, false, mockHeaders, mockQueryParams, mockQueueUrl);

            // Verify SQS was called
            const sqsCalls = mockSQS.commandCalls(SendMessageCommand);
            expect(sqsCalls).toHaveLength(1);

            // Verify the message body contains the actual data (not S3 reference)
            const sentMessage = JSON.parse(sqsCalls[0].args[0].input.MessageBody as string);
            expect(sentMessage.source).toBe('int main() { return 0; }');
            expect(sentMessage.options).toEqual(['-O2']);
            expect(sentMessage.guid).toBe(mockGuid);
            expect(sentMessage.compilerId).toBe(mockCompilerId);
            expect(sentMessage.type).toBeUndefined(); // Should NOT have type: 's3-overflow'

            // Verify S3 was NOT called
            const s3Calls = mockS3.commandCalls(PutObjectCommand);
            expect(s3Calls).toHaveLength(0);
        });

        it('should store large messages in S3 and send reference to SQS', async () => {
            // Set a small max message size for testing
            process.env.SQS_MAX_MESSAGE_SIZE = '1024'; // 1KB for testing

            // Create a large message (> 1KB)
            const largeSource = 'x'.repeat(2000); // 2KB of data
            const largeBody = JSON.stringify({
                source: largeSource,
                options: ['-O2', '-Wall'],
            });

            // Mock S3 response
            mockS3.on(PutObjectCommand).resolves({
                ETag: '"s3-etag-123"',
            });

            // Mock SQS response
            mockSQS.on(SendMessageCommand).resolves({
                MessageId: 'msg-456',
                MD5OfMessageBody: 'def456',
            });

            // Call the function
            await sendToSqs(mockGuid, mockCompilerId, largeBody, false, mockHeaders, mockQueryParams, mockQueueUrl);

            // Verify S3 was called
            const s3Calls = mockS3.commandCalls(PutObjectCommand);
            expect(s3Calls).toHaveLength(1);

            // Verify S3 upload parameters
            const s3Input = s3Calls[0].args[0].input;
            expect(s3Input.Bucket).toBe('temp-storage.godbolt.org');
            expect(s3Input.Key).toMatch(/^sqs-overflow\/test\/\d{4}-\d{2}-\d{2}\/test-guid-123\.json$/);
            expect(s3Input.ContentType).toBe('application/json');

            // Verify the actual data was uploaded to S3
            const uploadedData = JSON.parse(s3Input.Body as string);
            expect(uploadedData.source).toBe(largeSource);
            expect(uploadedData.guid).toBe(mockGuid);

            // Verify SQS was called with S3 reference
            const sqsCalls = mockSQS.commandCalls(SendMessageCommand);
            expect(sqsCalls).toHaveLength(1);

            // Verify the SQS message contains S3 reference (not actual data)
            const sentMessage = JSON.parse(sqsCalls[0].args[0].input.MessageBody as string);
            expect(sentMessage.type).toBe('s3-overflow');
            expect(sentMessage.guid).toBe(mockGuid);
            expect(sentMessage.compilerId).toBe(mockCompilerId);
            expect(sentMessage.s3Bucket).toBe('temp-storage.godbolt.org');
            expect(sentMessage.s3Key).toMatch(/^sqs-overflow\/test\/\d{4}-\d{2}-\d{2}\/test-guid-123\.json$/);
            expect(sentMessage.originalSize).toBeGreaterThan(1024);
            expect(sentMessage.source).toBeUndefined(); // Should NOT contain the actual source

            console.log(sentMessage);
        });

        it('should respect custom S3 configuration from environment variables', async () => {
            // Set custom configuration
            process.env.SQS_MAX_MESSAGE_SIZE = '512';
            process.env.S3_OVERFLOW_BUCKET = 'custom-bucket';
            process.env.S3_OVERFLOW_KEY_PREFIX = 'custom-prefix/';

            // Create a message larger than 512 bytes
            const body = JSON.stringify({
                source: 'y'.repeat(600),
                options: [],
            });

            // Mock responses
            mockS3.on(PutObjectCommand).resolves({ETag: '"etag"'});
            mockSQS.on(SendMessageCommand).resolves({MessageId: 'msg-789'});

            // Call the function
            await sendToSqs('custom-guid', 'clang-15', body, false, mockHeaders, mockQueryParams, mockQueueUrl);

            // Verify S3 was called with custom configuration
            const s3Calls = mockS3.commandCalls(PutObjectCommand);
            expect(s3Calls).toHaveLength(1);

            const s3Input = s3Calls[0].args[0].input;
            expect(s3Input.Bucket).toBe('custom-bucket');
            expect(s3Input.Key).toMatch(/^custom-prefix\/test\/\d{4}-\d{2}-\d{2}\/custom-guid\.json$/);

            // Verify SQS message references custom bucket
            const sqsCalls = mockSQS.commandCalls(SendMessageCommand);
            const sentMessage = JSON.parse(sqsCalls[0].args[0].input.MessageBody as string);
            expect(sentMessage.s3Bucket).toBe('custom-bucket');
            expect(sentMessage.s3Key).toMatch(/^custom-prefix\//);
        });

        it('should handle exactly the threshold size correctly', async () => {
            // Set threshold to a specific size
            process.env.SQS_MAX_MESSAGE_SIZE = '5000';

            // Create a message exactly at the threshold
            // We need to account for the full message structure, not just the source
            const testData = {source: 'a'.repeat(100), options: []};
            const fullMessage = {
                guid: mockGuid,
                compilerId: mockCompilerId,
                isCMake: false,
                headers: mockHeaders,
                queryStringParameters: mockQueryParams,
                source: testData.source,
                options: [],
                filters: {},
                backendOptions: {},
                tools: [],
                libraries: [],
                files: [],
                executeParameters: {},
            };

            // Calculate exact size and adjust source to be exactly at threshold
            const baseSize = Buffer.byteLength(JSON.stringify({...fullMessage, source: ''}), 'utf8');
            const sourceSize = 5000 - baseSize;
            const exactBody = JSON.stringify({source: 'z'.repeat(sourceSize), options: []});

            // Mock responses
            mockSQS.on(SendMessageCommand).resolves({MessageId: 'exact-msg'});

            // Call the function
            await sendToSqs(mockGuid, mockCompilerId, exactBody, false, mockHeaders, mockQueryParams, mockQueueUrl);

            // Message at exactly the threshold should go directly to SQS
            const sqsCalls = mockSQS.commandCalls(SendMessageCommand);
            expect(sqsCalls).toHaveLength(1);

            const sentMessage = JSON.parse(sqsCalls[0].args[0].input.MessageBody as string);
            expect(sentMessage.type).toBeUndefined(); // Should NOT be S3 overflow

            // S3 should NOT be called
            const s3Calls = mockS3.commandCalls(PutObjectCommand);
            expect(s3Calls).toHaveLength(0);
        });
    });

    describe('clearRoutingCaches', () => {
        beforeEach(() => {
            resetAllMocks();
            process.env.ENVIRONMENT_NAME = 'test';
        });

        it('should clear active color cache', async () => {
            // Set up SSM mock to return a color
            mockSSM.on(GetParameterCommand).resolves({
                Parameter: {Value: 'blue'},
            });

            // Set up DynamoDB mock
            mockDynamoDB.on(GetItemCommand).resolves({});

            // First call to populate the cache
            const routingInfo1 = await lookupCompilerRouting('gcc-12');
            expect(routingInfo1).toBeDefined();

            // Clear the cache
            clearRoutingCaches();

            // Mock SSM to return a different color
            mockSSM.on(GetParameterCommand).resolves({
                Parameter: {Value: 'green'},
            });

            // Second call should fetch fresh data (not cached)
            const routingInfo2 = await lookupCompilerRouting('gcc-12');

            // Verify SSM was called twice (once before clear, once after)
            const ssmCalls = mockSSM.commandCalls(GetParameterCommand);
            expect(ssmCalls.length).toBeGreaterThanOrEqual(2);
        });

        it('should clear routing cache', async () => {
            // Set up SSM mock
            mockSSM.on(GetParameterCommand).resolves({
                Parameter: {Value: 'blue'},
            });

            // Set up DynamoDB mock to return routing info
            mockDynamoDB.on(GetItemCommand).resolves({
                Item: {
                    compilerId: {S: 'test#gcc-special'},
                    routingType: {S: 'queue'},
                    queueName: {S: 'custom-queue'},
                },
            });

            // First lookup to populate routing cache
            const result1 = await lookupCompilerRouting('gcc-special');
            expect(result1.type).toBe('queue');

            // Count how many DynamoDB calls were made initially
            const initialDynamoDBCalls = mockDynamoDB.commandCalls(GetItemCommand).length;
            expect(initialDynamoDBCalls).toBeGreaterThanOrEqual(1);

            // Second lookup should use cache (fewer or no additional DynamoDB calls)
            await lookupCompilerRouting('gcc-special');
            const secondCallCount = mockDynamoDB.commandCalls(GetItemCommand).length;
            // Should be same as before (cache hit) or at most +1 for fallback lookup
            expect(secondCallCount).toBeLessThanOrEqual(initialDynamoDBCalls + 1);

            // Clear the cache
            clearRoutingCaches();

            // Third lookup should hit DynamoDB again (fresh lookups)
            await lookupCompilerRouting('gcc-special');
            const afterClearCallCount = mockDynamoDB.commandCalls(GetItemCommand).length;
            // Should have made at least one more call after clearing cache
            expect(afterClearCallCount).toBeGreaterThan(secondCallCount);
        });

        it('should not throw errors when clearing empty caches', () => {
            // Should not throw even if caches are empty
            expect(() => clearRoutingCaches()).not.toThrow();
        });
    });
});
