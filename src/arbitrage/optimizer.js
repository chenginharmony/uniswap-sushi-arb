'use strict'

const { opportunityFromRoute } = require('./engine')

function optimizeRoute(route, sizes, config) {
    return sizes.map(size => opportunityFromRoute(route, size / route.tokenUsdPrice, config))
        .filter(opportunity => opportunity.expectedNetProfitUsd >= config.minNetProfitUsd)
        .filter(opportunity => opportunity.slippageBps <= config.maxSlippageBps)
        .sort((left, right) => right.expectedNetProfitUsd - left.expectedNetProfitUsd)[0] || null
}

module.exports = { optimizeRoute }
