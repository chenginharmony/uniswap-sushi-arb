'use strict'

const { evaluateTrade } = require('./profitability')

function sameToken(left, right) {
    return left !== undefined && right !== undefined &&
        String(left).toLowerCase() === String(right).toLowerCase()
}

function directionalReserves(leg, pool, route, side) {
    const tokenIn = leg.tokenIn || (side === 'buy' ? route.tokenIn : route.tokenOut)
    const tokenOut = leg.tokenOut || (side === 'buy' ? route.tokenOut : route.tokenIn)

    if (sameToken(tokenIn, pool.token0) && sameToken(tokenOut, pool.token1)) {
        return { reserveIn: pool.reserve0, reserveOut: pool.reserve1, zeroForOne: true, tokenIn, tokenOut }
    }
    if (sameToken(tokenIn, pool.token1) && sameToken(tokenOut, pool.token0)) {
        return { reserveIn: pool.reserve1, reserveOut: pool.reserve0, zeroForOne: false, tokenIn, tokenOut }
    }

    if (pool.reserveIn !== undefined && pool.reserveOut !== undefined) {
        return { reserveIn: pool.reserveIn, reserveOut: pool.reserveOut, zeroForOne: side === 'buy', tokenIn, tokenOut }
    }
    return { zeroForOne: side === 'buy', tokenIn, tokenOut }
}

function currentPool(leg, state, route, side) {
    if (!state || !leg || !state.pools) return leg
    const address = leg.address || leg.poolAddress
    const pool = address && (state.pools.get(address) || state.pools.get(String(address).toLowerCase()))
    if (!pool) return leg

    const current = Object.assign({}, leg, pool)
    const reserves = directionalReserves(leg, pool, route, side)
    if (reserves) Object.assign(current, reserves)
    return current
}

function opportunityFromRoute(route, amountIn, config, state) {
    const runtimeConfig = config || {}
    const buyPool = currentPool(route.buyPool, state, route, 'buy')
    const sellPool = currentPool(route.sellPool, state, route, 'sell')

    const stateVersion = state ? state.version : (route.stateVersion || 0)
    const result = evaluateTrade({
        amountIn,
        buyPool,
        sellPool,
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        tokenUsdPrice: route.tokenUsdPrice,
        flashloanFeeBps: route.flashloanFeeBps || 0,
        gasCostUsd: route.gasCostUsd || 0,
        slippageBps: route.slippageBps || 0,
        executionBufferUsd: runtimeConfig.executionBufferUsd !== undefined ? runtimeConfig.executionBufferUsd : route.executionBufferUsd,
        safetyMarginUsd: runtimeConfig.safetyMarginUsd || 0,
        minimumNetProfitUsd: runtimeConfig.minNetProfitUsd || 0,
        minimumProfitMarginBps: runtimeConfig.minProfitMarginBps || 0,
        maxSlippageBps: runtimeConfig.maxSlippageBps === undefined ? Infinity : runtimeConfig.maxSlippageBps
    })

    const oppId = `opp-${route.id}-${amountIn}-${stateVersion}`
    const buyDex = route.buyDex || (buyPool && (buyPool.dex || buyPool.adapter)) || 'dexA'
    const sellDex = route.sellDex || (sellPool && (sellPool.dex || sellPool.adapter)) || 'dexB'

    return Object.assign(result, {
        opportunityId: oppId,
        id: oppId,
        route: route.id,
        routeId: route.id,
        buyDex,
        sellDex,
        buyPool,
        sellPool,
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        tokenInSymbol: route.tokenInSymbol || 'IN',
        tokenOutSymbol: route.tokenOutSymbol || 'OUT',
        tokenInDecimals: route.tokenInDecimals !== undefined ? route.tokenInDecimals : 18,
        tokenOutDecimals: route.tokenOutDecimals !== undefined ? route.tokenOutDecimals : 18,
        tokenUsdPrice: route.tokenUsdPrice,
        inputSize: amountIn,
        expectedIntermediateOutput: result.firstOutput,
        expectedFinalOutput: result.expectedAmountOut,
        grossProfit: result.grossProfitUsd,
        dexFees: result.dexFeesUsd,
        flashloanFee: result.flashloanFeeUsd,
        gasCost: result.gasCostUsd,
        executionBuffer: result.executionBufferUsd,
        safetyMargin: result.safetyMarginUsd,
        netProfit: result.expectedNetProfitUsd,
        profitMargin: result.profitMarginBps,
        createdAt: Date.now(),
        stateVersion,
        status: result.profitable ? 'PROFITABLE' : 'REJECTED',
        rejectionReason: result.rejectionReason,
        sourceFlashblock: route.sourceFlashblock || null
    })
}

function isFresh(opportunity, currentStateVersion, maxAgeMs = 150, now = Date.now()) {
    return Boolean(
        opportunity &&
        opportunity.stateVersion === currentStateVersion &&
        (now - opportunity.createdAt) <= maxAgeMs
    )
}

module.exports = { opportunityFromRoute, isFresh, currentPool, directionalReserves }
