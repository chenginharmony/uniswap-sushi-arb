'use strict'

function boolean(value, fallback) {
    if (value === undefined) return fallback
    return ['1', 'true', 'yes', 'on'].indexOf(String(value).toLowerCase()) !== -1
}

function number(value, fallback) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

function list(value, fallback) {
    if (!value) return fallback
    return String(value).split(',').map(item => item.trim()).filter(Boolean)
}

function json(value, fallback) {
    if (!value) return fallback
    try {
        const parsed = JSON.parse(value)
        if (!Array.isArray(parsed)) throw new Error('expected an array')
        return parsed
    } catch (error) {
        throw new Error(`Invalid BASE_POOL_CONFIG_JSON: ${error.message}`)
    }
}

function loadConfig(env) {
    return {
        localDeployment: boolean(env.LOCAL_DEPLOYMENT, false),
        dryRun: boolean(env.DRY_RUN, true),
        minNetProfitUsd: number(env.MIN_NET_PROFIT_USD, 0.20),
        minProfitMarginBps: number(env.MIN_PROFIT_MARGIN_BPS, 0),
        maxSlippageBps: number(env.MAX_SLIPPAGE_BPS, Infinity),
        executionBufferUsd: number(env.EXECUTION_BUFFER_USD, number(env.SLIPPAGE_COST_USD, 0)),
        safetyMarginUsd: number(env.SAFETY_MARGIN_USD, 0),
        arbitrageSizesUsd: list(env.ARBITRAGE_SIZES_USD, ['100', '250', '500', '1000', '2500']).map(item => number(item, 0)).filter(item => item > 0),
        maxOpportunityAgeMs: number(env.MAX_OPPORTUNITY_AGE_MS, 150),
        base: {
            rpcUrl: env.BASE_RPC_URL || '',
            wsUrl: env.BASE_WS_URL || '',
            requireBootstrap: boolean(env.BASE_REQUIRE_BOOTSTRAP, true),
            poolConfigs: json(env.BASE_POOL_CONFIG_JSON, [])
        },
        flashblocks: {
            enabled: boolean(env.FLASHBLOCKS_ENABLED, true),
            wsUrl: env.FLASHBLOCKS_WS_URL || '',
            httpUrl: env.FLASHBLOCKS_HTTP_URL || '',
            reconnectDelay: number(env.FLASHBLOCKS_RECONNECT_DELAY, 1),
            maxReconnectDelay: number(env.FLASHBLOCKS_MAX_RECONNECT_DELAY, 30),
            queueSize: Math.max(1, Math.floor(number(env.FLASHBLOCKS_QUEUE_SIZE, 1000)))
        }
    }
}

module.exports = { loadConfig }
