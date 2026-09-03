'use strict'

const { BaseRpcProvider } = require('./provider')
const { AerodromeAdapter, UniswapV3Adapter, PancakeSwapV3Adapter } = require('./adapters')

const ADAPTERS = {
    aerodrome: AerodromeAdapter,
    'uniswap-v3': UniswapV3Adapter,
    uniswapv3: UniswapV3Adapter,
    pancakeswap: PancakeSwapV3Adapter,
    'pancakeswap-v3': PancakeSwapV3Adapter,
    pancakeswapv3: PancakeSwapV3Adapter
}

function valuesEqual(left, right) {
    if (left === right) return true
    if (left === undefined || left === null || right === undefined || right === null) return false
    if (typeof left === 'object' || typeof right === 'object') {
        try { return JSON.stringify(left) === JSON.stringify(right) } catch (error) { return false }
    }
    return String(left) === String(right)
}

function poolStateChanged(previous, next) {
    if (!previous) return true
    const ignored = new Set(['context', 'source', 'updatedAt'])
    const keys = new Set(Object.keys(previous).concat(Object.keys(next)))
    for (const key of keys) {
        if (ignored.has(key)) continue
        if (!valuesEqual(previous[key], next[key])) return true
    }
    return false
}

function createBaseAdapters(config, provider) {
    const grouped = new Map()
    for (const descriptor of config.base.poolConfigs || []) {
        const name = String(descriptor.adapter || '').toLowerCase()
        const Adapter = ADAPTERS[name]
        if (!Adapter) throw new Error(`Unsupported Base pool adapter: ${descriptor.adapter}`)
        const key = `${name}:${descriptor.factory || ''}`
        if (!grouped.has(key)) grouped.set(key, new Adapter({
            provider,
            factoryAddress: descriptor.factory,
            pools: []
        }))
        grouped.get(key).pools.push(descriptor)
    }
    return Array.from(grouped.values())
}

class PoolStateBootstrapper {
    constructor(options = {}) {
        this.state = options.state
        this.provider = options.provider
        this.adapters = options.adapters || []
        this.discovered = new Map()
        this.bootstrapped = false
        this.required = options.required !== false
    }

    async bootstrap() {
        if (!this.state) throw new Error('PoolStateBootstrapper requires a PoolStateManager')
        if (!this.provider) throw new Error('BASE_RPC_URL or an RPC provider is required for pool bootstrap')

        const records = []
        for (const adapter of this.adapters) {
            const pools = await adapter.discoverPools()
            for (const descriptor of pools) {
                const state = await adapter.readPoolState(descriptor)
                this.discovered.set(state.address.toLowerCase(), { adapter, descriptor })
                records.push(state)
            }
        }
        if (this.required && !records.length) throw new Error('No Base pools were discovered for bootstrap')
        for (const record of records) this.state.upsertPool(record)
        this.bootstrapped = true
        return records
    }

    async refresh(addresses, context, source = 'flashblocks') {
        if (!this.bootstrapped) throw new Error('Pool state must be bootstrapped before live updates')
        const refreshed = []
        for (const address of addresses || []) {
            const entry = this.discovered.get(String(address).toLowerCase())
            if (!entry) continue
            const state = await entry.adapter.readPoolState(entry.descriptor)
            const nextState = Object.assign({}, state, { context, source })
            const previous = this.state.pools.get(state.address) ||
                this.state.pools.get(String(state.address).toLowerCase())
            if (poolStateChanged(previous, nextState)) {
                refreshed.push(this.state.upsertPool(nextState))
            }
        }
        return refreshed.map(pool => pool.address)
    }

    async reconcile(context) {
        return this.refresh(Array.from(this.discovered.keys()), context, 'canonical')
    }

    affectedPools(event) {
        const logs = event && (event.logs || event.raw && (
            event.raw.logs ||
            event.raw.result && event.raw.result.logs ||
            event.raw.params && event.raw.params.result && event.raw.params.result.logs
        ))
        if (!Array.isArray(logs)) return []

        const addresses = []
        for (const log of logs) {
            const address = log && log.address
            const entry = address && this.discovered.get(String(address).toLowerCase())
            if (entry && entry.adapter.isSwapLog(log, address)) addresses.push(address)
        }
        return Array.from(new Set(addresses.map(address => String(address).toLowerCase())))
    }
}

function createBasePoolBootstrapper(config, state, options = {}) {
    const poolConfigs = config.base && config.base.poolConfigs || []
    if (!poolConfigs.length) return null
    const provider = options.provider || new BaseRpcProvider({
        httpUrl: config.base.rpcUrl,
        web3: options.web3
    })
    const adapters = options.adapters || createBaseAdapters(config, provider)
    return new PoolStateBootstrapper({
        state,
        provider,
        adapters,
        required: config.base.requireBootstrap
    })
}

module.exports = { PoolStateBootstrapper, createBaseAdapters, createBasePoolBootstrapper }