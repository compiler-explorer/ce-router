import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {S3Client} from '@aws-sdk/client-s3';
import {SQSClient} from '@aws-sdk/client-sqs';
import {SSMClient} from '@aws-sdk/client-ssm';
import {STSClient} from '@aws-sdk/client-sts';
import {mockClient} from 'aws-sdk-client-mock';

export const mockDynamoDB = mockClient(DynamoDBClient);
export const mockS3 = mockClient(S3Client);
export const mockSQS = mockClient(SQSClient);
export const mockSSM = mockClient(SSMClient);
export const mockSTS = mockClient(STSClient);

export const resetAllMocks = () => {
    mockDynamoDB.reset();
    mockS3.reset();
    mockSQS.reset();
    mockSSM.reset();
    mockSTS.reset();
};

export const restoreAllMocks = () => {
    mockDynamoDB.restore();
    mockS3.restore();
    mockSQS.restore();
    mockSSM.restore();
    mockSTS.restore();
};
