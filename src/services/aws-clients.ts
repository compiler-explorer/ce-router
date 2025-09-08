import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {S3Client} from '@aws-sdk/client-s3';
import {SQSClient} from '@aws-sdk/client-sqs';
import {SSMClient} from '@aws-sdk/client-ssm';
import {STSClient} from '@aws-sdk/client-sts';

const region = process.env.AWS_REGION || 'us-east-1';

export const dynamoDBClient = new DynamoDBClient({region});
export const s3Client = new S3Client({region});
export const sqsClient = new SQSClient({region});
export const ssmClient = new SSMClient({region});
export const stsClient = new STSClient({region});
