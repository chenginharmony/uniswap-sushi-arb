'use strict'

const { evaluateTrade } = require('./profitability')

function opportunityFromRoute(route, amountIn, config) {
    const result = evaluateTrade({
        amountIn,
        buyPool: route.buyPool,
        sellPool: route.sellPool,
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
        stateVersion: route.stateVersion,
        sourceFlashblock: route.sourceFlashblock || null
    })
}

function isFresh(opportunity, currentStateVersion, maxAgeMs, now = Date.now()) {
    return opportunity && opportunity.stateVersion === currentStateVersion && now - opportunity.createdAt <= maxAgeMs
}

module.exports = { opportunityFromRoute, isFresh }
