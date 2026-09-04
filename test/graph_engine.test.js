'use strict'

const assert = require('assert')
const { GraphRouteEngine } = require('../src/arbitrage/graph_engine')

async function runTests() {
    console.log('=== Directed Graph Route Engine Test Suite ===\n')

    const engine = new GraphRouteEngine({ maxHops: 3 })

    const WETH = '0x4200000000000000000000000000000000000006'
    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631'

    // Mock multi-DEX pool graph
    const mockPools = [
        // Pool 1: WETH / USDC on Uniswap V3
        { address: '0xUniWethUsdc', dex: 'uniswap', token0: WETH, token1: USDC, feeBps: 5, sqrtPriceX96: 139018157092897333265461n, liquidity: 57273758055n },
        // Pool 2: WETH / USDC on PancakeSwap V3
        { address: '0xCakeWethUsdc', dex: 'pancakeswap', token0: WETH, token1: USDC, feeBps: 5, sqrtPriceX96: 139018157092897333265461n, liquidity: 57273758055n },
        // Pool 3: USDC / AERO on Aerodrome V1 (Volatile)
        { address: '0xAeroUsdcAero', dex: 'aerodrome-v1', token0: USDC, token1: AERO, stable: false, feeBps: 30, reserve0: 100000000000n, reserve1: 200000000000000000000000n },
        // Pool 4: AERO / WETH on Uniswap V3
        { address: '0xUniAeroWeth', dex: 'uniswap', token0: AERO, token1: WETH, feeBps: 30, sqrtPriceX96: 139018157092897333265461n, liquidity: 57273758055n }
    ]

    engine.buildGraph(mockPools)

    // Test 1: Discover 2-leg direct cross-DEX routes
    console.log('Test 1: Discover 2-Leg Direct Cross-DEX Cycles:')
    const twoLegCycles = engine.findArbitrageCycles(WETH, 2)
    assert.ok(twoLegCycles.length >= 2, 'Must discover at least 2 direct 2-leg cycles')
    assert.strictEqual(twoLegCycles[0].hops, 2)
    console.log(`   ✓ Discovered ${twoLegCycles.length} direct 2-leg cycles between WETH and USDC`)

    // Test 2: Discover 3-leg triangular routes (WETH -> USDC -> AERO -> WETH)
    console.log('\nTest 2: Discover 3-Leg Triangular Cycles:')
    const threeLegCycles = engine.findArbitrageCycles(WETH, 3).filter(c => c.hops === 3)
    assert.ok(threeLegCycles.length >= 1, 'Must discover triangular 3-leg cycle')
    const tri = threeLegCycles[0]
    assert.strictEqual(tri.hops, 3)
    assert.strictEqual(tri.startingToken, WETH)
    assert.strictEqual(tri.legs[0].toToken, USDC)
    assert.strictEqual(tri.legs[1].toToken, AERO)
    assert.strictEqual(tri.legs[2].toToken, WETH)
    console.log(`   ✓ Triangular Cycle Discovered: ${tri.id}`)

    // Test 3: Indexing by pool for sub-millisecond Flashblock dispatch
    console.log('\nTest 3: Flashblock Event Pool Indexing:')
    const indexed = engine.indexAllCycles([WETH, USDC, AERO], 3)
    assert.ok(indexed.totalCycles >= 3, 'Must index all discovered multi-leg cycles')
    const affected = engine.getAffectedCycles('0xUniWethUsdc')
    assert.ok(affected.length >= 2, 'Affected pool must trigger mapped 2-leg and 3-leg cycles')
    console.log(`   ✓ Pool 0xUniWethUsdc is mapped to ${affected.length} multi-leg routes`)

    console.log('\n=============================================================')
    console.log('ALL DIRECTED GRAPH ROUTE ENGINE TESTS PASSED')
    console.log('=============================================================')
}

runTests().catch(err => {
    console.error('Test failed:', err)
    process.exit(1)
})
