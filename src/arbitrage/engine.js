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
        return { reserveIn: pool.reserve0, reserveOut: pool.reserve1 }
    }
    if (sameToken(tokenIn, pool.token1) && sameToken(tokenOut, pool.token0)) {
        return { reserveIn: pool.reserve1, reserveOut: pool.reserve0 }
    }

    if (pool.reserveIn !== undefined && pool.reserveOut !== undefined) {
        return { reserveIn: pool.reserveIn, reserveOut: pool.reserveOut }
    }
    return null
}

function currentPool(leg, state, route, side) {
    if (!state || !leg || !state.pools) return leg
    const address = leg.address || leg.poolAddress
    const pool = address && state.pools.get(address)
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
    const result = evaluateTrade({
        amountIn,
        buyPool,
        sellPool,
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
    return Object.assign(result, {
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        route: route.id,
        createdAt: Date.now(),
        stateVersion: state ? state.version : route.stateVersion,
        sourceFlashblock: route.sourceFlashblock || null
    })
}

function isFresh(opportunity, currentStateVersion, maxAgeMs, now = Date.now()) {
    return opportunity && opportunity.stateVersion === currentStateVersion && now - opportunity.createdAt <= maxAgeMs
}

module.exports = { opportunityFromRoute, isFresh }
