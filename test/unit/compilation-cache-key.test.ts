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

// The settings /api/compilers gives for the compilers the dev instance used.
const COMPILERS: CompilerCacheInfo[] = [
    {
        id: 'g161',
        lang: 'c++',
        alias: [],
        compilerType: '',
        supportsBinary: true,
        supportsBinaryObject: true,
        linkFlag: '-l',
    },
    {
        id: 'clang2110',
        lang: 'c++',
        alias: [],
        compilerType: 'clang',
        supportsBinary: true,
        supportsBinaryObject: true,
        linkFlag: '-l',
    },
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
    darkBackgroundColours: true,
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
                'd1475dc01d3c9464b477821ffea245539a292d0478dcbe3f1f8f517f805893d8',
            ],
            [
                'compiler pane, link to binary',
                'g161',
                compilerPaneBody({filters: {binary: true}}),
                'a43b06ea8fd13727d46cfe71cabbd02e8d3c0a0c13feafaff8d43912526539da',
            ],
            [
                'compiler pane, -E',
                'g161',
                compilerPaneBody({userArguments: '-E'}),
                '505cc8384f90f5f434bd628483613128381095980dd54cad06456e59477e7a87',
            ],
            [
                'compiler pane, boost 1.90 selected',
                'g161',
                compilerPaneBody({libraries: [{id: 'boost', version: '190'}]}),
                '058e8098a15485dad8295dd34e7c5ec9697e19952e16679465f5e5c4ae04c3a7',
            ],
            [
                'compiler pane, clang-tidy added',
                'g161',
                compilerPaneBody({tools: [{id: 'clangtidytrunk', args: [], stdin: ''}]}),
                '4ec44f8c605e15f34702a85d68aa4c1e5fe9a5d8b1da6586df02ff894cee111a',
            ],
            [
                'compiler pane, GCC dump pane open',
                'g161',
                compilerPaneBody({compilerOptions: GCC_DUMP_OPEN}),
                '5450e7c946202591105a091ccf7eb4952ab592ec574ba8625d93e6afa7d85a8b',
            ],
            [
                'compiler pane, no extra panes',
                'clang2110',
                compilerPaneBody(),
                '72c523d77a096efcf60d1bf5aa849b3876d1c5df967c92a830e9bd3af03fbea0',
            ],
            [
                'compiler pane, AST pane open',
                'clang2110',
                compilerPaneBody({compilerOptions: {produceAst: true}}),
                '00f33696122179a820d7d167bcc78785ab5373f623bb506bacb62225442a89a4',
            ],
            [
                'compiler pane, AST pane opened and closed again',
                'clang2110',
                compilerPaneBody({compilerOptions: {produceAst: false}}),
                '83cbfc662abcf3a98d092b6a7330d9d341ceecf9b39823a146fcd121a46134bb',
            ],
            [
                'compiler pane, opt remarks pane open',
                'clang2110',
                compilerPaneBody({compilerOptions: {produceOptInfo: true}}),
                'b89026aaae5ba7ce2b95eefd72628012824535fe85114f891fe3a6cc791e8abe',
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
                            binary: false,
                            execute: false,
                            demangle: true,
                            intel: true,
                            commentOnly: true,
                            directives: true,
                            labels: true,
                            optOutput: false,
                            libraryCode: true,
                            trim: false,
                            binaryObject: false,
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
            [
                '-lfmt, which the worker may turn into a library',
                compilerPaneBody({userArguments: '-O2 -lfmt'}),
                'link-flag',
            ],
            ['bypassCache set to Compilation', {...compilerPaneBody(), bypassCache: 1}, 'bypass-cache'],
            ['bypassCache set the old way, as a boolean', {...compilerPaneBody(), bypassCache: true}, 'bypass-cache'],
            ['a string for filters', {...compilerPaneBody(), options: {filters: 'binary'}}, 'unusual-request'],
            ['a string for a tool', compilerPaneBody({tools: ['clangtidytrunk']}), 'unusual-request'],
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

        it('a compiler type with a key of its own', () => {
            const cat = new CompilerCatalogue([{id: 'tinygo037', lang: 'go', compilerType: 'tinygo'}]);
            expect(keyFor('tinygo037', {...compilerPaneBody(), lang: 'go'}, {cat})).toEqual({skip: 'compiler-type'});
        });

        it('a request whose own headers would replace the content type the worker sees', () => {
            const body = {...compilerPaneBody(), headers: {'content-type': 'text/plain'}};
            expect(keyFor('g161', body)).toEqual({skip: 'not-json'});
        });
    });

    describe('normalises as the worker does', () => {
        function keyOf(compilerId: string, body: unknown, cat = catalogue) {
            const outcome = keyFor(compilerId, body, {cat});
            if ('skip' in outcome) throw new Error(`skipped: ${outcome.skip}`);
            return outcome.key;
        }

        it('drops a binary filter the compiler cannot honour', () => {
            const cat = new CompilerCatalogue([{id: 'nobin', lang: 'c++', supportsBinary: false}]);
            expect(keyOf('nobin', compilerPaneBody({filters: {binary: true}}), cat).filters).not.toHaveProperty(
                'binary',
            );
            expect(keyOf('nobin', compilerPaneBody(), cat).filters).toHaveProperty('binary', false);
        });

        it('keeps darkBackgroundColours, as a boolean, for a compiler whose output depends on it', () => {
            const cat = new CompilerCatalogue([{id: 'dark', lang: 'c++', supportsDarkBackgroundColours: true}]);
            const body = compilerPaneBody({compilerOptions: {darkBackgroundColours: 'yes'}});
            expect(keyOf('dark', body, cat).backendOptions.darkBackgroundColours).toBe(false);
            expect(Object.keys(keyOf('dark', body, cat).backendOptions).at(-1)).toBe('darkBackgroundColours');
        });

        it('marks filenames as unmasked when there are extra files', () => {
            const body = {...compilerPaneBody(), files: [{filename: 'a.h', contents: ''}]};
            expect(keyOf('g161', body).filters).toHaveProperty('dontMaskFilenames', true);
        });

        it('splits string tool arguments, keeping their place', () => {
            const body = compilerPaneBody({tools: [{id: 'tool', args: '-a "b c"', stdin: ''}]});
            expect(keyOf('g161', body).tools).toEqual([{id: 'tool', args: ['-a', 'b c'], stdin: ''}]);
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
