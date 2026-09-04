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

const fs = require('fs')
const path = require('path')

function parsePoolConfigs(env) {
    if (env.BASE_POOL_CONFIG_JSON) {
        try {
            const parsed = JSON.parse(env.BASE_POOL_CONFIG_JSON)
            return Array.isArray(parsed) ? parsed : (parsed.pools || [])
        } catch (error) {
            throw new Error(`Invalid BASE_POOL_CONFIG_JSON: ${error.message}`)
        }
    }

    const universePath = path.resolve(__dirname, '../data/base_pool_universe.json')
    if (fs.existsSync(universePath)) {
        try {
            return JSON.parse(fs.readFileSync(universePath, 'utf8'))
        } catch (e) {}
    }

    const raw = env.BASE_REGISTRY_JSON
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw)
        const list = Array.isArray(parsed) ? parsed : (parsed.pools || [])
        return list.map(item => {
            const copy = Object.assign({}, item)
            if (!copy.adapter && copy.dex) {
                const dexLower = String(copy.dex).toLowerCase()
                if (dexLower === 'uniswap' && copy.type === 'v3') copy.adapter = 'uniswap-v3'
                else if (dexLower === 'pancakeswap') copy.adapter = 'pancakeswap-v3'
                else copy.adapter = dexLower
            }
            return copy
        })
    } catch (error) {
        throw new Error(`Invalid pool configuration JSON: ${error.message}`)
    }
}

function loadConfig(env = process.env) {
    return {
        localDeployment: boolean(env.LOCAL_DEPLOYMENT, false),
        dryRun: boolean(env.DRY_RUN, true),
        executionEnabled: boolean(env.EXECUTION_ENABLED, false),
        tradingMode: env.TRADING_MODE || 'dry-run',
        minPools: number(env.MIN_POOLS, 5),
        minNetProfitUsd: number(env.MIN_PROFIT_USD || env.MIN_NET_PROFIT_USD, 0.01),
        minProfitMarginBps: number(env.MIN_ALERT_SPREAD_BPS || env.MIN_PROFIT_MARGIN_BPS, 0),
        maxSlippageBps: number(env.MAX_SLIPPAGE_BPS, Infinity),
        executionBufferUsd: number(env.EXECUTION_BUFFER_USD, number(env.SLIPPAGE_COST_USD, 0)),
        safetyMarginUsd: number(env.SAFETY_MARGIN_USD, 0),
        arbitrageSizesUsd: list(env.ARBITRAGE_SIZES_USD, ['100', '250', '500', '1000', '2500']).map(item => number(item, 0)).filter(item => item > 0),
        maxOpportunityAgeMs: number(env.MAX_OPPORTUNITY_AGE_MS, 300),
        maxSizeUsd: number(env.MAX_SIZE_USD, 20000),
        base: {
            rpcUrl: env.BASE_RPC_URL || 'https://base-rpc.publicnode.com',
            rpcUrls: list(env.BASE_RPC_URLS, [
                env.BASE_RPC_URL,
                'https://base-rpc.publicnode.com',
                'https://1rpc.io/base',
                'https://mainnet.base.org'
            ].filter(Boolean)),
            wsUrl: env.BASE_WSS_URL || env.BASE_WS_URL || '',
            requireBootstrap: boolean(env.BASE_REQUIRE_BOOTSTRAP, true),
            poolConfigs: parsePoolConfigs(env),
            reconnectDelay: number(env.BASE_WS_RECONNECT_DELAY, 1),
            maxReconnectDelay: number(env.BASE_WS_MAX_RECONNECT_DELAY, 30)
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
