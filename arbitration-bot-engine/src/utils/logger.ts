type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

// Lower numbers are more verbose. shouldLog() compares priorities so a process
// started with LOG_LEVEL=WARN will suppress DEBUG and INFO messages.
const LEVEL_PRIORITY: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'INFO';

function timestamp(): string {
    // ISO timestamps are easy to sort and correlate with Django/exchange logs.
    return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
    // Unknown LOG_LEVEL values are not validated here; callers should keep env
    // values inside the LogLevel union to avoid priority lookup returning undefined.
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

/**
 * Minimal process logger.
 *
 * This avoids bringing in a structured logging dependency while still adding a
 * consistent tag convention. Tags are important in this service because multiple
 * bots can run in the same process and emit interleaved logs.
 */
export const logger = {
    debug(tag: string, message: string, ...args: any[]) {
        if (shouldLog('DEBUG')) {
            console.log(`${timestamp()} [DEBUG] [${tag}] ${message}`, ...args);
        }
    },

    info(tag: string, message: string, ...args: any[]) {
        if (shouldLog('INFO')) {
            console.log(`${timestamp()} [INFO]  [${tag}] ${message}`, ...args);
        }
    },

    warn(tag: string, message: string, ...args: any[]) {
        if (shouldLog('WARN')) {
            console.warn(`${timestamp()} [WARN]  [${tag}] ${message}`, ...args);
        }
    },

    error(tag: string, message: string, ...args: any[]) {
        if (shouldLog('ERROR')) {
            console.error(`${timestamp()} [ERROR] [${tag}] ${message}`, ...args);
        }
    },
};
