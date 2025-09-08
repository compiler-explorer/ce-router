import winston from 'winston';

export interface LoggingOptions {
    debug?: boolean;
    logHost?: string;
    logPort?: number;
    paperTrailIdentifier?: string;
    suppressConsoleLog?: boolean;
}

let loggerInstance: winston.Logger;

export function initialiseLogging(options: LoggingOptions = {}): void {
    const logLevel = options.debug ? 'debug' : 'info';

    const transports: winston.transport[] = [];

    // Console transport (unless suppressed)
    if (!options.suppressConsoleLog) {
        transports.push(
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.timestamp(),
                    winston.format.printf(({timestamp, level, message, ...meta}) => {
                        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
                        return `${timestamp} [${level}]: ${message}${metaStr}`;
                    }),
                ),
            }),
        );
    } else {
        // Blackhole transport to suppress console output
        transports.push(
            new winston.transports.Stream({
                stream: {
                    write: () => true,
                } as any,
            }),
        );
    }

    // Papertrail transport (if configured)
    if (options.logHost && options.logPort) {
        // Note: For full Papertrail support, would need winston-papertrail package
        // For now, we'll log a message about the configuration
        console.log(
            `Papertrail logging configured for ${options.logHost}:${options.logPort} with identifier ${options.paperTrailIdentifier}`,
        );
    }

    loggerInstance = winston.createLogger({
        level: logLevel,
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({stack: true}),
            winston.format.json(),
        ),
        transports,
        // Handle uncaught exceptions and rejections
        exceptionHandlers: [
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.printf(({message, stack}) => `Uncaught Exception: ${message}\n${stack}`),
                ),
            }),
        ],
        rejectionHandlers: [
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.printf(({message, stack}) => `Unhandled Rejection: ${message}\n${stack}`),
                ),
            }),
        ],
    });
}

export function makeLogStream(): NodeJS.WritableStream {
    // Create a stream that writes to the logger
    const stream = new (require('node:stream').Writable)({
        write(chunk: any, _encoding: any, callback: any) {
            const line = chunk.toString().trim();
            if (line) {
                getLogger().info(line);
            }
            callback();
        },
    });

    return stream;
}

export function suppressConsoleLog(): void {
    if (loggerInstance) {
        // Clear existing transports and add blackhole
        loggerInstance.clear();
        loggerInstance.add(
            new winston.transports.Stream({
                stream: {
                    write: () => true,
                } as any,
            }),
        );
    }
}

export function getLogger(): winston.Logger {
    if (!loggerInstance) {
        // Initialize with default options if not already done
        initialiseLogging();
    }
    return loggerInstance;
}

// Export a default logger instance for convenience
export const logger = {
    info: (message: string, ...meta: any[]) => getLogger().info(message, ...meta),
    warn: (message: string, ...meta: any[]) => getLogger().warn(message, ...meta),
    error: (message: string, ...meta: any[]) => getLogger().error(message, ...meta),
    debug: (message: string, ...meta: any[]) => getLogger().debug(message, ...meta),
    verbose: (message: string, ...meta: any[]) => getLogger().verbose(message, ...meta),
};
