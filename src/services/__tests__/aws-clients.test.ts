import {GetItemCommand, PutItemCommand} from '@aws-sdk/client-dynamodb';
import {GetObjectCommand, PutObjectCommand} from '@aws-sdk/client-s3';
import {SendMessageCommand} from '@aws-sdk/client-sqs';
import {GetParameterCommand} from '@aws-sdk/client-ssm';
import {GetCallerIdentityCommand} from '@aws-sdk/client-sts';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mockDynamoDB, mockS3, mockSQS, mockSSM, mockSTS, resetAllMocks} from '../../__mocks__/aws';
import {dynamoDBClient, s3Client, sqsClient, ssmClient, stsClient} from '../aws-clients';

describe('AWS Clients', () => {
    beforeEach(() => {
        resetAllMocks();
    });

    afterEach(() => {
        resetAllMocks();
    });

    describe('DynamoDB Client', () => {
        it('should get item from DynamoDB', async () => {
            const mockItem = {
                Item: {
                    id: {S: '123'},
                    name: {S: 'Test Item'},
                },
            };

            mockDynamoDB.on(GetItemCommand).resolves(mockItem);

            const command = new GetItemCommand({
                TableName: 'test-table',
                Key: {id: {S: '123'}},
            });

            const result = await dynamoDBClient.send(command);
            expect(result).toEqual(mockItem);
        });

        it('should put item to DynamoDB', async () => {
            mockDynamoDB.on(PutItemCommand).resolves({});

            const command = new PutItemCommand({
                TableName: 'test-table',
                Item: {
                    id: {S: '123'},
                    name: {S: 'Test Item'},
                },
            });

            await expect(dynamoDBClient.send(command)).resolves.toBeDefined();
        });
    });

    describe('S3 Client', () => {
        it('should get object from S3', async () => {
            const mockObject = {
                Body: 'test content',
                ContentType: 'text/plain',
            };

            mockS3.on(GetObjectCommand).resolves(mockObject);

            const command = new GetObjectCommand({
                Bucket: 'test-bucket',
                Key: 'test-key',
            });

            const result = await s3Client.send(command);
            expect(result).toEqual(mockObject);
        });

        it('should put object to S3', async () => {
            mockS3.on(PutObjectCommand).resolves({
                ETag: '"123456"',
            });

            const command = new PutObjectCommand({
                Bucket: 'test-bucket',
                Key: 'test-key',
                Body: 'test content',
            });

            const result = await s3Client.send(command);
            expect(result.ETag).toBe('"123456"');
        });
    });

    describe('SQS Client', () => {
        it('should send message to SQS', async () => {
            const mockResponse = {
                MessageId: 'msg-123',
                MD5OfMessageBody: 'abc123',
            };

            mockSQS.on(SendMessageCommand).resolves(mockResponse);

            const command = new SendMessageCommand({
                QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue',
                MessageBody: JSON.stringify({test: 'data'}),
            });

            const result = await sqsClient.send(command);
            expect(result.MessageId).toBe('msg-123');
        });
    });

    describe('SSM Client', () => {
        it('should get parameter from SSM', async () => {
            const mockParameter = {
                Parameter: {
                    Name: '/test/parameter',
                    Value: 'secret-value',
                    Type: 'SecureString',
                },
            };

            mockSSM.on(GetParameterCommand).resolves(mockParameter);

            const command = new GetParameterCommand({
                Name: '/test/parameter',
                WithDecryption: true,
            });

            const result = await ssmClient.send(command);
            expect(result.Parameter?.Value).toBe('secret-value');
        });
    });

    describe('STS Client', () => {
        it('should get caller identity', async () => {
            const mockIdentity = {
                UserId: 'AIDAI23456789',
                Account: '123456789012',
                Arn: 'arn:aws:iam::123456789012:user/test-user',
            };

            mockSTS.on(GetCallerIdentityCommand).resolves(mockIdentity);

            const command = new GetCallerIdentityCommand({});
            const result = await stsClient.send(command);

            expect(result.Account).toBe('123456789012');
            expect(result.Arn).toContain('test-user');
        });
    });
});
