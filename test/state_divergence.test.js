'use strict'

const assert = require('assert')
const { PoolStateManager } = require('../src/arbitrage/state')
const { Scanner } = require('../src/scanner')
const { Metrics } = require('../src/monitoring/metrics')
const { opportunityFromRoute, isFresh } = require('../src/arbitrage/engine')

async function main() {
    console.log('--- Testing Opportunity Detection Under State Divergence ---')

    const state = new PoolStateManager()
    const metrics = new Metrics()

    // 1. Setup two cross-DEX pools for WETH/cbBTC:
    // Pool Uni: Uniswap 30bp (fee: 30)
    // Pool Cake: PancakeSwap 1bp (fee: 1)
    // Initially in equilibrium: tick = -265050, sqrtPrice = 139218683526177890633719n
    const initialSqrtPrice = 139218683526177890633719n
    const deepLiquidity = 100000000000000000n

    const uniPool = {
        address: '0xuniwethbtc',
        dex: 'uniswap',
        adapter: 'uniswap-v3',
        quoteModel: 'concentrated-liquidity',
        token0: '0xweth',
        token1: '0xcbbtc',
        token0Symbol: 'WETH',
        token1Symbol: 'cbBTC',
        token0Decimals: 18,
        token1Decimals: 8,
        feeBps: 30,
        sqrtPriceX96: initialSqrtPrice,
        tick: -265050,
        liquidity: deepLiquidity
    }

    const cakePool = {
        address: '0xcakewethbtc',
        dex: 'pancakeswap',
        adapter: 'pancakeswap-v3',
        quoteModel: 'concentrated-liquidity',
        token0: '0xweth',
        token1: '0xcbbtc',
        token0Symbol: 'WETH',
        token1Symbol: 'cbBTC',
        token0Decimals: 18,
        token1Decimals: 8,
        feeBps: 1,
        sqrtPriceX96: initialSqrtPrice,
        tick: -265050,
        liquidity: deepLiquidity
    }

    state.upsertPool(uniPool)
    state.upsertPool(cakePool)

    // Register bidirectional routes
    const routeUniToCake = {
        id: 'route-uni-to-cake',
        buyDex: 'uniswap',
        sellDex: 'pancakeswap',
        buyPool: uniPool,
        sellPool: cakePool,
        pools: [uniPool.address, cakePool.address],
        tokenIn: '0xweth',
        tokenOut: '0xcbbtc',
        tokenInSymbol: 'WETH',
        tokenOutSymbol: 'cbBTC',
        tokenUsdPrice: 2500,
        flashloanFeeBps: 0,
        gasCostUsd: 0.05
    }

    const routeCakeToUni = {
        id: 'route-cake-to-uni',
        buyDex: 'pancakeswap',
        sellDex: 'uniswap',
        buyPool: cakePool,
        sellPool: uniPool,
        pools: [cakePool.address, uniPool.address],
        tokenIn: '0xweth',
        tokenOut: '0xcbbtc',
        tokenInSymbol: 'WETH',
        tokenOutSymbol: 'cbBTC',
        tokenUsdPrice: 2500,
        flashloanFeeBps: 0,
        gasCostUsd: 0.05
    }

    state.registerRoute(routeUniToCake)
    state.registerRoute(routeCakeToUni)

    const scanner = new Scanner({
        state,
        metrics,
        config: {
            arbitrageSizesUsd: [1000],
            minNetProfitUsd: 0.20,
            minProfitMarginBps: 0,
            executionBufferUsd: 0,
            safetyMarginUsd: 0
        },
        decodeAffectedPools: (event) => event.affected || []
    })

    // Phase 1: Equilibrium evaluation
    const oppsEquilibrium = await scanner.process({
        transactionHash: '0xeq1',
        context: 'fb-0',
        phase: 'preconfirmation',
        affected: [uniPool.address]
    })

    assert.ok(oppsEquilibrium.length > 0)
    for (const opp of oppsEquilibrium) {
        assert.strictEqual(opp.profitable, false, 'In equilibrium, fees must prevent profit')
        assert.ok(opp.rejectionReason === 'NEGATIVE_GROSS_PROFIT' || opp.rejectionReason === 'DEX_FEES_EXCEED_EDGE' || opp.rejectionReason === 'BELOW_MIN_NET_PROFIT')
    }
    console.log('✓ Phase 1: Equilibrium correctly rejected trades due to fees')

    // Phase 2: Price Dislocation!
    // A huge buy order hits PancakeSwap, driving cbBTC price higher on PancakeSwap (+80 basis points)
    // sqrtPrice increases by 0.4% (80 bps in price): sqrtPrice * 1.004
    const dislocatedSqrtPrice = (initialSqrtPrice * 1004n) / 1000n
    state.upsertPool(Object.assign({}, cakePool, {
        sqrtPriceX96: dislocatedSqrtPrice,
        tick: -264250
    }))

    const oppsDislocated = await scanner.process({
        transactionHash: '0xwhale_buy',
        context: 'fb-1',
        phase: 'preconfirmation',
        affected: [cakePool.address]
    })

    const profitableOpp = oppsDislocated.find(o => o.profitable === true)
    assert.ok(profitableOpp, 'Scanner must detect profitable opportunity when price diverges beyond fee threshold')
    assert.strictEqual(profitableOpp.status, 'PROFITABLE')
    assert.ok(profitableOpp.expectedNetProfitUsd > 0.20, `Net profit must exceed threshold ($0.20), got: $${profitableOpp.expectedNetProfitUsd}`)
    console.log(`✓ Phase 2: Dislocation detected! Route: ${profitableOpp.route}, Net Profit: $${profitableOpp.expectedNetProfitUsd.toFixed(2)}, Margin: ${profitableOpp.profitMarginBps.toFixed(1)} bps`)

    // Phase 3: Invalidation & Staleness
    // State updates before submission
    const capturedVersion = profitableOpp.stateVersion
    assert.strictEqual(isFresh(profitableOpp, capturedVersion, 500), true, 'Opportunity is fresh at current version')

    // Another block or swap updates the pool state version
    state.upsertPool(Object.assign({}, cakePool, { tick: -264300 }))
    assert.notStrictEqual(state.version, capturedVersion)
    assert.strictEqual(isFresh(profitableOpp, state.version, 500), false, 'Opportunity must be marked STALE when pool state version changes')
    console.log('✓ Phase 3: Staleness check successfully invalidated opportunity on state change')

    console.log('--- All Opportunity Lifecycle Tests Passed Successfully ---')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
