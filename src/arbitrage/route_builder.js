'use strict'

function sameToken(a, b) {
    if (!a || !b) return false
    return String(a).toLowerCase() === String(b).toLowerCase()
}

/**
 * Validate market pool coverage against a minimum threshold (default: 5).
 * Distinguishes between configured, bootstrapped, usable, and cross-dex participating pools.
 */
function validatePoolCoverage(pools, routes = [], minPools = 5) {
    const configured = pools ? pools.length : 0
    let bootstrapped = 0
    let usable = 0

    const crossDexPoolAddresses = new Set()
    for (const route of routes || []) {
        if (route.buyPool && route.buyPool.address) crossDexPoolAddresses.add(route.buyPool.address.toLowerCase())
        else if (typeof route.buyPool === 'string') crossDexPoolAddresses.add(route.buyPool.toLowerCase())

        if (route.sellPool && route.sellPool.address) crossDexPoolAddresses.add(route.sellPool.address.toLowerCase())
        else if (typeof route.sellPool === 'string') crossDexPoolAddresses.add(route.sellPool.toLowerCase())
    }

    for (const pool of pools || []) {
        if (!pool || !pool.address) continue
        bootstrapped++

        // A pool is usable if it has active liquidity or reserves
        const hasV2Reserves = (pool.reserve0 !== undefined && pool.reserve1 !== undefined &&
            (BigInt(pool.reserve0) > 0n || Number(pool.reserve0) > 0))
        const hasV3Liquidity = (pool.sqrtPriceX96 !== undefined && pool.liquidity !== undefined &&
            (BigInt(pool.sqrtPriceX96) > 0n && BigInt(pool.liquidity) > 0n))

        if (hasV2Reserves || hasV3Liquidity) {
            usable++
        }
    }

    const crossDex = crossDexPoolAddresses.size
    const valid = usable >= minPools && crossDex >= 2

    return {
        valid,
        status: valid ? 'SUFFICIENT_COVERAGE' : 'INSUFFICIENT_POOL_COVERAGE',
        counts: {
            configured,
            bootstrapped,
            usable,
            crossDex,
            minRequired: minPools
        },
        reason: valid ? null : `Market coverage insufficient: ${usable} usable pools of ${minPools} required (configured: ${configured}, cross-dex: ${crossDex})`
    }
}

const KNOWN_SYMBOL_PRICES = {
    'WETH': 2600,
    'ETH': 2600,
    'USDC': 1.0,
    'USDT': 1.0,
    'DAI': 1.0,
    'USD': 1.0,
    'EURC': 1.08,
    'CBBTC': 84500,
    'WBTC': 84500,
    'BTC': 84500,
    'CBETH': 2875,
    'WSTETH': 3100,
    'WSETH': 3100,
    'AERO': 0.51,
    'VIRTUAL': 0.68,
    'DEGEN': 0.0028,
    'BRETT': 0.082
}

function resolvePrice(addr, symbol, priceMap = {}) {
    const aKey = (addr || '').toLowerCase()
    for (const [k, v] of Object.entries(priceMap)) {
        if (k.toLowerCase() === aKey) return v
    }
    const sKey = (symbol || '').toUpperCase()
    if (KNOWN_SYMBOL_PRICES[sKey] !== undefined) return KNOWN_SYMBOL_PRICES[sKey]
    if (sKey.includes('USD')) return 1.0
    if (sKey.includes('BTC')) return 84500
    if (sKey.includes('ETH')) return 2600
    return 1.0
}

/**
 * Build all bidirectional cross-DEX routes for a list of pools.
 * Evaluates both:
 * - DEX directions: Pool A -> Pool B and Pool B -> Pool A
 * - Token directions: Token0 -> Token1 -> Token0 and Token1 -> Token0 -> Token1
 */
function buildCrossDexRoutes(poolList, tokenPrices = {}) {
    const routes = []
    const groups = new Map()

    // Group pools by pair of tokens
    for (const p of poolList || []) {
        if (!p || !p.token0 || !p.token1 || !p.address) continue
        const t0 = String(p.token0).toLowerCase()
        const t1 = String(p.token1).toLowerCase()
        const pairKey = [t0, t1].sort().join(':')
        if (!groups.has(pairKey)) groups.set(pairKey, [])
        groups.get(pairKey).push(p)
    }

    for (const [pairKey, pairPools] of groups) {
        for (let i = 0; i < pairPools.length; i++) {
            for (let j = 0; j < pairPools.length; j++) {
                if (i === j) continue
                const pA = pairPools[i]
                const pB = pairPools[j]

                // Discard routes between identical pools
                if (String(pA.address).toLowerCase() === String(pB.address).toLowerCase()) continue

                // Avoid routing between identical DEX pools with identical fee tiers
                const sameDex = String(pA.dex || pA.adapter || '').toLowerCase() === String(pB.dex || pB.adapter || '').toLowerCase()
                const feeA = pA.feeBps || (pA.feeTier ? pA.feeTier / 100 : 30)
                const feeB = pB.feeBps || (pB.feeTier ? pB.feeTier / 100 : 30)
                if (sameDex && feeA === feeB) continue

                // Normalize tokens
                const t0 = sameToken(pA.token0, pB.token0) ? pA.token0 : pA.token1
                const t1 = sameToken(pA.token1, pB.token1) ? pA.token1 : pA.token0

                const t0Symbol = pA.token0Symbol || 'T0'
                const t1Symbol = pA.token1Symbol || 'T1'
                const t0Decimals = pA.token0Decimals !== undefined ? pA.token0Decimals : 18
                const t1Decimals = pA.token1Decimals !== undefined ? pA.token1Decimals : 18

                const dexA = pA.dex || pA.adapter || 'dexA'
                const dexB = pB.dex || pB.adapter || 'dexB'

                // Direction 1: Start in Token0 -> trade for Token1 on pA -> trade back for Token0 on pB
                const t0PriceUsd = resolvePrice(t0, t0Symbol, tokenPrices)
                routes.push({
                    id: `${dexA}:${pA.address.slice(0, 8)}->${dexB}:${pB.address.slice(0, 8)}:${t0Symbol}->${t1Symbol}`,
                    buyDex: dexA,
                    sellDex: dexB,
                    buyPool: pA,
                    sellPool: pB,
                    pools: [pA.address.toLowerCase(), pB.address.toLowerCase()],
                    tokenIn: t0,
                    tokenOut: t1,
                    tokenInSymbol: t0Symbol,
                    tokenOutSymbol: t1Symbol,
                    tokenInDecimals: t0Decimals,
                    tokenOutDecimals: t1Decimals,
                    tokenUsdPrice: t0PriceUsd,
                    flashloanFeeBps: 5,
                    gasCostUsd: 0.05
                })

                // Direction 2: Start in Token1 -> trade for Token0 on pA -> trade back for Token1 on pB
                const t1PriceUsd = resolvePrice(t1, t1Symbol, tokenPrices)
                routes.push({
                    id: `${dexA}:${pA.address.slice(0, 8)}->${dexB}:${pB.address.slice(0, 8)}:${t1Symbol}->${t0Symbol}`,
                    buyDex: dexA,
                    sellDex: dexB,
                    buyPool: pA,
                    sellPool: pB,
                    pools: [pA.address.toLowerCase(), pB.address.toLowerCase()],
                    tokenIn: t1,
                    tokenOut: t0,
                    tokenInSymbol: t1Symbol,
                    tokenOutSymbol: t0Symbol,
                    tokenInDecimals: t1Decimals,
                    tokenOutDecimals: t0Decimals,
                    tokenUsdPrice: t1PriceUsd,
                    flashloanFeeBps: 5,
                    gasCostUsd: 0.05
                })
            }
        }
    }

    return routes
}

const { sqrtPriceToPrice } = require('./v3_math')

/**
 * Build live cross-DEX price matrix for diagnostic and visual reporting.
 */
function buildCrossDexPriceMatrix(poolList) {
    const matrix = []
    const groups = new Map()

    for (const p of poolList || []) {
        if (!p || !p.token0 || !p.token1 || !p.address) continue
        const t0 = String(p.token0Symbol || 'T0').toUpperCase()
        const t1 = String(p.token1Symbol || 'T1').toUpperCase()
        const pairKey = [t0, t1].sort().join('/')
        if (!groups.has(pairKey)) groups.set(pairKey, [])
        groups.get(pairKey).push(p)
    }

    function getDexCategory(p) {
        const d = String(p.dex || p.adapter || '').toLowerCase()
        if (d.includes('pancake')) return 'Cake'
        if (d.includes('aero') || d.includes('slipstream')) return 'Aero'
        return 'Uni'
    }

    function getDexLabel(p) {
        const feeLabel = p.feeTier ? `${(p.feeTier/100).toFixed(2)}%` : ''
        return `${getDexCategory(p)}${feeLabel ? '(' + feeLabel + ')' : ''}`
    }

    for (const [pair, pools] of groups) {
        for (let i = 0; i < pools.length; i++) {
            for (let j = i + 1; j < pools.length; j++) {
                const u = pools[i]
                const c = pools[j]

                const catA = getDexCategory(u)
                const catB = getDexCategory(c)

                // Allow intra-DEX cross-fee-tier comparisons (different fee tiers = different pools = valid arb)
                // Only skip if it's the exact same pool address
                if (String(u.address).toLowerCase() === String(c.address).toLowerCase()) continue

                const sameDex = catA === catB
                const feeA = u.feeTier || (u.feeBps ? u.feeBps * 100 : 3000)
                const feeB = c.feeTier || (c.feeBps ? c.feeBps * 100 : 3000)
                // Skip same DEX AND same fee tier (truly identical pool class — no arb)
                if (sameDex && feeA === feeB) continue

                const routeType = sameDex ? 'INTRA_DEX_FEE_TIER' : 'CROSS_DEX'

                // Ignore pools with negligible/zero liquidity (prevents false spot signals on abandoned pools)
                if (u.liquidity !== undefined && BigInt(u.liquidity) < 10000000000000n) continue
                if (c.liquidity !== undefined && BigInt(c.liquidity) < 10000000000000n) continue

                const uDec0 = u.token0Decimals || 18
                const uDec1 = u.token1Decimals || 18
                const cDec0 = c.token0Decimals || 18
                const cDec1 = c.token1Decimals || 18

                const uPriceInfo = u.sqrtPriceX96 ? sqrtPriceToPrice(u.sqrtPriceX96, uDec0, uDec1) : { priceToken1PerToken0: 0 }
                const cPriceInfo = c.sqrtPriceX96 ? sqrtPriceToPrice(c.sqrtPriceX96, cDec0, cDec1) : { priceToken1PerToken0: 0 }

                const pU = uPriceInfo.priceToken1PerToken0
                const pC = cPriceInfo.priceToken1PerToken0
                if (pU <= 0 || pC <= 0) continue

                const feeU = u.feeBps || (u.feeTier ? u.feeTier / 100 : 5)
                const feeC = c.feeBps || (c.feeTier ? c.feeTier / 100 : 5)
                const feeHurdleBps = feeU + feeC

                const minP = Math.min(pU, pC)
                const rawSpreadBps = (Math.abs(pU - pC) / minP) * 10000
                const netSpreadBps = rawSpreadBps - feeHurdleBps

                matrix.push({
                    pair: `${pair} ${getDexLabel(u)}/${getDexLabel(c)}`,
                    routeType,
                    dexA: catA,
                    dexB: catB,
                    poolA: u.address,
                    feeABps: feeU,
                    priceA: pU,
                    poolB: c.address,
                    feeBBps: feeC,
                    priceB: pC,
                    // Keep legacy field names for backwards compat
                    uniPool: u.address,
                    uniFeeBps: feeU,
                    uniPrice: pU,
                    cakePool: c.address,
                    cakeFeeBps: feeC,
                    cakePrice: pC,
                    rawSpreadBps,
                    feeHurdleBps,
                    netSpreadBps,
                    dislocated: netSpreadBps > 0
                })
            }
        }
    }

    return matrix.sort((a, b) => b.netSpreadBps - a.netSpreadBps)
}

/**
 * Filter routes to only those containing affected pool addresses.
 */
function filterAffectedRoutes(routes, affectedPoolAddresses) {
    if (!affectedPoolAddresses || !affectedPoolAddresses.length) return routes
    const affectedSet = new Set(affectedPoolAddresses.map(a => String(a).toLowerCase()))
    return routes.filter(r => r.pools.some(addr => affectedSet.has(addr)))
}

const MIN_POOL_LIQUIDITY = 10000000000000n // 10^13 (pools with less than ~$100 depth)

module.exports = {
    validatePoolCoverage,
    buildCrossDexRoutes,
    buildCrossDexPriceMatrix,
    filterAffectedRoutes,
    MIN_POOL_LIQUIDITY
}

