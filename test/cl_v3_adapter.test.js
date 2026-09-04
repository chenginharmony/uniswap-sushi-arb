'use strict'

const assert = require('assert')
const { ConcentratedLiquidityV3Adapter } = require('../src/adapters/cl_v3_adapter')

async function runTests() {
    console.log('=== Concentrated Liquidity V3 Adapter Test Suite ===\n')

    const adapter = new ConcentratedLiquidityV3Adapter()

    // Test 1: Uniswap V3 concentrated liquidity quote
    console.log('Test 1: Uniswap V3 WETH/USDC 5bps pool:')
    const uniPool = {
        token0: '0x4200000000000000000000000000000000000006',
        token1: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        token0Decimals: 18,
        token1Decimals: 6,
        sqrtPriceX96: 139018157092897333265461n,
        liquidity: 57273758055n,
        feeBps: 1
    }

    const inputWeth = 100000000000000000n // 0.1 WETH
    const uniQuote = adapter.quoteExactInput(uniPool, inputWeth, uniPool.token0)

    assert.ok(uniQuote.usable, 'Quote must be usable')
    assert.ok(uniQuote.amountOut > 0n, 'AmountOut > 0')
    console.log(`   ✓ Uni V3 Quote: ${uniQuote.amountOut} base units`)

    // Test 2: SushiSwap V3 compatibility
    console.log('\nTest 2: SushiSwap V3 adapter compatibility:')
    const sushiAdapter = new ConcentratedLiquidityV3Adapter('sushiswap-v3')
    assert.strictEqual(sushiAdapter.dexName, 'sushiswap-v3')
    const sushiQuote = sushiAdapter.quoteExactInput(uniPool, inputWeth, uniPool.token0)
    assert.strictEqual(sushiQuote.amountOut, uniQuote.amountOut, 'Identical math across V3 forks')
    console.log(`   ✓ Sushi V3 parity verified: identical quote output`)

    console.log('\n=============================================================')
    console.log('ALL CONCENTRATED LIQUIDITY ADAPTER TESTS PASSED')
    console.log('=============================================================')
}

runTests().catch(err => {
    console.error('Test failed:', err)
    process.exit(1)
})
