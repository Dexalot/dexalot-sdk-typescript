/**
 * Structured logging helpers (console + optional AsyncLocalStorage request IDs).
 */

// Use AsyncLocalStorage for request ID tracking if available (Node.js 12.17+)
let asyncLocalStorage: any = null;
try {
    // Dynamic import to avoid breaking in browsers
    const asyncHooks = require('async_hooks');
    asyncLocalStorage = new asyncHooks.AsyncLocalStorage();
} catch {
    // AsyncLocalStorage not available (browser or older Node)
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

let currentLogLevel: LogLevel = 'info';
let logFormat: 'console' | 'json' = 'console';

/**
 * Logger interface.
 */
export interface Logger {
    debug(message: string, context?: Record<string, any>): void;
    info(message: string, context?: Record<string, any>): void;
    warn(message: string, context?: Record<string, any>): void;
    error(message: string, context?: Record<string, any>): void;
}

/**
 * Configure global logging settings.
 * 
 * @param level - Minimum log level to output
 * @param format - Output format ('console' for human-readable, 'json' for structured)
 */
export function configureLogging(level?: LogLevel, format?: 'console' | 'json'): void {
    if (level) {
        currentLogLevel = level;
    }
    if (format) {
        logFormat = format;
    }
}

/**
 * Get the current log level.
 */
export function getLogLevel(): LogLevel {
    return currentLogLevel;
}

/**
 * Get the current log format.
 */
export function getLogFormat(): 'console' | 'json' {
    return logFormat;
}

/**
 * Set request ID for the current async context.
 */
export function setRequestId(requestId: string | null): void {
    if (asyncLocalStorage) {
        asyncLocalStorage.enterWith({ requestId });
    }
}

/**
 * Get the current request ID from async context.
 */
export function getRequestId(): string | null {
    if (asyncLocalStorage) {
        const store = asyncLocalStorage.getStore();
        return store?.requestId ?? null;
    }
    return null;
}

/**
 * Run a function with a specific request ID.
 */
export function withRequestId<T>(requestId: string, fn: () => T): T {
    if (asyncLocalStorage) {
        return asyncLocalStorage.run({ requestId }, fn);
    }
    return fn();
}

/**
 * Format a log message.
 */
function formatMessage(
    level: LogLevel,
    name: string,
    message: string,
    context?: Record<string, any>
): string {
    const timestamp = new Date().toISOString();
    const requestId = getRequestId();

    if (logFormat === 'json') {
        const logObject: Record<string, any> = {
            timestamp,
            level,
            logger: name,
            message,
        };
        if (requestId) {
            logObject.requestId = requestId;
        }
        if (context && Object.keys(context).length > 0) {
            logObject.context = context;
        }
        return JSON.stringify(logObject);
    }

    // Console format
    const parts = [timestamp, level.toUpperCase().padEnd(5), `[${name}]`, message];
    if (requestId) {
        parts.splice(3, 0, `(${requestId})`);
    }
    if (context && Object.keys(context).length > 0) {
        parts.push(JSON.stringify(context));
    }
    return parts.join(' ');
}

/**
 * Check if a log level should be output.
 */
function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel];
}

/**
 * Create a logger for a specific component.
 * 
 * @param name - Name of the component (e.g., 'dexalot_sdk.clob')
 * @returns Logger instance
 */
export function getLogger(name: string): Logger {
    return {
        debug(message: string, context?: Record<string, any>): void {
            if (shouldLog('debug')) {
                console.debug(formatMessage('debug', name, message, context));
            }
        },
        info(message: string, context?: Record<string, any>): void {
            if (shouldLog('info')) {
                console.info(formatMessage('info', name, message, context));
            }
        },
        warn(message: string, context?: Record<string, any>): void {
            if (shouldLog('warn')) {
                console.warn(formatMessage('warn', name, message, context));
            }
        },
        error(message: string, context?: Record<string, any>): void {
            if (shouldLog('error')) {
                console.error(formatMessage('error', name, message, context));
            }
        },
    };
}

/**
 * Track an operation with timing (start, success with duration, or failure).
 *
 * @param logger - Logger to use
 * @param operation - Operation name
 * @param fn - Async function to execute
 * @param context - Additional context to log
 * @returns Result of the function
 */
export async function trackOperation<T>(
    logger: Logger,
    operation: string,
    fn: () => Promise<T>,
    context?: Record<string, any>
): Promise<T> {
    const startTime = Date.now();
    logger.debug(`${operation} started`, context);

    try {
        const result = await fn();
        const duration = Date.now() - startTime;
        logger.debug(`${operation} completed`, { ...context, durationMs: duration });
        return result;
    } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`${operation} failed`, {
            ...context,
            durationMs: duration,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}

/**
 * Method decorator that logs entry, duration, and errors with a component tag.
 *
 * Note: TypeScript decorators are experimental. Use this with
 * `experimentalDecorators: true` in tsconfig.json.
 * 
 * @param component - Component name for logging
 * @returns Method decorator
 * 
 * @example
 * class MyClass {
 *     @trackMethod('clob')
 *     async getOrderBook(pair: string) { ... }
 * }
 */
export function trackMethod(component: string) {
    return function (
        _target: any,
        propertyKey: string,
        descriptor: PropertyDescriptor
    ): PropertyDescriptor {
        const originalMethod = descriptor.value;
        const logger = getLogger(`dexalot_sdk.${component}`);

        descriptor.value = async function (...args: any[]) {
            const operation = propertyKey;
            const startTime = Date.now();
            
            logger.debug(`${operation} started`);

            try {
                const result = await originalMethod.apply(this, args);
                const duration = Date.now() - startTime;
                logger.debug(`${operation} completed`, { durationMs: duration });
                return result;
            } catch (error) {
                const duration = Date.now() - startTime;
                logger.error(`${operation} failed`, {
                    durationMs: duration,
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        };

        return descriptor;
    };
}

/**
 * Log an event (for simpler logging without timing).
 */
export function logEvent(
    logger: Logger,
    level: LogLevel,
    event: string,
    context?: Record<string, any>
): void {
    logger[level](event, context);
}
