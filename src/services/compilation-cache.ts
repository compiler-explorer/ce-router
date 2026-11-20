import {GetObjectCommand, NoSuchKey, S3Client} from '@aws-sdk/client-s3';
import axios from 'axios';
import {logger} from '../lib/logger.js';
import {compilationCacheCounter} from '../lib/metrics.js';
import {CompilationResult} from '../utils/index.js';
import {s3Client as defaultS3Client} from './aws-clients.js';
import {
    COMPILER_CACHE_INFO_FIELDS,
    CompilerCacheInfo,
    CompilerCatalogue,
    buildCompilationCacheKey,
    hashCacheKey,
} from './compilation-cache-key.js';
import {buildQueueMessage} from './routing.js';

export interface CompilationCacheOptions {
    /** /api/compilers of the environment whose workers this router queues for. */
    compilerListUrl: string;
    /** Where the workers' compilation cache keeps its entries: S3(storage.godbolt.org,cache,...) in CE's config. */
    bucket?: string;
    prefix?: string;
    refreshIntervalMs?: number;
    /** A lookup that takes longer than this is given up on, and the request queued. */
    lookupTimeoutMs?: number;
    s3Client?: S3Client;
    fetchCompilers?: () => Promise<CompilerCacheInfo[]>;
}

/** The /api/compilers address for an environment, as named by ENVIRONMENT_NAME. */
export function compilerListUrlFor(environmentName: string): string {
    return environmentName === 'prod'
        ? 'https://godbolt.org/api/compilers'
        : `https://godbolt.org/${environmentName}/api/compilers`;
}

/**
 * Answers a compile request from the workers' compilation cache, when it holds the result, so the request needn't be
 * queued. The key is built the way a worker builds it (see compilation-cache-key.ts), from the compiler settings
 * /api/compilers gives; until that list has loaded, nothing is checked.
 */
export class CompilationCache {
    private catalogue: CompilerCatalogue | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;
    private readonly bucket: string;
    private readonly prefix: string;
    private readonly refreshIntervalMs: number;
    private readonly lookupTimeoutMs: number;
    private readonly s3: S3Client;
    private readonly fetchCompilers: () => Promise<CompilerCacheInfo[]>;

    constructor(private readonly options: CompilationCacheOptions) {
        this.bucket = options.bucket ?? (process.env.COMPILATION_RESULTS_BUCKET || 'storage.godbolt.org');
        this.prefix = options.prefix ?? (process.env.COMPILATION_RESULTS_PREFIX || 'cache/');
        this.refreshIntervalMs = options.refreshIntervalMs ?? 10 * 60 * 1000;
        this.lookupTimeoutMs = options.lookupTimeoutMs ?? 1000;
        this.s3 = options.s3Client ?? defaultS3Client;
        this.fetchCompilers = options.fetchCompilers ?? (() => this.fetchCompilerList());
    }

    /** Loads the compiler list, and keeps it fresh. Never throws: without a list, requests just aren't checked. */
    async start(): Promise<void> {
        await this.refresh();
        this.refreshTimer = setInterval(() => void this.refresh(), this.refreshIntervalMs);
        this.refreshTimer.unref();
    }

    stop(): void {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = undefined;
    }

    setCompilers(compilers: CompilerCacheInfo[]): void {
        this.catalogue = new CompilerCatalogue(compilers);
    }

    async refresh(): Promise<void> {
        try {
            const compilers = await this.fetchCompilers();
            this.setCompilers(compilers);
            logger.info(`Compilation cache check: loaded settings of ${this.catalogue?.size} compilers`);
        } catch (error) {
            // An old list is still right for nearly every compiler, so keep using it.
            logger.warn(
                `Compilation cache check: failed to load the compiler list${this.catalogue ? ', keeping the last one' : ''}:`,
                error,
            );
        }
    }

    private async fetchCompilerList(): Promise<CompilerCacheInfo[]> {
        const response = await axios.get(this.options.compilerListUrl, {
            params: {fields: COMPILER_CACHE_INFO_FIELDS.join(',')},
            headers: {Accept: 'application/json'},
            timeout: 30_000,
        });
        if (!Array.isArray(response.data)) throw new Error('Compiler list is not an array');
        return response.data;
    }

    /**
     * The cached result for this request, ready to send, or null if the request is to be queued: because the cache
     * doesn't hold it, because the request is one this can't build the worker's key for, or because looking failed.
     * Never throws.
     */
    async lookup(
        compilerId: string,
        body: string,
        buildSystem: string | undefined,
        headers: Record<string, string | string[]>,
        queryStringParameters: Record<string, string>,
    ): Promise<CompilationResult | null> {
        const catalogue = this.catalogue;
        if (!catalogue) {
            compilationCacheCounter.inc({result: 'skipped', reason: 'no-compiler-list'});
            return null;
        }

        let hash: string;
        try {
            const message = buildQueueMessage('', compilerId, body, buildSystem, headers, queryStringParameters);
            const outcome = buildCompilationCacheKey(message, buildSystem, catalogue);
            if ('skip' in outcome) {
                compilationCacheCounter.inc({result: 'skipped', reason: outcome.skip});
                logger.debug(`Compilation cache check skipped for ${compilerId}: ${outcome.skip}`);
                return null;
            }
            hash = hashCacheKey(outcome.key);
        } catch (error) {
            compilationCacheCounter.inc({result: 'error', reason: 'key'});
            logger.warn(`Compilation cache check failed to build a key for ${compilerId}:`, error);
            return null;
        }

        const start = performance.now();
        try {
            const response = await this.s3.send(new GetObjectCommand({Bucket: this.bucket, Key: this.prefix + hash}), {
                abortSignal: AbortSignal.timeout(this.lookupTimeoutMs),
            });
            const text = await response.Body?.transformToString();
            const result = text ? JSON.parse(text) : undefined;
            if (!result || typeof result !== 'object' || Array.isArray(result)) {
                throw new Error('Cache entry is not a compilation result');
            }
            const lookupMs = performance.now() - start;

            // As the worker answers a cache hit (BaseCompiler.compile) and then sends it (sendCompilationResultViaWebsocket).
            delete result.s3Key;
            result.retreivedFromCache = true;
            result.retreivedFromCacheTime = lookupMs;
            result.okToCache = result.okToCache ?? false;

            compilationCacheCounter.inc({result: 'hit', reason: ''});
            logger.info(`Compilation cache hit for ${compilerId}: ${hash} in ${lookupMs.toFixed(0)}ms`);
            return result;
        } catch (error) {
            if (error instanceof NoSuchKey) {
                compilationCacheCounter.inc({result: 'miss', reason: ''});
                logger.info(`Compilation cache miss for ${compilerId}: ${hash}`);
            } else {
                compilationCacheCounter.inc({result: 'error', reason: 'lookup'});
                logger.warn(`Compilation cache lookup failed for ${compilerId} (${hash}):`, error);
            }
            return null;
        }
    }
}
