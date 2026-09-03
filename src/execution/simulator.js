'use strict'

async function simulate(candidate, provider, config) {
    if (!candidate || !provider || typeof provider.call !== 'function') return { success: false, reason: 'simulation provider unavailable' }
    if (Date.now() - candidate.createdAt > config.maxOpportunityAgeMs) return { success: false, reason: 'opportunity expired' }
    try {
        const result = await provider.call(candidate)
        if (!result || result.success !== true) return { success: false, reason: 'simulation failed', result }
        if (Number(result.netProfitUsd) < config.minNetProfitUsd) return { success: false, reason: 'simulated net profit below threshold', result }
        return { success: true, result }
    } catch (error) {
        return { success: false, reason: error.message }
    }
}

module.exports = { simulate }
