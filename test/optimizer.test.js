'use strict'

const assert = require('assert')
const { optimizeRouteSize, optimizeRoute, DEFAULT_SIZE_LADDER_USD } = require('../src/arbitrage/optimizer')

async function main() {
    console.log('--- Testing Trade Size Optimizer ---')

    // Construct mock pools with a price dislocation
    const initialSqrtPrice = 139218683526177890633719n
    // Dislocated price on pool B by +60 bps
    const dislocatedSqrtPrice = (initialSqrtPrice * 1003n) / 1000n

    const buyPool = {
        address: '0xbuy',
        dex: 'uniswap',
        quoteModel: 'concentrated-liquidity',
        token0: '0xweth',
        token1: '0xcbbtc',
        token0Symbol: 'WETH',
        token1Symbol: 'cbBTC',
        token0Decimals: 18,
        token1Decimals: 8,
        feeBps: 5,
        sqrtPriceX96: initialSqrtPrice,
        tick: -265050,
        liquidity: 1000000000000000n // Moderate liquidity so price impact is noticeable at high size
    }

    const sellPool = {
        address: '0xsell',
        dex: 'pancakeswap',
        quoteModel: 'concentrated-liquidity',
        token0: '0xweth',
        token1: '0xcbbtc',
        token0Symbol: 'WETH',
        token1Symbol: 'cbBTC',
        token0Decimals: 18,
        token1Decimals: 8,
        feeBps: 5,
        sqrtPriceX96: dislocatedSqrtPrice,
        tick: -264850,
        liquidity: 1000000000000000n
    }

    const route = {
        id: 'opt-route',
        buyDex: 'uniswap',
        sellDex: 'pancakeswap',
        buyPool,
        sellPool,
        pools: ['0xbuy', '0xsell'],
        tokenIn: '0xweth',
        tokenOut: '0xcbbtc',
        tokenInSymbol: 'WETH',
        tokenOutSymbol: 'cbBTC',
        tokenUsdPrice: 2500,
        flashloanFeeBps: 5,
        gasCostUsd: 0.05
    }

    const result = optimizeRouteSize(route, {
        minNetProfitUsd: 0.10,
        minProfitMarginBps: 0
    })

    assert.ok(result, 'Optimizer must return an opportunity result')
    assert.ok(result.sizeCurve && result.sizeCurve.length > 0, 'Size curve must be populated')
    assert.ok(result.optimalSizeUsd > 0, 'Optimal size must be positive')
    assert.ok(result.optimalSizeTokens > 0, 'Optimal token size must be positive')

    console.log(`✓ Optimizer found peak at $${result.optimalSizeUsd.toFixed(2)} (${result.optimalSizeTokens.toFixed(4)} WETH)`)
    console.log(`✓ Peak Net Profit: $${result.peakNetProfitUsd.toFixed(2)}, Status: ${result.status}`)

    // Verify curve has sizing steps
    const sampleSizes = result.sizeCurve.map(c => c.sizeUsd)
    assert.ok(sampleSizes.includes(100), 'Curve includes $100')
    assert.ok(sampleSizes.includes(1000), 'Curve includes $1000')

    // Test 2: Verify dynamic continuous sizing on deep liquidity pools with a profitable dislocation
    console.log('\n--- Testing Dynamic Flash Loan Sizing on Liquid Dislocation ---')
    const deepBuyPool = {
        address: '0xdeepbuy',
        dex: 'uniswap',
        quoteModel: 'concentrated-liquidity',
        token0: '0xweth',
        token1: '0xusdc',
        token0Symbol: 'WETH',
        token1Symbol: 'USDC',
        token0Decimals: 18,
        token1Decimals: 6,
        feeBps: 5,
        sqrtPriceX96: 1540000000000000000000000000000n,
        liquidity: 500000000000000000n // $1M+ TVL
    }
    const deepSellPool = {
        address: '0xdeepsell',
        dex: 'pancakeswap',
        quoteModel: 'concentrated-liquidity',
        token0: '0xweth',
        token1: '0xusdc',
        token0Symbol: 'WETH',
        token1Symbol: 'USDC',
        token0Decimals: 18,
        token1Decimals: 6,
        feeBps: 5,
        sqrtPriceX96: 1547000000000000000000000000000n, // +45 bps dislocation
        liquidity: 500000000000000000n
    }
    const deepRoute = {
        id: 'deep-weth-usdc',
        buyDex: 'uniswap',
        sellDex: 'pancakeswap',
        buyPool: deepBuyPool,
        sellPool: deepSellPool,
        pools: ['0xdeepbuy', '0xdeepsell'],
        tokenIn: '0xweth',
        tokenOut: '0xusdc',
        tokenInSymbol: 'WETH',
        tokenOutSymbol: 'USDC',
        tokenUsdPrice: 2600,
        flashloanFeeBps: 5,
        gasCostUsd: 0.04
    }

    const deepResult = optimizeRouteSize(deepRoute, {
        minNetProfitUsd: 0.10,
        minProfitMarginBps: 0,
        gasCostUsd: 0.04
    })

    assert.ok(deepResult.optimalSizeUsd > 0, 'Must have dynamic optimal size')
    console.log(`✓ Liquid dislocation dynamic sizing: $${deepResult.optimalSizeUsd.toFixed(2)} -> Peak Net: +$${deepResult.peakNetProfitUsd.toFixed(2)} USD (Status: ${deepResult.status})`)
    assert.ok(deepResult.profitable, 'Liquid dislocation must be profitable')
    assert.strictEqual(deepResult.status, 'PROFITABLE')

    console.log('--- Trade Size Optimizer Tests Passed Successfully ---')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
