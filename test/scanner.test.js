'use strict'

const assert = require('assert')
const { Scanner } = require('../src/scanner')
const { PoolStateManager } = require('../src/arbitrage/state')
const { Metrics } = require('../src/monitoring/metrics')

async function main() {
    const state = new PoolStateManager()
    state.upsertPool({ address: 'pool-a', token0: '0xa', token1: '0xb', reserve0: 10, reserve1: 20 })
    state.registerRoute({ id: 'route-a', pools: ['pool-a'] })
    let evaluations = 0
    const scanner = new Scanner({
        state,
        metrics: new Metrics(),
        maxEvaluationConcurrency: 1,
        decodeAffectedPools: () => [{ address: 'pool-a', reserve0: 11, reserve1: 21 }],
        evaluateRoute: async (route, event, currentState) => {
            evaluations += 1
            if (event.phase === 'preconfirmation') currentState.updateReserves('pool-a', 12, 22)
            return { profitable: true, stateVersion: currentState.version - 1 }
        }
    })

    await scanner.process({ transactionHash: '0xtx', context: 'fb-1', phase: 'preconfirmation', receivedMonotonicNs: process.hrtime.bigint() })
    assert.strictEqual(evaluations, 1)
    assert.strictEqual(scanner.metrics.counters.staleOpportunities, 1)
    assert.strictEqual(state.pools.get('pool-a').reserve0, 12)

    await scanner.process({ transactionHash: '0xtx', context: 'fb-1', phase: 'preconfirmation' })
    assert.strictEqual(scanner.metrics.counters.duplicateTransactions, 1)
    assert.strictEqual(evaluations, 1)

    await scanner.process({ transactionHash: '0xtx', context: 'block-1', phase: 'canonical' })
    assert.strictEqual(evaluations, 2)
    assert.strictEqual(scanner.metrics.counters.transactionsReceived, 2)
    assert.ok(scanner.metrics.latencies.flashblockReceiveToDecode.length >= 2)
    console.log('scanner-tests-ok')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
