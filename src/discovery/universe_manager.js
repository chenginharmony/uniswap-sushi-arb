'use strict'

const fs = require('fs')
const path = require('path')

/**
 * @title UniverseManager
 * @notice Manages a 3-tier dynamic pool universe for sub-200ms MEV:
 *   1. Discovery Universe (All discovered pools across Base DEXes)
 *   2. Eligibility Filter (Minimum liquidity, reserves, and valid token metadata)
 *   3. Hot Universe (~150-300 top-scoring pools kept in fast memory for Flashblocks)
 */
class UniverseManager {
    constructor(options = {}) {
        this.minLiquidityUsd = options.minLiquidityUsd || 5000
        this.maxHotPools = options.maxHotPools || 250
        this.discoveryFile = options.discoveryFile || path.resolve(__dirname, '../../data/discovery_universe.json')
        this.hotUniverseFile = options.hotUniverseFile || path.resolve(__dirname, '../../data/base_pool_universe.json')

        this.pools = new Map() // poolAddress.toLowerCase() -> poolDef
        this.telemetry = new Map() // poolAddress.toLowerCase() -> { recentVolumeUsd, priceChanges, lastOpportunityAt }
        this.hotPools = [] // Current active promoted hot pool list
        this.hotPoolSet = new Set() // Set of lowercase addresses in hot universe
    }

    /**
     * Ingests a discovered pool definition into the discovery universe.
     *
     * @param {Object} poolDef - Pool metadata
     * @returns {boolean} True if added or updated
     */
    registerPool(poolDef) {
        if (!poolDef || !poolDef.address || !poolDef.token0 || !poolDef.token1) return false
        const addr = poolDef.address.toLowerCase()
        const existing = this.pools.get(addr)
        
        const merged = Object.assign({}, existing || {}, poolDef, {
            address: addr,
            token0: poolDef.token0.toLowerCase(),
            token1: poolDef.token1.toLowerCase(),
            dex: poolDef.dex || poolDef.adapter || 'v3'
        })
        this.pools.set(addr, merged)
        return true
    }

    /**
     * Batch registers an array of pool definitions.
     */
    registerPools(poolList = []) {
        let added = 0
        for (const p of poolList) {
            if (this.registerPool(p)) added++
        }
        return added
    }

    /**
     * Updates real-time market activity signals used for scoring and promotion.
     *
     * @param {string} poolAddress
     * @param {Object} signals - { volumeUsd, priceChange, opportunityFound }
     */
    recordActivity(poolAddress, signals = {}) {
        const addr = (poolAddress || '').toLowerCase()
        if (!addr) return
        const current = this.telemetry.get(addr) || {
            volumeUsd: 0,
            priceChanges: 0,
            opportunities: 0,
            lastActive: Date.now()
        }

        if (signals.volumeUsd) current.volumeUsd += Number(signals.volumeUsd)
        if (signals.priceChange) current.priceChanges += 1
        if (signals.opportunityFound) current.opportunities += 1
        current.lastActive = Date.now()

        this.telemetry.set(addr, current)
    }

    /**
     * Calculates the dynamic quality score of a pool.
     * Score = log10(Liquidity USD) * CrossVenueMultiplier * ActivityFactor
     */
    calculatePoolScore(poolDef) {
        const addr = poolDef.address.toLowerCase()
        const liqUsd = Math.max(1, Number(poolDef.liquidityUsd || poolDef.tvlUsd || 10000))
        
        // Base score from liquidity depth
        let score = Math.log10(liqUsd)

        // Cross-venue depth bonus: check how many other DEXes trade this pair
        const pairKey = [poolDef.token0Symbol, poolDef.token1Symbol].sort().join('/')
        const venueCount = this._countVenuesForPair(pairKey)
        const crossVenueMultiplier = venueCount >= 3 ? 1.5 : (venueCount === 2 ? 1.2 : 1.0)
        score *= crossVenueMultiplier

        // Telemetry bonus from live price movement / opportunity discovery
        const tel = this.telemetry.get(addr)
        if (tel) {
            const oppBonus = Math.min(2.0, 1.0 + (tel.opportunities * 0.1))
            score *= oppBonus
        }

        return Number(score.toFixed(4))
    }

    _countVenuesForPair(pairKey) {
        const venues = new Set()
        for (const p of this.pools.values()) {
            const pKey = [p.token0Symbol, p.token1Symbol].sort().join('/')
            if (pKey === pairKey) {
                venues.add(p.dex || p.adapter)
            }
        }
        return venues.size
    }

    /**
     * Evaluates all pools, applies eligibility gates, scores candidates,
     * and promotes the top N pools into the Hot Universe.
     *
     * @returns {Object} Promotion diagnostics { total, eligible, hotCount }
     */
    recomputeHotUniverse() {
        const scored = []

        for (const pool of this.pools.values()) {
            // Eligibility filter: must have valid token pair
            if (!pool.token0 || !pool.token1 || pool.token0 === pool.token1) continue

            // Liquidity filter: exclude zero or dust liquidity
            const liq = pool.liquidity !== undefined ? BigInt(pool.liquidity) : 1n
            const r0 = pool.reserve0 !== undefined ? BigInt(pool.reserve0) : 1n
            const r1 = pool.reserve1 !== undefined ? BigInt(pool.reserve1) : 1n
            if (liq === 0n && (r0 === 0n || r1 === 0n)) continue

            const score = this.calculatePoolScore(pool)
            scored.push({ pool, score })
        }

        // Rank by score descending
        scored.sort((a, b) => b.score - a.score)

        // Promote top N
        const promoted = scored.slice(0, this.maxHotPools).map(item => item.pool)
        this.hotPools = promoted
        this.hotPoolSet = new Set(promoted.map(p => p.address.toLowerCase()))

        return {
            totalRegistered: this.pools.size,
            eligibleCandidates: scored.length,
            hotPromotedCount: this.hotPools.length,
            topScore: scored.length > 0 ? scored[0].score : 0
        }
    }

    /**
     * Checks if a pool address is in the high-frequency Hot Universe.
     */
    isHot(poolAddress) {
        return this.hotPoolSet.has((poolAddress || '').toLowerCase())
    }

    getHotPools() {
        return this.hotPools
    }

    /**
     * Persists the discovery and hot universes to disk.
     */
    saveToDisk() {
        try {
            const dir = path.dirname(this.hotUniverseFile)
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

            const replacer = (k, v) => typeof v === 'bigint' ? v.toString() : v
            // Write active hot universe for live trader consumption
            fs.writeFileSync(this.hotUniverseFile, JSON.stringify(this.hotPools, replacer, 2), 'utf8')

            // Write full discovery catalog
            const allPools = Array.from(this.pools.values())
            fs.writeFileSync(this.discoveryFile, JSON.stringify(allPools, replacer, 2), 'utf8')
            return true
        } catch (e) {
            return false
        }
    }

    /**
     * Loads existing universe JSON from disk.
     */
    loadFromDisk() {
        if (fs.existsSync(this.hotUniverseFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.hotUniverseFile, 'utf8'))
                this.registerPools(data)
                this.recomputeHotUniverse()
                return true
            } catch (e) {}
        }
        return false
    }
}

module.exports = {
    UniverseManager
}
