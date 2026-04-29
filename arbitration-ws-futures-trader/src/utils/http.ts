export class HttpError extends Error {
    constructor(
        message: string,
        public readonly status: number | null,
        public readonly body: string,
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

export async function requestJson<T>(
    url: string,
    init: RequestInit = {},
    expectedStatuses: number[] = [200],
): Promise<T> {
    const response = await fetch(url, init);
    const text = await response.text();

    if (!expectedStatuses.includes(response.status)) {
        throw new HttpError(`HTTP ${response.status} for ${url}`, response.status, text);
    }

    if (!text) {
        return undefined as T;
    }

    return JSON.parse(text) as T;
}

export function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') {
            continue;
        }
        search.set(key, String(value));
    }
    return search.toString();
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
