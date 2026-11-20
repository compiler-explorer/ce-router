import {GetObjectCommand, NoSuchKey, S3Client} from '@aws-sdk/client-s3';
import {mockClient} from 'aws-sdk-client-mock';
import request from 'supertest';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {compilationCacheCounter, metricsRegistry} from '../../src/lib/metrics.js';
import {CompilationCache, compilerListUrlFor} from '../../src/services/compilation-cache.js';
import {TestableCompilerExplorerRouter} from '../mocks/testable-router.js';

const SOURCE = 'int main() { return 42; }';
const BODY = {source: SOURCE, options: {userArguments: '-O2', filters: {intel: true}}, lang: 'c++'};
const JSON_HEADERS = {'content-type': 'application/json'};
const STORED = {code: 0, asm: [{text: 'mov eax, 42'}], stdout: [], stderr: [], okToCache: true, s3Key: 'stale'};

const s3 = new S3Client({region: 'us-east-1'});
const mockS3 = mockClient(s3);

function cacheWithCompilers() {
    const cache = new CompilationCache({compilerListUrl: 'unused', s3Client: s3, bucket: 'bucket', prefix: 'cache/'});
    cache.setCompilers([{id: 'g161', lang: 'c++', supportsBinary: true}]);
    return cache;
}

function storedEntry(result: object) {
    return {Body: {transformToString: async () => JSON.stringify(result)}} as any;
}

async function counts() {
    const metric = await compilationCacheCounter.get();
    return Object.fromEntries(metric.values.map(v => [`${v.labels.result}/${v.labels.reason}`, v.value]));
}

describe('CompilationCache', () => {
    beforeEach(() => {
        mockS3.reset();
        compilationCacheCounter.reset();
    });

    it('answers a hit with the stored result, marked as coming from the cache, without an s3Key', async () => {
        mockS3.on(GetObjectCommand).resolves(storedEntry(STORED));
        const result = await cacheWithCompilers().lookup('g161', JSON.stringify(BODY), undefined, JSON_HEADERS, {});
        expect(result).toMatchObject({code: 0, asm: [{text: 'mov eax, 42'}], retreivedFromCache: true});
        expect(result).not.toHaveProperty('s3Key');

        const key = mockS3.commandCalls(GetObjectCommand)[0].args[0].input.Key;
        expect(key).toMatch(/^cache\/[0-9a-f]{64}$/);
        expect(await counts()).toEqual({'hit/': 1});
    });

    it('treats a missing entry as a miss', async () => {
        mockS3.on(GetObjectCommand).rejects(new NoSuchKey({message: 'nope', $metadata: {}}));
        expect(await cacheWithCompilers().lookup('g161', JSON.stringify(BODY), undefined, JSON_HEADERS, {})).toBeNull();
        expect(await counts()).toEqual({'miss/': 1});
    });

    it('treats any other failure as a miss, counted apart', async () => {
        mockS3.on(GetObjectCommand).rejects(new Error('access denied'));
        expect(await cacheWithCompilers().lookup('g161', JSON.stringify(BODY), undefined, JSON_HEADERS, {})).toBeNull();
        expect(await counts()).toEqual({'error/lookup': 1});
    });

    it('does not look when it cannot build the key, and says why', async () => {
        const body = JSON.stringify({...BODY, options: {...BODY.options, filters: {execute: true}}});
        expect(await cacheWithCompilers().lookup('g161', body, undefined, JSON_HEADERS, {})).toBeNull();
        expect(mockS3.commandCalls(GetObjectCommand)).toHaveLength(0);
        expect(await counts()).toEqual({'skipped/execute': 1});
    });

    it('does not look before it has the compiler list', async () => {
        const cache = new CompilationCache({compilerListUrl: 'unused', s3Client: s3});
        expect(await cache.lookup('g161', JSON.stringify(BODY), undefined, JSON_HEADERS, {})).toBeNull();
        expect(mockS3.commandCalls(GetObjectCommand)).toHaveLength(0);
        expect(await counts()).toEqual({'skipped/no-compiler-list': 1});
    });

    it('keeps the last compiler list when a refresh fails', async () => {
        let fail = false;
        const cache = new CompilationCache({
            compilerListUrl: 'unused',
            s3Client: s3,
            fetchCompilers: async () => {
                if (fail) throw new Error('down');
                return [{id: 'g161', lang: 'c++'}];
            },
        });
        await cache.refresh();
        fail = true;
        await cache.refresh();
        mockS3.on(GetObjectCommand).resolves(storedEntry(STORED));
        expect(await cache.lookup('g161', JSON.stringify(BODY), undefined, JSON_HEADERS, {})).not.toBeNull();
    });

    it('names each environment its own compiler list', () => {
        expect(compilerListUrlFor('prod')).toBe('https://godbolt.org/api/compilers');
        expect(compilerListUrlFor('beta')).toBe('https://godbolt.org/beta/api/compilers');
    });
});

describe('Router with a compilation cache', () => {
    let router: TestableCompilerExplorerRouter;

    beforeEach(async () => {
        mockS3.reset();
        router = new TestableCompilerExplorerRouter({timeoutSeconds: 5, compilationCache: cacheWithCompilers()});
        await router.start();
    });

    afterEach(() => router.stop());

    it('answers a hit without queueing the request', async () => {
        mockS3.on(GetObjectCommand).resolves(storedEntry(STORED));
        const response = await request(router.getApp())
            .post('/api/compiler/g161/compile')
            .set('Accept', 'application/json')
            .send(BODY)
            .expect(200);
        expect(response.body).toMatchObject({code: 0, asm: [{text: 'mov eax, 42'}], retreivedFromCache: true});
        expect(router.getMockRoutingService().getSentRequests()).toHaveLength(0);
    });

    it('answers a hit as text when the caller asked for text', async () => {
        mockS3.on(GetObjectCommand).resolves(storedEntry(STORED));
        const response = await request(router.getApp()).post('/api/compiler/g161/compile').send(BODY).expect(200);
        expect(response.text).toContain('mov eax, 42');
        expect(router.getMockRoutingService().getSentRequests()).toHaveLength(0);
    });

    it('queues a miss as before', async () => {
        mockS3.on(GetObjectCommand).rejects(new NoSuchKey({message: 'nope', $metadata: {}}));
        router.getMockResultWaiter().waitForResult = async () => ({code: 0, asm: [{text: 'compiled'}]});
        const response = await request(router.getApp())
            .post('/api/compiler/g161/compile')
            .set('Accept', 'application/json')
            .send(BODY)
            .expect(200);
        expect(response.body).toMatchObject({asm: [{text: 'compiled'}]});
        expect(router.getMockRoutingService().getSentRequests()).toHaveLength(1);
    });

    it('does not check a project build', async () => {
        router.getMockResultWaiter().waitForResult = async () => ({code: 0});
        await request(router.getApp()).post('/api/compiler/g161/cmake').send(BODY).expect(200);
        expect(mockS3.commandCalls(GetObjectCommand)).toHaveLength(0);
        expect(router.getMockRoutingService().getSentRequests()).toHaveLength(1);
    });

    it('serves the counts on /metrics', async () => {
        const response = await request(router.getApp()).get('/metrics').expect(200);
        expect(response.text).toContain('ce_router_compilation_cache_total');
        expect(metricsRegistry.contentType).toContain('text/plain');
    });
});
