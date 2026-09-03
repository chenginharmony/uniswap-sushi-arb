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

    const liveState = new PoolStateManager()
    liveState.upsertPool({ address: 'buy-pool', token0: 'A', token1: 'B', reserve0: 1000, reserve1: 1100, feeBps: 30 })
    liveState.upsertPool({ address: 'sell-pool', token0: 'B', token1: 'A', reserve0: 1000, reserve1: 1300, feeBps: 30 })
    liveState.registerRoute({
        id: 'live-route',
        pools: ['buy-pool'],
        buyPool: { address: 'buy-pool' },
        sellPool: { address: 'sell-pool' },
        tokenIn: 'A',
        tokenOut: 'B',
        tokenUsdPrice: 1
    })

    const liveScanner = new Scanner({
        state: liveState,
        config: {
            arbitrageSizesUsd: [100],
            minNetProfitUsd: 0,
            minProfitMarginBps: 0,
            maxSlippageBps: Infinity,
            executionBufferUsd: 0,
            safetyMarginUsd: 0
        },
        decodeAffectedPools: () => [{ address: 'buy-pool', reserve0: 1000, reserve1: 1110 }]
    })
    const opportunities = await liveScanner.process({
        transactionHash: '0xlive',
        context: 'fb-live',
        phase: 'preconfirmation'
    })
    assert.strictEqual(opportunities.length, 1)
    assert.strictEqual(opportunities[0].sourceFlashblock, 'fb-live')
    assert.strictEqual(opportunities[0].stateVersion, liveState.version)
    assert.strictEqual(liveScanner.metrics.counters.routesRescanned, 1)

    let canonicalStarted = 0
    let canonicalStopped = 0
    let canonicalHandler
    const canonicalFeed = {
        start(handler) {
            canonicalStarted += 1
            canonicalHandler = handler
        },
        stop() { canonicalStopped += 1 }
    }
    const canonicalState = new PoolStateManager()
    canonicalState.upsertPool({ address: 'canonical-pool', token0: 'A', token1: 'B', reserve0: 1, reserve1: 1 })
    canonicalState.registerRoute({ id: 'canonical-route', pools: ['canonical-pool'] })
    let reconciliations = 0
    let canonicalEvaluations = 0
    const canonicalScanner = new Scanner({
        state: canonicalState,
        config: {
            flashblocks: { enabled: false },
            base: { wsUrl: 'wss://canonical-base.example' }
        },
        canonicalFeed,
        poolBootstrapper: {
            async bootstrap() { return [] },
            affectedPools() { return [] },
            async reconcile(context) {
                reconciliations += 1
                assert.strictEqual(context, 100)
                return ['canonical-pool']
            }
        },
        evaluateRoute: async () => {
            canonicalEvaluations += 1
            return { profitable: false, stateVersion: canonicalState.version }
        }
    })
    await canonicalScanner.start()
    assert.strictEqual(canonicalStarted, 1)
    await canonicalHandler({ number: 100, hash: '0xblock' })
    assert.strictEqual(reconciliations, 1)
    assert.strictEqual(canonicalEvaluations, 1)
    canonicalScanner.stop()
    assert.strictEqual(canonicalStopped, 1)

    console.log('scanner-tests-ok')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
