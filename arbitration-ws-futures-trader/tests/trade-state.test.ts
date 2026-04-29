import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SERVICE_SHARED_TOKEN ||= 'test-token';

test('symbol state machine prevents duplicate open and close transitions', async () => {
    const { SymbolStateMachine, TradeCounter } = await import('../src/execution/trade-state.js');

    const state = new SymbolStateMachine();
    assert.equal(state.status(), 'idle');
    assert.equal(state.tryStartOpen(), true);
    assert.equal(state.tryStartOpen(), false);
    state.markOpen();
    assert.equal(state.tryStartClose(), true);
    assert.equal(state.tryStartClose(), false);
    state.markClosePendingPersistence();
    assert.equal(state.status(), 'close_pending_persistence');

    const counter = new TradeCounter(1);
    assert.equal(counter.tryReserve(), true);
    assert.equal(counter.tryReserve(), false);
    counter.release();
    assert.equal(counter.tryReserve(), true);
});
