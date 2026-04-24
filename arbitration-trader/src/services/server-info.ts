import os from 'node:os';
import type { ServerInfoSnapshot } from '../types/index.js';

export function getServerInfoSnapshot(runtimeConfigId?: number): ServerInfoSnapshot {
    const addresses = Object.values(os.networkInterfaces())
        .flatMap(items => items ?? [])
        .filter(item => item.family === 'IPv4' && !item.internal)
        .map(item => item.address)
        .filter((address, index, items) => items.indexOf(address) === index);

    return {
        requested_runtime_config_id: runtimeConfigId ?? null,
        hostname: os.hostname(),
        server_ip: addresses[0] ?? null,
        ip_addresses: addresses,
    };
}
