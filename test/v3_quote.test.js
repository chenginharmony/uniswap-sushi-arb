'use strict'

const assert = require('assert')
const { quoteV3ExactInput, sqrtPriceToPrice } = require('../src/arbitrage/v3_math')
const { buildCrossDexRoutes, validatePoolCoverage } = require('../src/arbitrage/route_builder')
const { calculateProfitability, evaluateTrade } = require('../src/arbitrage/profitability')
const { opportunityFromRoute, isFresh } = require('../src/arbitrage/engine')

async function main() {
    // 1. V3 Exact Input Quoting Math
    const sqrtPriceX96 = 139018157092897333265461n
    const liquidity = 57273758055n

    // 1a. token0 -> token1 (zeroForOne = true)
    const quote0to1 = quoteV3ExactInput(100000000000000000n, sqrtPriceX96, liquidity, 1, true)
    assert.strictEqual(quote0to1.sufficient, true)
    assert.ok(quote0to1.amountOut > 0n)
    assert.ok(quote0to1.sqrtPriceNextX96 < sqrtPriceX96, 'Price must decrease when buying token1 with token0')

    // 1b. token1 -> token0 (zeroForOne = false)
    const quote1to0 = quoteV3ExactInput(300000n, sqrtPriceX96, liquidity, 1, false)
    assert.strictEqual(quote1to0.sufficient, true)
    assert.ok(quote1to0.amountOut > 0n)
    assert.ok(quote1to0.sqrtPriceNextX96 > sqrtPriceX96, 'Price must increase when buying token0 with token1')

    // 1c. Zero or insufficient liquidity
    const illiquidQuote = quoteV3ExactInput(1000n, sqrtPriceX96, 0n, 1, true)
    assert.strictEqual(illiquidQuote.sufficient, false)
    assert.strictEqual(illiquidQuote.reason, 'INSUFFICIENT_LIQUIDITY')

    // 1d. Zero input amount
    const zeroQuote = quoteV3ExactInput(0n, sqrtPriceX96, liquidity, 1, true)
    assert.strictEqual(zeroQuote.sufficient, false)
    assert.strictEqual(zeroQuote.reason, 'ZERO_INPUT')

    // 2. Pool Coverage Validation (>= 5 usable pools required)
    const fourPools = [
        { address: '0x1', token0: '0xa', token1: '0xb', reserve0: 100, reserve1: 100 },
        { address: '0x2', token0: '0xa', token1: '0xb', reserve0: 100, reserve1: 100 },
        { address: '0x3', token0: '0xa', token1: '0xb', reserve0: 100, reserve1: 100 },
        { address: '0x4', token0: '0xa', token1: '0xb', reserve0: 100, reserve1: 100 }
    ]
    const coverage4 = validatePoolCoverage(fourPools, [{ buyPool: '0x1', sellPool: '0x2' }], 5)
    assert.strictEqual(coverage4.valid, false)
    assert.strictEqual(coverage4.status, 'INSUFFICIENT_POOL_COVERAGE')
    assert.strictEqual(coverage4.counts.usable, 4)

    const sixPools = [
        ...fourPools,
        { address: '0x5', token0: '0xa', token1: '0xb', reserve0: 100, reserve1: 100 },
        { address: '0x6', token0: '0xa', token1: '0xb', reserve0: 100, reserve1: 100 }
    ]
    const coverage6 = validatePoolCoverage(sixPools, [
        { buyPool: '0x1', sellPool: '0x2' },
        { buyPool: '0x3', sellPool: '0x4' }
    ], 5)
    assert.strictEqual(coverage6.valid, true)
    assert.strictEqual(coverage6.status, 'SUFFICIENT_COVERAGE')
    assert.strictEqual(coverage6.counts.usable, 6)

    // 3. Bidirectional Route Construction
    const testPools = [
        { address: '0xpoolUni', dex: 'uniswap', token0: '0xWETH', token1: '0xcbBTC', feeTier: 100, token0Symbol: 'WETH', token1Symbol: 'cbBTC' },
        { address: '0xpoolCake', dex: 'pancakeswap', token0: '0xWETH', token1: '0xcbBTC', feeTier: 100, token0Symbol: 'WETH', token1Symbol: 'cbBTC' }
    ]
    const routes = buildCrossDexRoutes(testPools)
    assert.strictEqual(routes.length, 4, 'Must construct all 4 directional legs across 2 DEX pools')
    const routeUniToCakeWeth = routes.find(r => r.buyDex === 'uniswap' && r.sellDex === 'pancakeswap' && r.tokenInSymbol === 'WETH')
    const routeCakeToUniWeth = routes.find(r => r.buyDex === 'pancakeswap' && r.sellDex === 'uniswap' && r.tokenInSymbol === 'WETH')
    const routeUniToCakeBtc = routes.find(r => r.buyDex === 'uniswap' && r.sellDex === 'pancakeswap' && r.tokenInSymbol === 'cbBTC')
    const routeCakeToUniBtc = routes.find(r => r.buyDex === 'pancakeswap' && r.sellDex === 'uniswap' && r.tokenInSymbol === 'cbBTC')

    assert.ok(routeUniToCakeWeth, 'Uni -> Cake (WETH) must exist')
    assert.ok(routeCakeToUniWeth, 'Cake -> Uni (WETH) must exist')
    assert.ok(routeUniToCakeBtc, 'Uni -> Cake (cbBTC) must exist')
    assert.ok(routeCakeToUniBtc, 'Cake -> Uni (cbBTC) must exist')

    // 4. Explicit Rejection Reasons
    // 4a. Missing price
    const noPriceTrade = evaluateTrade({ amountIn: 10, buyPool: fourPools[0], sellPool: fourPools[1], tokenUsdPrice: 0 })
    assert.strictEqual(noPriceTrade.profitable, false)
    assert.strictEqual(noPriceTrade.rejectionReason, 'MISSING_PRICE')

    // 4b. Below minimum net profit
    const lowProfit = calculateProfitability({
        grossProfitUsd: 1.00,
        flashloanFeeUsd: 0.10,
        gasCostUsd: 0.10,
        minimumNetProfitUsd: 2.00
    })
    assert.strictEqual(lowProfit.profitable, false)
    assert.strictEqual(lowProfit.rejectionReason, 'BELOW_MIN_NET_PROFIT')

    // 4c. Negative gross profit
    const negProfit = calculateProfitability({
        grossProfitUsd: -0.50,
        flashloanFeeUsd: 0.10,
        gasCostUsd: 0.10,
        minimumNetProfitUsd: 0.10
    })
    assert.strictEqual(negProfit.profitable, false)
    assert.strictEqual(negProfit.rejectionReason, 'NEGATIVE_GROSS_PROFIT')

    // 4d. Slippage too high
    const highSlippage = calculateProfitability({
        grossProfitUsd: 5.00,
        slippageBps: 200,
        maxSlippageBps: 100,
        minimumNetProfitUsd: 0.10
    })
    assert.strictEqual(highSlippage.profitable, false)
    assert.strictEqual(highSlippage.rejectionReason, 'SLIPPAGE_TOO_HIGH')

    // 5. Deterministic Opportunity Identification & Freshness
    const opp = opportunityFromRoute(routeUniToCakeWeth, 1, {}, { version: 42, pools: new Map() })
    assert.ok(opp.opportunityId.startsWith('opp-'), 'Must have deterministic opportunityId')
    assert.strictEqual(opp.stateVersion, 42)
    assert.strictEqual(isFresh(opp, 42, 1000), true)
    assert.strictEqual(isFresh(opp, 43, 1000), false, 'Must be stale when state version differs')

    // 6. Multi-Tick V3 Quoting Tests
    const { getSqrtRatioAtTick, quoteV3MultiTick } = require('../src/arbitrage/v3_math')

    // 6a. Exact getSqrtRatioAtTick check
    assert.strictEqual(getSqrtRatioAtTick(0), 2n ** 96n, 'tick 0 must equal exactly 2^96')
    assert.ok(getSqrtRatioAtTick(100) > getSqrtRatioAtTick(0), 'tick 100 sqrtRatio > tick 0')
    assert.ok(getSqrtRatioAtTick(-100) < getSqrtRatioAtTick(0), 'tick -100 sqrtRatio < tick 0')

    // 6b. Multi-tick: 0 ticks crossed (small trade staying in tick)
    const tickP0 = getSqrtRatioAtTick(0)
    const resNoCross = quoteV3MultiTick({
        amountIn: 1000n,
        sqrtPriceX96: tickP0,
        currentTick: 0,
        liquidity: 10000000n,
        feeBps: 30,
        zeroForOne: true,
        initializedTicks: [
            { tick: -10, liquidityNet: 1000000n }
        ]
    })
    assert.strictEqual(resNoCross.sufficient, true)
    assert.strictEqual(resNoCross.ticksCrossed, 0)
    assert.ok(resNoCross.amountOut > 0n)

    // 6c. Multi-tick: 1 tick crossed (zeroForOne = true, moving down)
    // Next tick is at -10 with liquidityNet: +5000000n (adds liquidity after crossing)
    const res1Cross = quoteV3MultiTick({
        amountIn: 100000000n, // Large enough to cross tick -10
        sqrtPriceX96: tickP0,
        currentTick: 0,
        liquidity: 5000000n,
        feeBps: 30,
        zeroForOne: true,
        initializedTicks: [
            { tick: -10, liquidityNet: -2000000n }
        ]
    })
    assert.strictEqual(res1Cross.sufficient, true)
    assert.strictEqual(res1Cross.ticksCrossed, 1, 'Must cross exactly 1 tick')
    assert.ok(res1Cross.amountOut > 0n)

    // 6d. Multi-tick: multiple ticks crossed (zeroForOne = false, moving up)
    const resMultiCross = quoteV3MultiTick({
        amountIn: 500000000n,
        sqrtPriceX96: tickP0,
        currentTick: 0,
        liquidity: 5000000n,
        feeBps: 30,
        zeroForOne: false,
        initializedTicks: [
            { tick: 10, liquidityNet: 2000000n },
            { tick: 20, liquidityNet: 3000000n },
            { tick: 30, liquidityNet: 4000000n }
        ]
    })
    assert.strictEqual(resMultiCross.sufficient, true)
    assert.ok(resMultiCross.ticksCrossed >= 2, 'Must cross multiple ticks')
    assert.ok(resMultiCross.amountOut > 0n)

    // 6e. Insufficient liquidity when liquidity drops to 0
    const resDrain = quoteV3MultiTick({
        amountIn: 1000000000n,
        sqrtPriceX96: tickP0,
        currentTick: 0,
        liquidity: 1000000n,
        feeBps: 30,
        zeroForOne: true,
        initializedTicks: [
            { tick: -5, liquidityNet: 1000000n } // when zeroForOne, L = L - liqNet = 1M - 1M = 0
        ]
    })
    assert.strictEqual(resDrain.sufficient, false)
    assert.strictEqual(resDrain.reason, 'INSUFFICIENT_LIQUIDITY')

    console.log('v3-quote-tests-ok')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
