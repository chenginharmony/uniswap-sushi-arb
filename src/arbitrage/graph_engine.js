'use strict'

const { ConcentratedLiquidityV3Adapter } = require('../adapters/cl_v3_adapter')
const { AerodromeV1Adapter } = require('../adapters/aerodrome_v1_adapter')

/**
 * @title GraphRouteEngine
 * @notice Directed Graph (DiGraph) multi-leg arbitrage engine.
 * Discovers both 2-leg direct cross-DEX routes and 3-leg triangular arbitrage cycles
 * (e.g., WETH -> USDC -> AERO -> WETH) across heterogeneous DEX protocols.
 */
class GraphRouteEngine {
    constructor(options = {}) {
        this.maxHops = options.maxHops || 3
        this.clAdapter = new ConcentratedLiquidityV3Adapter()
        this.aeroV1Adapter = new AerodromeV1Adapter()

        // Adjacency graph: tokenAddress (lowercase) -> Array of directed edges
        this.adj = new Map()
        this.routesByPool = new Map() // poolAddress (lowercase) -> Array of cycles containing this pool
    }

    /**
     * Resolves the appropriate protocol adapter for a pool.
     */
    getAdapter(pool) {
        const dex = String(pool.dex || pool.adapter || '').toLowerCase()
        if (dex.includes('aerodrome-v1') || dex === 'v1_amm') {
            return this.aeroV1Adapter
        }
        return this.clAdapter
    }

    /**
     * Rebuilds the directed graph from an array of pool definitions.
     *
     * @param {Array} pools - Array of pool definitions
     */
    buildGraph(pools = []) {
        this.adj.clear()
        this.routesByPool.clear()

        for (const pool of pools) {
            if (!pool || !pool.address || !pool.token0 || !pool.token1) continue
            const t0 = pool.token0.toLowerCase()
            const t1 = pool.token1.toLowerCase()
            const adapter = this.getAdapter(pool)

            // Forward edge: token0 -> token1
            this._addEdge(t0, t1, pool, adapter)
            // Reverse edge: token1 -> token0
            this._addEdge(t1, t0, pool, adapter)
        }
    }

    _addEdge(fromToken, toToken, pool, adapter) {
        if (!this.adj.has(fromToken)) {
            this.adj.set(fromToken, [])
        }

        const feeBps = pool.feeBps !== undefined ? pool.feeBps : (pool.feeTier ? pool.feeTier / 100 : 30)
        this.adj.get(fromToken).push({
            poolAddress: pool.address.toLowerCase(),
            poolDef: pool,
            dex: pool.dex || pool.adapter || 'v3',
            fromToken,
            toToken,
            feeBps,
            adapter
        })
    }

    /**
     * Discovers all 2-leg and 3-leg cycles starting and ending at startingToken.
     *
     * @param {string} startingToken - Address of initial asset (e.g. WETH or USDC)
     * @param {number} maxHops - Maximum route length (2 or 3)
     * @returns {Array} Array of executable multi-leg cycle routes
     */
    findArbitrageCycles(startingToken, maxHops = 3) {
        const start = (startingToken || '').toLowerCase()
        if (!this.adj.has(start)) return []

        const cycles = []
        const visitedPools = new Set()

        // Recursive DFS cycle search with strict acyclic pool pruning
        const dfs = (currentToken, currentPath) => {
            if (currentPath.length >= maxHops) return

            const edges = this.adj.get(currentToken) || []
            for (const edge of edges) {
                // Do not re-use the exact same pool in the same cycle
                if (visitedPools.has(edge.poolAddress)) continue

                const nextPath = currentPath.concat(edge)

                // If we reach the starting token and length >= 2, we found a valid arbitrage cycle
                if (edge.toToken === start && nextPath.length >= 2) {
                    cycles.push(this._formatCycle(nextPath, start))
                    continue
                }

                if (nextPath.length < maxHops) {
                    visitedPools.add(edge.poolAddress)
                    dfs(edge.toToken, nextPath)
                    visitedPools.delete(edge.poolAddress)
                }
            }
        }

        dfs(start, [])
        return cycles
    }

    /**
     * Discovers all cycles across all major base assets and indexes them by pool.
     */
    indexAllCycles(baseTokens = [], maxHops = 3) {
        const allCycles = []
        const seenCycleIds = new Set()

        for (const token of baseTokens) {
            const tokenCycles = this.findArbitrageCycles(token, maxHops)
            for (const c of tokenCycles) {
                if (!seenCycleIds.has(c.id)) {
                    seenCycleIds.add(c.id)
                    allCycles.push(c)

                    // Index cycle under each participating pool for sub-millisecond Flashblock lookup
                    for (const pAddr of c.poolAddresses) {
                        if (!this.routesByPool.has(pAddr)) {
                            this.routesByPool.set(pAddr, [])
                        }
                        this.routesByPool.get(pAddr).push(c)
                    }
                }
            }
        }

        return {
            totalCycles: allCycles.length,
            cycles: allCycles
        }
    }

    /**
     * Gets all multi-leg cycles affected when a specific pool receives a state update.
     */
    getAffectedCycles(poolAddress) {
        return this.routesByPool.get((poolAddress || '').toLowerCase()) || []
    }

    /**
     * Simulates an exact input trade through all legs of a multi-leg cycle.
     *
     * @param {Object} cycle - Multi-leg cycle object
     * @param {bigint|string} amountIn - Exact initial input amount
     * @param {Map} poolStates - Current state of pools in memory
     * @returns {Object} Simulation result with netAmountOut, profit, and sufficient liquidity
     */
    simulateCycle(cycle, amountIn, poolStates = new Map()) {
        let currentAmount = BigInt(amountIn)
        let totalFeePaid = 0n

        for (let i = 0; i < cycle.legs.length; i++) {
            const leg = cycle.legs[i]
            const poolState = poolStates.get(leg.poolAddress) || leg.poolDef

            const quote = leg.adapter.quoteExactInput(poolState, currentAmount, leg.fromToken)
            if (!quote.usable || quote.amountOut <= 0n) {
                return {
                    profitable: false,
                    amountOut: 0n,
                    profitAmount: 0n,
                    reason: `LEG_${i + 1}_FAILED`
                }
            }

            totalFeePaid += (quote.feePaid || 0n)
            currentAmount = quote.amountOut
        }

        const aIn = BigInt(amountIn)
        const profitAmount = currentAmount > aIn ? currentAmount - aIn : 0n
        const profitable = currentAmount > aIn

        return {
            profitable,
            amountIn: aIn,
            amountOut: currentAmount,
            profitAmount,
            legsExecuted: cycle.legs.length
        }
    }

    _formatCycle(legs, startingToken) {
        const id = legs.map(l => `${l.dex}:${l.poolAddress.slice(0, 6)}`).join('->')
        const poolAddresses = legs.map(l => l.poolAddress)
        return {
            id,
            hops: legs.length,
            startingToken,
            tokenIn: startingToken,
            tokenOut: startingToken,
            legs,
            poolAddresses,
            flashloanFeeBps: legs[0].feeBps || 5,
            gasCostUsd: legs.length === 2 ? 0.05 : 0.08
        }
    }
}

module.exports = {
    GraphRouteEngine
}
