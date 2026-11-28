import {describe, expect, it} from 'vitest';
import {
    CompilerCacheInfo,
    CompilerCatalogue,
    buildCompilationCacheKey,
    hashCacheKey,
    splitArguments,
} from '../../src/services/compilation-cache-key.js';
import {buildQueueMessage} from '../../src/services/routing.js';

// The requests and hashes here are copied from compiler-explorer's test/compilation-cache-key-tests.ts, section "with a
// real CompilerInfo, matching what a dev instance computed". The hashes are what a CE instance looked these requests up
// under; if CE changes its key, those tests change, and these have to follow, or the router just stops finding anything.

const SOURCE = '#include <cstdio>\nint main() { std::puts("hi"); return 0; }\n';

// What /api/compilers gives for the compilers the dev instance used.
const COMPILERS: CompilerCacheInfo[] = [
    {id: 'g161', lang: 'c++', alias: []},
    {id: 'clang2110', lang: 'c++', alias: []},
];

const UI_COMPILER_OPTIONS = {
    producePp: null,
    produceGccDump: {libraryFunctions: false},
    produceOptInfo: false,
    produceCfg: false,
    produceIr: null,
    produceClangir: null,
    produceOptPipeline: null,
    produceDevice: false,
    produceLeanC: null,
    produceYul: null,
    overrides: [],
};

const UI_FILTERS = {
    binaryObject: false,
    binary: false,
    execute: false,
    intel: true,
    demangle: true,
    labels: true,
    libraryCode: true,
    directives: true,
    commentOnly: true,
    trim: false,
    debugCalls: false,
};

const FRONTEND_COMPILER_OPTIONS_ORDER = [
    'producePp',
    'produceAst',
    'produceGccDump',
    'produceOptInfo',
    'produceStackUsageInfo',
    'produceCfg',
    'produceGnatDebugTree',
    'produceGnatDebug',
    'produceIr',
    'produceClangir',
    'produceOptPipeline',
    'produceDevice',
    'produceRustMir',
    'produceRustMacroExp',
    'produceRustHir',
    'produceHaskellCore',
    'produceHaskellStg',
    'produceHaskellCmm',
    'produceLeanC',
    'produceClojureMacroExp',
    'produceYul',
    'overrides',
    'darkBackgroundColours',
];

function inFrontendOrder(options: Record<string, unknown>) {
    const known = FRONTEND_COMPILER_OPTIONS_ORDER.filter(name => name in options).map(name => [name, options[name]]);
    const extra = Object.entries(options).filter(([name]) => !FRONTEND_COMPILER_OPTIONS_ORDER.includes(name));
    return Object.fromEntries([...known, ...extra]);
}

function compilerPaneBody(
    changes: {
        compilerOptions?: object;
        filters?: object;
        userArguments?: string;
        tools?: any[];
        libraries?: any[];
    } = {},
) {
    return {
        source: SOURCE,
        compiler: 'g161',
        options: {
            userArguments: changes.userArguments ?? '-O2',
            compilerOptions: inFrontendOrder({...UI_COMPILER_OPTIONS, ...changes.compilerOptions}),
            filters: {...UI_FILTERS, ...changes.filters},
            tools: changes.tools ?? [],
            libraries: changes.libraries ?? [],
            executeParameters: {args: [], stdin: ''},
        },
        lang: 'c++',
        bypassCache: 0,
        allowStoreCodeDebug: true,
    };
}

/** A compiler pane request whose compilerOptions is replaced outright, for values the frontend never sends. */
function withCompilerOptions(compilerOptions: unknown) {
    const body = compilerPaneBody();
    return {...body, options: {...body.options, compilerOptions}};
}

function executorPaneBody() {
    return {
        source: SOURCE,
        compiler: 'g161',
        options: {
            userArguments: '-O2',
            executeParameters: {args: '', stdin: '', runtimeTools: []},
            compilerOptions: {executorRequest: true, skipAsm: true, overrides: [], darkBackgroundColours: true},
            filters: {execute: true},
            tools: [],
            libraries: [],
        },
        lang: 'c++',
        allowStoreCodeDebug: true,
    };
}

const GCC_DUMP_OPEN = {
    produceGccDump: {
        opened: true,
        treeDump: true,
        rtlDump: true,
        ipaDump: true,
        dumpFlags: {
            gimpleFe: false,
            address: false,
            alias: false,
            slim: false,
            raw: false,
            details: false,
            stats: false,
            blocks: false,
            vops: false,
            lineno: false,
            uid: false,
            all: false,
        },
        libraryFunctions: false,
    },
};

const catalogue = new CompilerCatalogue(COMPILERS);
const JSON_HEADERS = {'content-type': 'application/json'};

// What the router does with a request: the queue message it would send, then the key the worker would build from it.
function keyFor(
    compilerId: string,
    body: unknown,
    {
        headers = JSON_HEADERS as Record<string, string>,
        buildSystem = undefined as string | undefined,
        cat = catalogue,
    } = {},
) {
    const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
    const message = buildQueueMessage('a-guid', compilerId, bodyString, buildSystem, headers, {});
    return buildCompilationCacheKey(message, buildSystem, cat);
}

function hashFor(compilerId: string, body: unknown) {
    const outcome = keyFor(compilerId, body);
    if ('skip' in outcome) throw new Error(`skipped: ${outcome.skip}`);
    return hashCacheKey(outcome.key);
}

describe('Compilation cache key', () => {
    describe('matches what a CE dev instance computed', () => {
        const scenarios: [string, string, unknown, string][] = [
            [
                'compiler pane, no extra panes',
                'g161',
                compilerPaneBody(),
                '702296f4d606f556cf9fcad5485a25df9aa27b75e1a56f153dfd90ee7abdf5ec',
            ],
            [
                'compiler pane, link to binary',
                'g161',
                compilerPaneBody({filters: {binary: true}}),
                '64a51f778dd49bef7f35d096877551a725529f26c0a9ea4e05abf246947985c7',
            ],
            [
                'compiler pane, -E',
                'g161',
                compilerPaneBody({userArguments: '-E'}),
                '9f9451b2793b0b1298d3e44f386dbef5f88268998e45ee9f4d4c16d432bfa28d',
            ],
            [
                'compiler pane, boost 1.90 selected',
                'g161',
                compilerPaneBody({libraries: [{id: 'boost', version: '190'}]}),
                'f23189ff996613bb559fcf45fbb0a062c6a09a31781a3aa8bca73d84d215dfb2',
            ],
            [
                'compiler pane, -lfmt',
                'g161',
                compilerPaneBody({userArguments: '-O2 -lfmt'}),
                '82859c56709b75a3070ec095cc7ea5d240191d9191e93e1784c39ed90fb74433',
            ],
            [
                'compiler pane, clang-tidy added',
                'g161',
                compilerPaneBody({tools: [{id: 'clangtidytrunk', args: [], stdin: ''}]}),
                '6773b48257a8c278e99307f880f41045412ffcd88719aa74f968988dfadd3910',
            ],
            [
                'compiler pane, GCC dump pane open',
                'g161',
                compilerPaneBody({compilerOptions: GCC_DUMP_OPEN}),
                '37d74eaefe6a682655bca8658a8b46cbba5d3cbcd304a19de47bf8cfa68f7008',
            ],
            [
                'compiler pane, no extra panes',
                'clang2110',
                compilerPaneBody(),
                '646e25d7753dc67c4bd20e76658a6d1fd771699dbe95bd7e6782cb4b16314728',
            ],
            [
                'compiler pane, AST pane open',
                'clang2110',
                compilerPaneBody({compilerOptions: {produceAst: true}}),
                'a41eb74f79c1791aba4ebad240a792e5204d40aa1a754d7ced8bb90b026edf42',
            ],
            [
                'compiler pane, AST pane opened and closed again',
                'clang2110',
                compilerPaneBody({compilerOptions: {produceAst: false}}),
                'a0fc73ad295d80fdba0e05cb587e4ce49fb08dd2632ce1b6b175fbcb671d2563',
            ],
            [
                'compiler pane, opt remarks pane open',
                'clang2110',
                compilerPaneBody({compilerOptions: {produceOptInfo: true}}),
                'e40c651051814b85bffd0cfa42389be1ed007d5a82521350caebd6c499ef8574',
            ],
        ];

        it.each(scenarios)('%s on %s', (_, compilerId, body, devHash) => {
            expect(hashFor(compilerId, body)).toBe(devHash);
        });

        it('builds the key in the order CE hashes it', () => {
            const outcome = keyFor('g161', compilerPaneBody());
            expect(JSON.stringify(outcome)).toBe(
                JSON.stringify({
                    compilerId: 'g161',
                    key: {
                        compiler: {id: 'g161'},
                        source: SOURCE,
                        options: ['-O2'],
                        backendOptions: {
                            producePp: null,
                            produceGccDump: {libraryFunctions: false},
                            produceOptInfo: false,
                            produceCfg: false,
                            produceIr: null,
                            produceClangir: null,
                            produceOptPipeline: null,
                            produceDevice: false,
                            produceLeanC: null,
                            produceYul: null,
                            overrides: [],
                        },
                        filters: {
                            binaryObject: false,
                            binary: false,
                            execute: false,
                            intel: true,
                            demangle: true,
                            labels: true,
                            libraryCode: true,
                            directives: true,
                            commentOnly: true,
                            trim: false,
                            debugCalls: false,
                        },
                        tools: [],
                        libraries: [],
                        files: [],
                    },
                }),
            );
        });
    });

    describe('is not built for requests whose key the router cannot reproduce exactly', () => {
        it.each([
            ['"Execute the code" ticked', compilerPaneBody({filters: {execute: true}}), 'execute'],
            ['the executor pane', executorPaneBody(), 'execute'],
            ['bypassCache set to Compilation', {...compilerPaneBody(), bypassCache: 1}, 'bypass-cache'],
            ['bypassCache set the old way, as a boolean', {...compilerPaneBody(), bypassCache: true}, 'bypass-cache'],
            ['a string for filters', {...compilerPaneBody(), options: {filters: 'binary'}}, 'unusual-request'],
            ['a string for a tool', compilerPaneBody({tools: ['clangtidytrunk']}), 'unusual-request'],
            ['compilerOptions of false', withCompilerOptions(false), 'unusual-request'],
            ['compilerOptions of 0', withCompilerOptions(0), 'unusual-request'],
            ["compilerOptions of ''", withCompilerOptions(''), 'unusual-request'],
        ])('%s', (_, body, reason) => {
            expect(keyFor('g161', body)).toEqual({skip: reason});
        });

        it('a /noscript/ form', () => {
            const form = 'lang=c%2B%2B&compiler=g161&userArguments=-O2&source=int+x%3B';
            expect(keyFor('g161', form, {headers: {'content-type': 'application/x-www-form-urlencoded'}})).toEqual({
                skip: 'not-json',
            });
        });

        it('the plain-text REST API', () => {
            expect(keyFor('g161', SOURCE, {headers: {'content-type': 'text/plain'}})).toEqual({skip: 'not-json'});
        });

        it('a content type the worker does not take for JSON', () => {
            expect(keyFor('g161', compilerPaneBody(), {headers: {'content-type': 'application/json-seq'}})).toEqual({
                skip: 'not-json',
            });
        });

        it('a project build', () => {
            expect(keyFor('g161', compilerPaneBody(), {buildSystem: 'cmake'})).toEqual({skip: 'build'});
        });

        it('a compiler not in the list', () => {
            expect(keyFor('nosuchcompiler', compilerPaneBody())).toEqual({skip: 'unknown-compiler'});
        });

        it('a request whose own headers would replace the content type the worker sees', () => {
            const body = {...compilerPaneBody(), headers: {'content-type': 'text/plain'}};
            expect(keyFor('g161', body)).toEqual({skip: 'not-json'});
        });
    });

    describe('holds the request as the worker parsed it', () => {
        function keyOf(compilerId: string, body: unknown, cat = catalogue) {
            const outcome = keyFor(compilerId, body, {cat});
            if ('skip' in outcome) throw new Error(`skipped: ${outcome.skip}`);
            return outcome.key;
        }

        it('keeps the filters and backend options exactly as sent, whatever the compiler would make of them', () => {
            const body = {
                ...compilerPaneBody({userArguments: '-E -lfmt', compilerOptions: {darkBackgroundColours: true}}),
                files: [{filename: 'a.h', contents: ''}],
            };
            const key = keyOf('g161', body);
            expect(key.options).toEqual(['-E', '-lfmt']);
            expect(JSON.stringify(key.filters)).toBe(JSON.stringify(body.options.filters));
            expect(JSON.stringify(key.backendOptions)).toBe(JSON.stringify(body.options.compilerOptions));
        });

        it('splits string tool arguments, keeping their place', () => {
            const body = compilerPaneBody({tools: [{id: 'tool', args: '-a "b c"', stdin: ''}]});
            expect(keyOf('g161', body).tools).toEqual([{id: 'tool', args: ['-a', 'b c'], stdin: ''}]);
        });

        it('treats null compilerOptions as none, as the worker does', () => {
            const withNull = keyFor('g161', withCompilerOptions(null));
            const body = compilerPaneBody();
            const {compilerOptions: _, ...optionsWithout} = body.options;
            expect(withNull).toEqual(keyFor('g161', {...body, options: optionsWithout}));
            expect('key' in withNull && withNull.key.backendOptions).toEqual({});
        });

        it('takes options and source from where the router defaults them when the request leaves them out', () => {
            const key = keyOf('g161', {lang: 'c++'});
            expect(key.source).toBe('');
            expect(key.options).toEqual([]);
            expect(key.backendOptions).toEqual({});
        });

        it('finds a compiler by alias, using its own id in the key', () => {
            const cat = new CompilerCatalogue([{id: 'g161', lang: 'c++', alias: ['oldg161']}]);
            expect(keyOf('oldg161', compilerPaneBody(), cat).compiler).toEqual({id: 'g161'});
        });

        it('does not guess between compilers that share an alias', () => {
            const cat = new CompilerCatalogue([
                {id: 'a', lang: 'c', alias: ['shared']},
                {id: 'b', lang: 'c++', alias: ['shared']},
            ]);
            expect(keyFor('shared', {...compilerPaneBody(), lang: 'rust'}, {cat})).toEqual({
                skip: 'unknown-compiler',
            });
        });
    });

    describe('splitArguments', () => {
        it.each([
            ['-O2 -Wall', ['-O2', '-Wall']],
            ['  -O2   ', ['-O2']],
            ['-DX="a b"', ['-DX=a b']],
            ["-DX='a b'", ['-DX=a b']],
            ['a\\ b', ['a b']],
            ['', []],
        ])('%j', (input, expected) => {
            expect(splitArguments(input)).toEqual(expected);
        });
    });
});
