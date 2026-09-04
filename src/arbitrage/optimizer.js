'use strict'

const { opportunityFromRoute } = require('./engine')

const DEFAULT_SIZE_LADDER_USD = [10, 25, 50, 75, 100, 150, 250, 400, 600, 850, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000]

/**
 * Evaluate trade size ladder and continuous golden-section search to find the size that maximizes net profit.
 *
 * @param {Object} route - The cross-DEX candidate route
 * @param {Object} [config] - Runtime config (minNetProfitUsd, safetyMargin, etc.)
 * @param {Object} [state] - PoolStateManager
 * @param {number[]} [customLadderUsd] - Optional custom size ladder in USD
 * @returns {Object} Optimal opportunity with sizing diagnostics
 */
function optimizeRouteSize(route, config = {}, state = null, customLadderUsd = null) {
    const tokenUsdPrice = Number(route.tokenUsdPrice) || 2600
    const maxCap = config.maxSizeUsd !== undefined ? config.maxSizeUsd : 20000
    const rawLadder = customLadderUsd || (config.arbitrageSizesUsd && config.arbitrageSizesUsd.length ? config.arbitrageSizesUsd : DEFAULT_SIZE_LADDER_USD)
    const ladder = rawLadder.filter(s => s <= maxCap)
    const minNetProfitUsd = config.minNetProfitUsd !== undefined ? config.minNetProfitUsd : 0.01
    const gasCostUsd = config.gasCostUsd !== undefined ? config.gasCostUsd : 0.04

    let bestOpportunity = null
    let peakNetProfitUsd = -Infinity
    const curve = []

    for (const sizeUsd of ladder) {
        const sizeTokens = sizeUsd / tokenUsdPrice
        const opp = opportunityFromRoute(route, sizeTokens, config, state)
        const netProfit = opp.expectedNetProfitUsd !== undefined ? opp.expectedNetProfitUsd : (opp.netProfitUsd || 0)

        curve.push({
            sizeUsd,
            sizeTokens,
            netProfitUsd: netProfit,
            grossProfitUsd: opp.grossProfitUsd || 0,
            profitable: opp.profitable,
            rejectionReason: opp.rejectionReason
        })

        if (netProfit > peakNetProfitUsd) {
            peakNetProfitUsd = netProfit
            bestOpportunity = opp
        }
    }

    // Dynamic Golden-Section Search Refinement:
    // If the best point shows potential (positive gross profit or edge exceeding gas),
    // refine continuously to find the exact optimal flash loan size.
    if (bestOpportunity && (bestOpportunity.profitable || (bestOpportunity.grossProfitUsd && bestOpportunity.grossProfitUsd > gasCostUsd))) {
        const bestSizeUsd = bestOpportunity.inputSize * tokenUsdPrice
        let bestIdx = 0
        let minDiff = Infinity
        for (let i = 0; i < ladder.length; i++) {
            const diff = Math.abs(ladder[i] - bestSizeUsd)
            if (diff < minDiff) {
                minDiff = diff
                bestIdx = i
            }
        }

        let low = bestIdx > 0 ? ladder[bestIdx - 1] : Math.max(5, bestSizeUsd * 0.4)
        let high = bestIdx < ladder.length - 1 ? ladder[bestIdx + 1] : Math.min(maxCap, bestSizeUsd * 1.5)

        // Golden-Section Search: 5 iterations shrinks search interval to ~2.1%
        const phi = 0.618033988749895
        let a = low
        let b = high
        let c = b - phi * (b - a)
        let d = a + phi * (b - a)

        let oppC = opportunityFromRoute(route, c / tokenUsdPrice, config, state)
        let oppD = opportunityFromRoute(route, d / tokenUsdPrice, config, state)
        let pC = oppC.expectedNetProfitUsd !== undefined ? oppC.expectedNetProfitUsd : (oppC.netProfitUsd || 0)
        let pD = oppD.expectedNetProfitUsd !== undefined ? oppD.expectedNetProfitUsd : (oppD.netProfitUsd || 0)

        for (let iter = 0; iter < 5; iter++) {
            if (pC > peakNetProfitUsd) {
                peakNetProfitUsd = pC
                bestOpportunity = oppC
            }
            if (pD > peakNetProfitUsd) {
                peakNetProfitUsd = pD
                bestOpportunity = oppD
            }

            if (pC > pD) {
                b = d
                d = c
                pD = pC
                oppD = oppC
                c = b - phi * (b - a)
                oppC = opportunityFromRoute(route, c / tokenUsdPrice, config, state)
                pC = oppC.expectedNetProfitUsd !== undefined ? oppC.expectedNetProfitUsd : (oppC.netProfitUsd || 0)
            } else {
                a = c
                c = d
                pC = pD
                oppC = oppD
                d = a + phi * (b - a)
                oppD = opportunityFromRoute(route, d / tokenUsdPrice, config, state)
                pD = oppD.expectedNetProfitUsd !== undefined ? oppD.expectedNetProfitUsd : (oppD.netProfitUsd || 0)
            }
        }
    }

    if (!bestOpportunity) {
        const fallbackTokens = 100 / tokenUsdPrice
        bestOpportunity = opportunityFromRoute(route, fallbackTokens, config, state)
    }

    // Ensure final profitability status reflects the peak net profit after continuous optimization
    if (peakNetProfitUsd >= minNetProfitUsd && (bestOpportunity.grossProfitUsd || 0) > 0) {
        bestOpportunity.profitable = true
        bestOpportunity.status = 'PROFITABLE'
        bestOpportunity.rejectionReason = null
    }

    const optimalSizeTokens = bestOpportunity.inputSize
    const optimalSizeUsd = optimalSizeTokens * tokenUsdPrice

    return Object.assign(bestOpportunity, {
        optimalSizeUsd,
        optimalSizeTokens,
        peakNetProfitUsd,
        sizeCurve: curve
    })
}

// Backwards-compatible alias for existing tests
function optimizeRoute(route, sizes, config) {
    return optimizeRouteSize(route, config, null, sizes)
}

module.exports = {
    optimizeRouteSize,
    optimizeRoute,
    DEFAULT_SIZE_LADDER_USD
}
