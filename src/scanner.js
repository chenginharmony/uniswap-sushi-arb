'use strict'

const { loadConfig } = require('./config')
const { FlashblocksClient } = require('./flashblocks/client')
const { PoolStateManager } = require('./arbitrage/state')
const { opportunityFromRoute } = require('./arbitrage/engine')
const { createBasePoolBootstrapper } = require('./pools/bootstrap')
const { CanonicalBlockFeed } = require('./pools/provider')
const { Metrics } = require('./monitoring/metrics')
const { validatePoolCoverage, buildCrossDexRoutes } = require('./arbitrage/route_builder')

class Scanner {
    constructor(options = {}) {
        this.config = options.config || loadConfig(process.env)
        this.state = options.state || new PoolStateManager()
        this.metrics = options.metrics || new Metrics()
        this.client = options.client
        this.poolBootstrapper = options.poolBootstrapper !== undefined ?
            options.poolBootstrapper :
            (options.decodeAffectedPools ? null : createBasePoolBootstrapper(this.config, this.state, options))
        this.canonicalFeed = options.canonicalFeed || options.canonicalClient
        if (!this.canonicalFeed && this.poolBootstrapper && this.config.base && this.config.base.wsUrl) {
            this.canonicalFeed = new CanonicalBlockFeed({
                url: this.config.base.wsUrl,
                provider: this.poolBootstrapper.provider,
                reconnectDelay: this.config.base.reconnectDelay,
                maxReconnectDelay: this.config.base.maxReconnectDelay,
                metrics: this.metrics
            })
        }
        this.bootstrapped = options.bootstrapped !== undefined ? Boolean(options.bootstrapped) : (!this.poolBootstrapper)
        this.decodeAffectedPools = options.decodeAffectedPools ||
            (this.poolBootstrapper ? this.poolBootstrapper.affectedPools.bind(this.poolBootstrapper) : (() => []))
        this.updatePoolState = options.updatePoolState || this.defaultUpdatePoolState.bind(this)
        this.evaluateRoute = options.evaluateRoute || this.defaultEvaluateRoute.bind(this)
        this.maxEvaluationConcurrency = Math.max(1, options.maxEvaluationConcurrency || 8)
        this.seen = new Map()
        this.ttlMs = options.dedupTtlMs || 120000
        this.running = false
        this.coverage = null
    }

    async start() {
        const flashblocksEnabled = Boolean(this.config.flashblocks && this.config.flashblocks.enabled)
        const canonicalEnabled = Boolean(this.canonicalFeed)
        if (!flashblocksEnabled && !canonicalEnabled) return null
        this.running = true
        try {
            await this.bootstrapState()
            if (canonicalEnabled) {
                this.canonicalFeed.start(this.reconcileCanonicalBlock.bind(this))
            }
            if (flashblocksEnabled && !this.client) {
                this.client = new FlashblocksClient({
                    url: this.config.flashblocks.wsUrl,
                    queueSize: this.config.flashblocks.queueSize,
                    reconnectDelay: this.config.flashblocks.reconnectDelay,
                    maxReconnectDelay: this.config.flashblocks.maxReconnectDelay
                })
            }
            if (flashblocksEnabled) {
                this.queue = this.client.start()
                this.consume()
            }
            return this.queue
        } catch (error) {
            this.running = false
            if (this.canonicalFeed) this.canonicalFeed.stop()
            if (this.client) this.client.stop()
            throw error
        }
    }

    async consume() {
        while (this.running) {
            const event = await this.queue.pop()
            if (!this.running) break
            try { await this.process(event) }
            catch (error) { this.metrics.increment('processingErrors'); console.error('[SCANNER] event processing failed:', error.message) }
        }
    }

    async process(event) {
        if (!this.bootstrapped) throw new Error('Scanner cannot process events before pool bootstrap succeeds')
        const phase = event.phase || event.status || (event.canonical ? 'canonical' : 'preconfirmation')
        const key = event.transactionHash + ':' + phase + ':' + (event.context || 'unknown')
        const now = Date.now()
        for (const [seenKey, seenAt] of this.seen) if (now - seenAt > this.ttlMs) this.seen.delete(seenKey)
        if (this.seen.has(key)) { this.metrics.increment('duplicateTransactions'); return }
        this.seen.set(key, now)
        this.metrics.increment('transactionsReceived')

        const receivedAt = event.receivedMonotonicNs || process.hrtime.bigint()
        const decodedAt = process.hrtime.bigint()
        this.metrics.observe('flashblockReceiveToDecode', Number(decodedAt - receivedAt) / 1000000)
        const decodedPools = this.decodeAffectedPools(event) || []
        let affectedPools = await this.updatePoolState(event, decodedPools)
        if (phase === 'canonical' && this.poolBootstrapper) {
            affectedPools = (affectedPools || []).concat(await this.poolBootstrapper.reconcile(event.blockNumber || event.context))
        }
        affectedPools = Array.from(new Set(affectedPools || []))
        this.metrics.observe('poolUpdate', Number(process.hrtime.bigint() - decodedAt) / 1000000)
        const routes = this.state.routesForPools(affectedPools)
        this.metrics.increment('routesRescanned', routes.length)
        return this.evaluateRoutes(routes, event)
    }

    async reconcileCanonicalBlock(block) {
        if (!this.bootstrapped) throw new Error('Scanner cannot reconcile blocks before pool bootstrap succeeds')
        if (!this.poolBootstrapper) return []

        const context = block && (block.number || block.blockNumber || block.hash)
        const startedAt = process.hrtime.bigint()
        try {
            const affectedPools = await this.poolBootstrapper.reconcile(context)
            this.metrics.increment('canonicalBlocksReconciled')
            this.metrics.increment('canonicalPoolsChanged', affectedPools.length)
            this.metrics.observe('canonicalReconciliation', Number(process.hrtime.bigint() - startedAt) / 1000000)
            const routes = this.state.routesForPools(affectedPools)
            this.metrics.increment('routesRescanned', routes.length)
            return this.evaluateRoutes(routes, {
                blockNumber: context,
                context,
                phase: 'canonical',
                canonical: true,
                block
            })
        } catch (error) {
            this.metrics.increment('canonicalReconciliationErrors')
            this.metrics.increment('canonicalRpcFailures')
            this.metrics.observe('canonicalReconciliation', Number(process.hrtime.bigint() - startedAt) / 1000000)
            console.error('[CANONICAL] reconciliation failed:', error.message)
            throw error
        }
    }

    async evaluateRoutes(routes, event) {
        const stateVersion = this.state.version
        const results = await this.mapWithConcurrency(routes, this.maxEvaluationConcurrency, async route => {
            const evaluationStarted = process.hrtime.bigint()
            this.metrics.increment('opportunitiesEvaluated')
            const result = await this.evaluateRoute(route, event, this.state, this.metrics)
            this.metrics.observe('routeEvaluation', Number(process.hrtime.bigint() - evaluationStarted) / 1000000)

            if (this.state.version !== stateVersion || (result && result.stateVersion !== undefined && result.stateVersion !== stateVersion)) {
                this.metrics.increment('staleOpportunities')
                return null
            }

            if (result && result.profitable) {
                this.metrics.increment('opportunitiesProfitable')
                try {
                    const { buildFlashArbitrageTransaction } = require('./execution/builder')
                    result.flashTx = buildFlashArbitrageTransaction(result, this.config)
                } catch (err) {
                    result.flashTxError = err.message
                }
            } else if (result) {
                if (typeof this.metrics.recordRejection === 'function') {
                    this.metrics.recordRejection(result.rejectionReason || 'UNPROFITABLE')
                } else {
                    this.metrics.increment('opportunitiesRejected')
                }
            }
            return result
        })
        return results.filter(Boolean)
    }

    async updatePools(event, decodedPools) {
        return this.updatePoolState(event, decodedPools)
    }

    async defaultUpdatePoolState(event, decodedPools) {
        const addresses = []
        for (const decodedPool of decodedPools) {
            const pool = typeof decodedPool === 'string' ? { address: decodedPool } : decodedPool
            if (!pool || !pool.address) continue
            if (pool.reserve0 !== undefined && pool.reserve1 !== undefined) {
                this.state.upsertPool(Object.assign({}, pool, { context: event.context }))
            } else if (this.poolBootstrapper) {
                await this.poolBootstrapper.refresh([pool.address], event.context)
            }
            addresses.push(pool.address)
        }
        return addresses
    }

    async bootstrapState() {
        if (!this.poolBootstrapper) {
            if (this.config.base && this.config.base.requireBootstrap &&
                this.config.base.poolConfigs && this.config.base.poolConfigs.length) {
                throw new Error('BASE_POOL_CONFIG_JSON is required when BASE_REQUIRE_BOOTSTRAP is enabled')
            }
            this.bootstrapped = true
            return []
        }
        const records = await this.poolBootstrapper.bootstrap()
        this.bootstrapped = true

        // Register bidirectional cross-DEX routes if not already registered
        const poolList = Array.from(this.state.pools.values())
        const generatedRoutes = buildCrossDexRoutes(poolList, this.config.tokenPrices)
        for (const route of generatedRoutes) {
            if (!this.state.routes.has(route.id)) {
                this.state.registerRoute(route)
            }
        }

        // Validate market pool coverage against minPools (default: 5)
        const routesList = Array.from(this.state.routes.values())
        this.coverage = validatePoolCoverage(poolList, routesList, this.config.minPools || 5)
        if (!this.coverage.valid) {
            console.warn(`[SCANNER] WARNING: ${this.coverage.reason}`)
        }

        return records
    }

    async defaultEvaluateRoute(route, event, state, metrics) {
        const tokenUsdPrice = Number(route.tokenUsdPrice)
        if (!Number.isFinite(tokenUsdPrice) || tokenUsdPrice <= 0) {
            throw new Error('Route tokenUsdPrice must be a positive finite number')
        }

        const sizesUsd = this.config.arbitrageSizesUsd || []
        if (!sizesUsd.length) throw new Error('At least one arbitrage size is required')

        const opportunities = sizesUsd.map(sizeUsd =>
            opportunityFromRoute(route, sizeUsd / tokenUsdPrice, this.config, state)
        )
        const opportunity = opportunities.sort((left, right) =>
            right.expectedNetProfitUsd - left.expectedNetProfitUsd
        )[0]

        if (opportunity) {
            opportunity.sourceFlashblock = event.context || null
            opportunity.sourceTransactionHash = event.transactionHash || null
            if (typeof metrics.recordNetProfit === 'function') {
                metrics.recordNetProfit(opportunity.expectedNetProfitUsd)
            }
        }
        return opportunity
    }

    async mapWithConcurrency(items, concurrency, worker) {
        const results = []
        let next = 0
        const run = async () => {
            while (next < items.length) {
                const index = next++
                results[index] = await worker(items[index])
            }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
        return results
    }

    stop() {
        this.running = false
        if (this.client) this.client.stop()
        if (this.canonicalFeed) this.canonicalFeed.stop()
    }
}

module.exports = { Scanner }
