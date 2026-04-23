import os from 'node:os';
import type { SystemLoadSnapshot } from '../types/index.js';

const CPU_SAMPLE_MS = 250;

interface CpuSnapshot {
    idle: number;
    total: number;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function snapshotCpu(): CpuSnapshot {
    return os.cpus().reduce<CpuSnapshot>((acc, cpu) => {
        const times = cpu.times;
        const total = times.user + times.nice + times.sys + times.idle + times.irq;
        return {
            idle: acc.idle + times.idle,
            total: acc.total + total,
        };
    }, { idle: 0, total: 0 });
}

function round(value: number, digits: number = 2): number {
    return Number(value.toFixed(digits));
}

export async function getSystemLoadSnapshot(): Promise<SystemLoadSnapshot> {
    const start = snapshotCpu();
    await sleep(CPU_SAMPLE_MS);
    const end = snapshotCpu();

    const idleDelta = end.idle - start.idle;
    const totalDelta = end.total - start.total;
    const cpuPercent = totalDelta > 0 ? (1 - (idleDelta / totalDelta)) * 100 : 0;

    const memoryTotal = os.totalmem();
    const memoryFree = os.freemem();
    const memoryUsed = memoryTotal - memoryFree;
    const memoryUsedPercent = memoryTotal > 0 ? (memoryUsed / memoryTotal) * 100 : 0;

    return {
        cpu_percent: round(cpuPercent),
        memory_total_bytes: memoryTotal,
        memory_used_bytes: memoryUsed,
        memory_free_bytes: memoryFree,
        memory_used_percent: round(memoryUsedPercent),
    };
}
