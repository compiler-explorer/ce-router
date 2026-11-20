import crypto from 'node:crypto';

/**
 * Builds the key a Compiler Explorer worker looks a compilation up under in its compilation cache, so that the router can
 * look a result up before queueing the request. Everything here mirrors code in the compiler-explorer repository, and
 * has to stay in step with it:
 *
 * - CompileHandler.parseRequestReusable (lib/handlers/compile.ts), the JSON branch: how the request is parsed;
 * - BaseCompiler.compile (lib/base-compiler.ts): fixFiltersBeforeCacheKey, fixBackendOptionsBeforeCacheKey, getCacheKey;
 * - BaseCache.hash (lib/cache/base.ts) and getHash (lib/utils.ts): how the key is hashed;
 * - splitArguments (shared/common-utils.ts): how a string of arguments is split.
 *
 * The key is hashed as a JSON string, so property order matters as much as the values.
 *
 * What makes this safe to get slightly wrong is that it can only fail one way: a key that differs from the worker's
 * misses, and the request is queued as it always was. The exception is a key that normalises *more* than the worker's
 * does, dropping or merging something the worker keeps, which could match a different compilation's entry. So
 * wherever the worker does something not reproduced here, the request is not checked at all (see SkipReason).
 */

const HASH_VERSION = 'Compiler Explorer Cache Version 1';

/** The fields of a CompilerInfo the key depends on, as /api/compilers?fields=... gives them. */
export interface CompilerCacheInfo {
    id: string;
    lang: string;
    alias?: string[];
    compilerType?: string;
    supportsBinary?: boolean;
    supportsBinaryObject?: boolean;
    supportsDarkBackgroundColours?: boolean;
    linkFlag?: string;
}

export const COMPILER_CACHE_INFO_FIELDS = [
    'id',
    'lang',
    'alias',
    'compilerType',
    'supportsBinary',
    'supportsBinaryObject',
    'supportsDarkBackgroundColours',
    'linkFlag',
] as const;

/**
 * Compiler types whose class, or a class it inherits from, changes the key: by overriding getDefaultFilters,
 * fixFiltersBeforeCacheKey or compile() itself. Requests for these are not checked. Found in lib/compilers/ by looking
 * for those overrides and following `extends`; a type added there with an override of its own has to be added here.
 */
export const COMPILER_TYPES_WITH_OWN_CACHE_KEY: ReadonlySet<string> = new Set([
    'analysis-tool', // getDefaultFilters
    'llvm-mca', // extends analysis-tool
    'osaca', // getDefaultFilters, extends analysis-tool
    'android-d8', // builds filters from other compilers' defaults
    'android-r8', // extends android-d8
    'dex2oat', // builds filters from other compilers' defaults
    'coccinelle_for_c', // getDefaultFilters
    'coccinelle_for_cpp', // extends coccinelle_for_c
    'cutedsl', // getDefaultFilters
    'llvmmos', // fixFiltersBeforeCacheKey
    'micropython', // compile() sets filters.binary
    'tilelang', // getDefaultFilters
    'tinygo', // fixFiltersBeforeCacheKey
    'triton', // getDefaultFilters
]);

/** BaseCompiler.getDefaultFilters(), in its order: the order is part of the key. */
function defaultFilters(): Record<string, unknown> {
    return {
        binary: false,
        execute: false,
        demangle: true,
        intel: true,
        commentOnly: true,
        directives: true,
        labels: true,
        optOutput: false,
        libraryCode: false,
        trim: false,
        binaryObject: false,
        debugCalls: false,
    };
}

export interface CompilationCacheKey {
    compiler: {id: string};
    source: string;
    options: string[];
    backendOptions: Record<string, unknown>;
    filters: Record<string, unknown>;
    tools: unknown[];
    libraries: unknown;
    files: unknown[];
}

export type SkipReason =
    | 'not-json'
    | 'build'
    | 'bypass-cache'
    | 'execute'
    | 'unknown-compiler'
    | 'compiler-type'
    | 'link-flag'
    | 'unusual-request';

export type CacheKeyOutcome = {key: CompilationCacheKey; compilerId: string} | {skip: SkipReason};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The worker's test for a JSON request: isJsonContentType in lib/compilation/sqs-compilation-queue.ts. */
export function isJsonContentType(contentType: unknown): boolean {
    const value = Array.isArray(contentType) ? contentType[0] : contentType;
    return typeof value === 'string' && value.split(';')[0].trim().toLowerCase() === 'application/json';
}

/** The compilers a worker knows, found the way CompileHandler.findCompiler finds them. */
export class CompilerCatalogue {
    private readonly byLang = new Map<string, Map<string, CompilerCacheInfo>>();
    private readonly all: CompilerCacheInfo[];

    constructor(compilers: CompilerCacheInfo[]) {
        this.all = compilers.filter(c => c && typeof c.id === 'string' && typeof c.lang === 'string');
        for (const compiler of this.all) {
            let langCompilers = this.byLang.get(compiler.lang);
            if (!langCompilers) {
                langCompilers = new Map();
                this.byLang.set(compiler.lang, langCompilers);
            }
            if (!langCompilers.has(compiler.id)) langCompilers.set(compiler.id, compiler);
        }
    }

    get size(): number {
        return this.all.length;
    }

    /**
     * The compiler the worker would pick for this language and id, or undefined if there is none, or if which one it
     * picks depends on an iteration order this list need not share with the worker's.
     */
    find(lang: unknown, compilerId: unknown): CompilerCacheInfo | undefined {
        if (typeof compilerId !== 'string' || !compilerId) return undefined;
        const aliasMatch = (c: CompilerCacheInfo) => Array.isArray(c.alias) && c.alias.includes(compilerId);

        if (typeof lang === 'string') {
            const langCompilers = this.byLang.get(lang);
            if (langCompilers) {
                const exact = langCompilers.get(compilerId);
                if (exact) return exact;
                const byAlias = [...langCompilers.values()].filter(aliasMatch);
                if (byAlias.length === 1) return byAlias[0];
                if (byAlias.length > 1) return undefined;
            }
        } else if (lang !== undefined && lang !== null) {
            // The worker indexes an object with it; not worth reproducing.
            return undefined;
        }

        const matches = this.all.filter(c => c.id === compilerId || aliasMatch(c));
        return matches.length === 1 ? matches[0] : undefined;
    }
}

/**
 * The key the worker would look the queued message up under, or why the request isn't checked.
 *
 * @param message what the worker is sent: see buildQueueMessage in routing.ts.
 * @param buildSystem the build system of a project build, which never reads this cache.
 */
export function buildCompilationCacheKey(
    message: Record<string, any>,
    buildSystem: string | undefined,
    catalogue: CompilerCatalogue,
): CacheKeyOutcome {
    if (buildSystem || message.buildSystem || message.isCMake) return {skip: 'build'};
    if (!isPlainObject(message.headers) || !isJsonContentType(message.headers['content-type'])) {
        return {skip: 'not-json'};
    }

    const compiler = catalogue.find(message.lang, message.compilerId);
    if (!compiler) return {skip: 'unknown-compiler'};
    if (compiler.compilerType && COMPILER_TYPES_WITH_OWN_CACHE_KEY.has(compiler.compilerType)) {
        return {skip: 'compiler-type'};
    }

    // parseRequestReusable
    const requestOptions = message.options;
    if (!isPlainObject(requestOptions) && !Array.isArray(requestOptions)) return {skip: 'unusual-request'};
    const opts = requestOptions as Record<string, any>;

    const source = message.source;
    if (typeof source !== 'string') return {skip: 'unusual-request'};

    // `1 * x`, as the worker converts it: true and '1' both mean Compilation.
    const bypassCache = 1 * (message.bypassCache ? message.bypassCache : 0);
    if (bypassCache === 1) return {skip: 'bypass-cache'};

    let options: string[];
    if (Array.isArray(opts.userArguments)) {
        if (!opts.userArguments.every((arg: unknown) => typeof arg === 'string')) return {skip: 'unusual-request'};
        options = opts.userArguments;
    } else if (typeof opts.userArguments === 'string') {
        options = splitArguments(opts.userArguments);
    } else {
        options = [];
    }

    const compilerOptions = opts.compilerOptions || {};
    if (!isPlainObject(compilerOptions)) return {skip: 'unusual-request'};
    const backendOptions: Record<string, unknown> = {...compilerOptions};

    const requestFilters = opts.filters;
    if (requestFilters !== undefined && requestFilters !== null && !isPlainObject(requestFilters)) {
        return {skip: 'unusual-request'};
    }
    const filters: Record<string, unknown> = {...defaultFilters(), ...requestFilters};

    const inputTools = opts.tools || [];
    if (!Array.isArray(inputTools) || !inputTools.every(isPlainObject)) return {skip: 'unusual-request'};
    const tools = inputTools.map(tool =>
        typeof tool.args === 'string' ? {...tool, args: splitArguments(tool.args)} : tool,
    );

    const libraries = opts.libraries || [];

    const files = message.files || [];
    if (!Array.isArray(files)) return {skip: 'unusual-request'};

    // A compile that is also run needs the execution cache as well, whose key is a different thing again.
    if (filters.execute || backendOptions.executorRequest) return {skip: 'execute'};

    // tryAutodetectLibraries may turn these into libraries, which changes both options and libraries.
    const linkFlag = compiler.linkFlag || '-l';
    if (options.some(option => option.indexOf(linkFlag) === 0)) return {skip: 'link-flag'};

    // fixFiltersBeforeCacheKey
    if (filters.binary && !compiler.supportsBinary) {
        delete filters.binary;
    }
    if ((compiler.lang === 'c++' || compiler.lang === 'c') && options.includes('-E')) {
        for (const name in filters) {
            filters[name] = false;
        }
        if (filters.binaryObject && !compiler.supportsBinaryObject) {
            delete filters.binaryObject;
        }
    }
    if (files.length > 0) {
        filters.dontMaskFilenames = true;
    }

    // fixBackendOptionsBeforeCacheKey
    if (compiler.supportsDarkBackgroundColours) {
        backendOptions.darkBackgroundColours = backendOptions.darkBackgroundColours === true;
    } else {
        delete backendOptions.darkBackgroundColours;
    }

    // getCacheKey
    return {
        compilerId: compiler.id,
        key: {compiler: {id: compiler.id}, source, options, backendOptions, filters, tools, libraries, files},
    };
}

/** BaseCache.hash: the name of the key's entry in the cache, and so of its object under the cache's S3 prefix. */
export function hashCacheKey(key: CompilationCacheKey): string {
    return crypto.createHmac('sha256', HASH_VERSION).update(JSON.stringify(key)).digest('hex');
}

/** splitArguments from shared/common-utils.ts, unchanged. */
export function splitArguments(str = ''): string[] {
    return new ArgumentParser(str).exec();
}

class ArgumentParser {
    private rest: string;
    private position: number;
    private inDoubleQuotes: boolean;
    private readonly results: string[];

    constructor(str: string) {
        this.rest = str.trim();
        this.position = 0;
        this.inDoubleQuotes = false;
        this.results = [];
    }

    private addResult(result: string) {
        if (this.results[this.position] === undefined) {
            this.results[this.position] = result;
        } else {
            this.results[this.position] += result;
        }
    }

    private handleEscapeCharacter() {
        if (this.rest.length < 2) {
            this.addResult('\\');
        } else {
            if (this.rest.charAt(1) !== '\n') {
                this.addResult(this.rest.charAt(1));
            }
        }
        this.rest = this.rest.slice(2);
    }

    private handleSingleQuotes() {
        let quotePos = this.rest.indexOf("'", 1);
        if (quotePos === -1) quotePos = this.rest.length;
        this.addResult(this.rest.slice(1, quotePos));
        this.rest = this.rest.slice(quotePos + 1);
    }

    private handleDoubleQuotes() {
        const match = /["\\]/.exec(this.rest);
        const matchEnd = match ? match.index : this.rest.length;

        this.addResult(this.rest.slice(0, matchEnd));

        if (match && match[0] === '\\') {
            this.rest = this.rest.slice(matchEnd);
            this.handleEscapeCharacter();
        } else {
            this.rest = this.rest.slice(matchEnd + 1);
            this.inDoubleQuotes = false;
        }
    }

    private handleWhitespace() {
        const wsMatch = /^\s+/.exec(this.rest);
        if (wsMatch) {
            this.rest = this.rest.slice(wsMatch[0].length);
            ++this.position;
        }
    }

    private handleNonDoubleQuote(nextMatch: RegExpExecArray) {
        this.addResult(this.rest.slice(0, nextMatch.index));
        this.rest = this.rest.slice(nextMatch.index);

        switch (nextMatch[0]) {
            case '\\':
                this.handleEscapeCharacter();
                break;
            case "'":
                this.handleSingleQuotes();
                break;
            case '"':
                this.rest = this.rest.slice(1);
                this.inDoubleQuotes = true;
                break;
            default:
                break;
        }
    }

    public exec(): string[] {
        while (this.rest) {
            if (this.inDoubleQuotes) {
                this.handleDoubleQuotes();
                continue;
            }

            this.handleWhitespace();

            const nextMatch = /[\s'"\\]/.exec(this.rest);
            if (!nextMatch) {
                this.addResult(this.rest);
                this.rest = '';
                continue;
            }

            this.handleNonDoubleQuote(nextMatch);
        }
        return this.results;
    }
}
