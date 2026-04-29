export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelOrder: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const configuredLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';

function shouldLog(level: LogLevel): boolean {
    return levelOrder[level] >= (levelOrder[configuredLevel] ?? levelOrder.info);
}

function write(level: LogLevel, tag: string, message: string, details?: unknown): void {
    if (!shouldLog(level)) {
        return;
    }

    const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${tag}]`;
    if (details === undefined) {
        console[level === 'debug' ? 'log' : level](`${prefix} ${message}`);
        return;
    }

    console[level === 'debug' ? 'log' : level](`${prefix} ${message}`, details);
}

export const logger = {
    debug: (tag: string, message: string, details?: unknown) => write('debug', tag, message, details),
    info: (tag: string, message: string, details?: unknown) => write('info', tag, message, details),
    warn: (tag: string, message: string, details?: unknown) => write('warn', tag, message, details),
    error: (tag: string, message: string, details?: unknown) => write('error', tag, message, details),
};
