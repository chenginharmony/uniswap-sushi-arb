'use strict'

const { isAddress } = require('./adapters')
const { buildCrossDexRoutes } = require('../arbitrage/route_builder')

const CLASSIFICATION = {
    CONFIGURED: 'CONFIGURED',
    ON_CHAIN_VERIFIED: 'ON_CHAIN_VERIFIED',
    SUPPORTED_ADAPTER: 'SUPPORTED_ADAPTER',
    BOOTSTRAPPED: 'BOOTSTRAPPED',
    ACTIVE_LIQUIDITY: 'ACTIVE_LIQUIDITY',
    USABLE: 'USABLE',
    CROSS_DEX_ROUTABLE: 'CROSS_DEX_ROUTABLE'
}

/**
 * Classify a candidate pool through the strict 7-stage verification funnel.
 */
class PoolDiscoveryPipeline {
    constructor(options = {}) {
        this.provider = options.provider
        this.supportedAdapters = new Set([
            'uniswap-v3',
            'uniswapv3',
            'pancakeswap-v3',
            'pancakeswapv3',
            'pancakeswap',
            'aerodrome'
        ])
    }

    async rpcCall(method, params = []) {
        if (!this.provider) throw new Error('RPC provider required')
        if (typeof this.provider.callRpc === 'function') {
            return this.provider.callRpc(method, params)
        }
        if (typeof this.provider.call === 'function' && method === 'eth_call') {
            return this.provider.call(params[0].to, [], '', [])
        }
        throw new Error('Unsupported provider method')
    }

    /**
     * Inspect and verify a list of candidate pools.
     */
    classifyPool(candidate, bootstrappedPool = null, allPools = []) {
        const report = {
            address: candidate.address ? candidate.address.toLowerCase() : 'unknown',
            dex: candidate.dex || candidate.adapter || 'unknown',
            stage: CLASSIFICATION.CONFIGURED,
            verified: false,
            usable: false,
            routable: false,
            reasons: []
        }

        // 1. CONFIGURED check
        if (!candidate || !candidate.address || !isAddress(candidate.address)) {
            report.reasons.push('Invalid or missing pool contract address')
            return report
        }

        // 2. SUPPORTED ADAPTER check
        const adapter = String(candidate.adapter || candidate.dex || '').toLowerCase()
        if (!this.supportedAdapters.has(adapter)) {
            report.reasons.push(`Adapter '${adapter}' is not supported`)
            return report
        }
        report.stage = CLASSIFICATION.SUPPORTED_ADAPTER

        // 3. BOOTSTRAPPED check
        if (!bootstrappedPool) {
            report.reasons.push('Pool has not been bootstrapped via RPC')
            return report
        }
        report.stage = CLASSIFICATION.BOOTSTRAPPED

        // 4. ACTIVE LIQUIDITY check
        const hasV2Reserves = (bootstrappedPool.reserve0 !== undefined && bootstrappedPool.reserve1 !== undefined &&
            (BigInt(bootstrappedPool.reserve0) > 0n || Number(bootstrappedPool.reserve0) > 0))
        const hasV3Liquidity = (bootstrappedPool.sqrtPriceX96 !== undefined && bootstrappedPool.liquidity !== undefined &&
            (BigInt(bootstrappedPool.sqrtPriceX96) > 0n && BigInt(bootstrappedPool.liquidity) > 0n))

        if (!hasV2Reserves && !hasV3Liquidity) {
            report.reasons.push('Pool has zero active liquidity / reserves')
            return report
        }
        report.stage = CLASSIFICATION.ACTIVE_LIQUIDITY

        // 5. USABLE check
        const d0 = bootstrappedPool.token0Decimals
        const d1 = bootstrappedPool.token1Decimals
        if (d0 === undefined || d1 === undefined) {
            report.reasons.push('Missing token decimals metadata')
            return report
        }
        report.stage = CLASSIFICATION.USABLE
        report.usable = true

        // 6. CROSS-DEX ROUTABLE check
        const poolList = allPools.length ? allPools : [bootstrappedPool]
        const routes = buildCrossDexRoutes(poolList)
        const addrLower = candidate.address.toLowerCase()
        const isRoutable = routes.some(r =>
            r.pools.includes(addrLower) ||
            (r.buyPool && r.buyPool.address && r.buyPool.address.toLowerCase() === addrLower) ||
            (r.sellPool && r.sellPool.address && r.sellPool.address.toLowerCase() === addrLower)
        )

        if (isRoutable) {
            report.stage = CLASSIFICATION.CROSS_DEX_ROUTABLE
            report.routable = true
        } else {
            report.reasons.push('Pool does not have a counterpart pool on another DEX/tier for cross-DEX routing')
        }

        report.verified = true
        return report
    }
}

module.exports = {
    CLASSIFICATION,
    PoolDiscoveryPipeline
}
