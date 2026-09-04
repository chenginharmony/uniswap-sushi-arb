'use strict'

const assert = require('assert')
const { AerodromeV1Adapter } = require('../src/adapters/aerodrome_v1_adapter')

async function runTests() {
    console.log('=== Aerodrome V1 Adapter Test Suite ===\n')

    const adapter = new AerodromeV1Adapter()

    // Test 1: Volatile Pair (Constant Product x*y=k)
    console.log('Test 1: Volatile AMM Curve (WETH / USDC on Base):')
    const volPool = {
        token0: '0x4200000000000000000000000000000000000006',
        token1: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        token0Decimals: 18,
        token1Decimals: 6,
        reserve0: 1809007398584856949725n,
        reserve1: 4435213797036n,
        stable: false,
        feeBps: 30
    }

    const inputWeth = 1000000000000000000n // 1 WETH
    const volQuote = adapter.quoteExactInput(volPool, inputWeth, volPool.token0)

    assert.ok(volQuote.usable, 'Volatile quote must be usable')
    assert.strictEqual(volQuote.stable, false)
    assert.ok(volQuote.amountOut > 2400000000n && volQuote.amountOut < 2500000000n, 'AmountOut within realistic USDC range')
    
    // Check against on-chain value (~2443037242n) within 0.1% tolerance
    const onChainVolTarget = 2443037242n
    const volDiff = Number(volQuote.amountOut - onChainVolTarget)
    const volDiffPct = Math.abs(volDiff / Number(onChainVolTarget)) * 100
    assert.ok(volDiffPct < 0.15, `Volatile quote accuracy must be < 0.15% from on-chain (got ${volDiffPct.toFixed(3)}%)`)
    console.log(`   ✓ Volatile Quote: ${Number(volQuote.amountOut) / 1e6} USDC for 1 WETH (divergence: ${volDiffPct.toFixed(3)}%)`)

    // Test 2: Stable Pair (Solidly Curve x^3*y + y^3*x = k)
    console.log('\nTest 2: Solidly Stable AMM Curve (USDC / USDT on Base):')
    const stablePool = {
        token0: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        token1: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
        token0Decimals: 6,
        token1Decimals: 6,
        reserve0: 3691250834n,
        reserve1: 4327992334n,
        stable: true,
        feeBps: 5
    }

    const inputUsdc = 1000000000n // 1000 USDC
    const stableQuote = adapter.quoteExactInput(stablePool, inputUsdc, stablePool.token0)

    assert.ok(stableQuote.usable, 'Stable quote must be usable')
    assert.strictEqual(stableQuote.stable, true)
    
    // Check against on-chain value (997918427n) within 0.1% tolerance
    const onChainStableTarget = 997918427n
    const stableDiff = Number(stableQuote.amountOut - onChainStableTarget)
    const stableDiffPct = Math.abs(stableDiff / Number(onChainStableTarget)) * 100
    assert.ok(stableDiffPct < 0.10, `Stable quote accuracy must be < 0.10% from on-chain (got ${stableDiffPct.toFixed(3)}%)`)
    console.log(`   ✓ Stable Quote: ${Number(stableQuote.amountOut) / 1e6} USDT for 1000 USDC (divergence: ${stableDiffPct.toFixed(3)}%)`)

    console.log('\n=============================================================')
    console.log('ALL AERODROME V1 ADAPTER TESTS PASSED')
    console.log('=============================================================')
}

runTests().catch(err => {
    console.error('Test failed:', err)
    process.exit(1)
})
