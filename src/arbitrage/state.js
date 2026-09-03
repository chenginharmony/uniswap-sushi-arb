'use strict'

class PoolStateManager {
    constructor() {
        this.pools = new Map()
        this.tokenPools = new Map()
        this.routes = new Map()
        this.version = 0
    }

    upsertPool(pool) {
        if (!pool || !pool.address) throw new Error('Pool address is required')
        const previous = this.pools.get(pool.address)
        this.pools.set(pool.address, Object.assign({}, previous, pool, { updatedAt: Date.now() }))
        for (const token of [pool.token0, pool.token1]) {
            if (!token) continue
            if (!this.tokenPools.has(token.toLowerCase())) this.tokenPools.set(token.toLowerCase(), new Set())
            this.tokenPools.get(token.toLowerCase()).add(pool.address)
        }
        this.version += 1
        return this.pools.get(pool.address)
    }

    updateReserves(address, reserve0, reserve1, context) {
        const pool = this.pools.get(address)
        if (!pool) return null
        pool.reserve0 = reserve0
        pool.reserve1 = reserve1
        pool.context = context || pool.context
        pool.updatedAt = Date.now()
        this.version += 1
        return pool
    }

    affectedPools(tokens) {
        const result = new Set()
        for (const token of tokens || []) {
            const addresses = this.tokenPools.get(String(token).toLowerCase()) || []
            addresses.forEach(address => result.add(address))
        }
        return Array.from(result).map(address => this.pools.get(address))
    }

    registerRoute(route) {
        if (!route || !route.id) throw new Error('Route id is required')
        this.routes.set(route.id, Object.assign({}, route, { stateVersion: this.version }))
    }

    routesForPools(poolAddresses) {
        const affected = new Set(poolAddresses)
        return Array.from(this.routes.values()).filter(route => route.pools.some(pool => affected.has(pool)))
    }
}

module.exports = { PoolStateManager }
