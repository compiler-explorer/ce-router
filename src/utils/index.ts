import {v4 as uuidv4} from 'uuid';
import {logger} from '../lib/logger.js';

const TRIM_SLASHES_REGEX = /^\/+|\/+$/g;
const TEXT_BANNER = 'Compilation provided by Compiler Explorer at https://godbolt.org/';

export function generateGuid(): string {
    return uuidv4();
}

export function extractCompilerId(path: string): string | null {
    try {
        const pathParts = path.replaceAll(TRIM_SLASHES_REGEX, '').split('/');

        // Production format: /api/compiler/{compiler_id}/compile
        if (pathParts.length >= 4 && pathParts[0] === 'api' && pathParts[1] === 'compiler') {
            return pathParts[2];
        }

        // Other environments format: /{env}/api/compiler/{compiler_id}/compile
        if (pathParts.length >= 5 && pathParts[1] === 'api' && pathParts[2] === 'compiler') {
            return pathParts[3];
        }
    } catch (error) {
        // Ignore parse errors
    }
    return null;
}

/** The one build system that predates /build/{build_system} and has an endpoint of its own. */
export const CMAKE_BUILD_SYSTEM = 'cmake';

/**
 * The build system a request path asks for, or null for a plain single-file compilation. Both the generic
 * /build/{build_system} route and the original CMake-only /cmake spelling are understood.
 */
export function buildSystemFromPath(path: string): string | null {
    const pathParts = path.replaceAll(TRIM_SLASHES_REGEX, '').split('/');

    const last = pathParts[pathParts.length - 1];
    if (last === CMAKE_BUILD_SYSTEM) return CMAKE_BUILD_SYSTEM;
    if (pathParts.length >= 2 && pathParts[pathParts.length - 2] === 'build') return last;
    return null;
}

export function parseRequestBody(body: string, contentType?: string): Record<string, any> {
    if (!body) return {};

    // Check if content type indicates JSON
    if (contentType?.toLowerCase().includes('application/json')) {
        try {
            return JSON.parse(body);
        } catch (error) {
            logger.warn('Failed to parse JSON body, treating as plain text');
            return {source: body};
        }
    } else {
        // Plain text body - treat as source code
        return {source: body};
    }
}

function textify(array: Array<{text: string}> | undefined, filterAnsi: boolean): string {
    const text = (array || []).map(line => line.text).join('\n');
    if (filterAnsi) {
        // Remove ANSI escape sequences
        return text.replaceAll(/(\x9B|\x1B\[)[\d:;<=>?]*[ -/]*[@-~]/g, '');
    }
    return text;
}

function isEmpty(value: any): boolean {
    return (
        value === null ||
        value === undefined ||
        (typeof value === 'string' && value.trim() === '') ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'object' && Object.keys(value).length === 0)
    );
}

export interface CompilationResult {
    guid?: string;
    s3Key?: string;
    asm?: Array<{text: string}>;
    code?: number;
    stdout?: Array<{text: string}>;
    stderr?: Array<{text: string}>;
    execResult?: {
        code: number;
        stdout?: Array<{text: string}>;
        stderr?: Array<{text: string}>;
    };
    [key: string]: any;
}

export interface ApiResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}

export function createErrorResponse(statusCode: number, message: string): ApiResponse {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
        },
        body: JSON.stringify({error: message}),
    };
}

export function createSuccessResponse(result: CompilationResult, filterAnsi: boolean, wantsJson: boolean): ApiResponse {
    // Clean up internal fields
    delete result.guid;
    delete result.s3Key;

    // Plain text unless the caller asked for JSON: the documented default, and what the
    // compilation endpoint answers when it is served directly rather than through here.
    if (!wantsJson) {
        let body = '';

        try {
            if (!isEmpty(TEXT_BANNER)) body += '# ' + TEXT_BANNER + '\n';
            body += textify(result.asm, filterAnsi);
            if (result.code !== 0) body += '\n# Compiler exited with result code ' + result.code;
            if (!isEmpty(result.stdout)) body += '\nStandard out:\n' + textify(result.stdout, filterAnsi);
            if (!isEmpty(result.stderr)) body += '\nStandard error:\n' + textify(result.stderr, filterAnsi);

            if (result.execResult) {
                body += '\n\n# Execution result with exit code ' + result.execResult.code + '\n';
                if (!isEmpty(result.execResult.stdout)) {
                    body += '# Standard out:\n' + textify(result.execResult.stdout, filterAnsi);
                }
                if (!isEmpty(result.execResult.stderr)) {
                    body += '\n# Standard error:\n' + textify(result.execResult.stderr, filterAnsi);
                }
            }
        } catch (ex) {
            body += `Error handling request: ${ex}`;
        }
        body += '\n';

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
            },
            body,
        };
    }
    // Default to JSON response
    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
        },
        body: JSON.stringify(result),
    };
}
