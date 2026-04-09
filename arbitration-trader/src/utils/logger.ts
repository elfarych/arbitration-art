type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'INFO';

function timestamp(): string {
    return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

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
