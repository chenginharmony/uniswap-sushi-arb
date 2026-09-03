'use strict'

const { evaluateTrade } = require('./profitability')

function currentPool(leg, state) {
    if (!state || !leg) return leg
    const address = leg.address || leg.poolAddress
    return address && state.pools.get(address) ? Object.assign({}, leg, state.pools.get(address)) : leg
}

function opportunityFromRoute(route, amountIn, config, state) {
    const buyPool = currentPool(route.buyPool, state)
    const sellPool = currentPool(route.sellPool, state)
    const result = evaluateTrade({
        amountIn,
        buyPool,
        sellPool,
        tokenUsdPrice: route.tokenUsdPrice,
        flashloanFeeBps: route.flashloanFeeBps || 0,
        gasCostUsd: route.gasCostUsd || 0,
        slippageBps: route.slippageBps || 0,
        safetyMarginUsd: config.safetyMarginUsd,
        minimumNetProfitUsd: config.minNetProfitUsd,
        minimumProfitMarginBps: config.minProfitMarginBps,
        maxSlippageBps: config.maxSlippageBps
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
