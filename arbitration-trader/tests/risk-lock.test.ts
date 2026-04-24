import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeRiskLock } from '../src/classes/risk-lock.js';

test('RuntimeRiskLock tracks, updates and clears incidents', () => {
    const lock = new RuntimeRiskLock();

    assert.equal(lock.isLocked, false);
    lock.lock('cleanup:BTC', 'cleanup_failed', 'first error');
    lock.lock('cleanup:BTC', 'cleanup_failed', 'second error');

    const locked = lock.getStatus();
    assert.equal(locked.isLocked, true);
    assert.equal(locked.incidents.length, 1);
    assert.equal(locked.incidents[0].count, 2);
    assert.equal(locked.incidents[0].details, 'second error');

    lock.clear('cleanup:BTC');
    assert.equal(lock.getStatus().isLocked, false);
});
