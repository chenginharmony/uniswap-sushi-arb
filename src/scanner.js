'use strict'

const { loadConfig } = require('./config')
const { FlashblocksClient } = require('./flashblocks/client')
const { PoolStateManager } = require('./arbitrage/state')
const { Metrics } = require('./monitoring/metrics')

class Scanner {
    constructor(options) {
        this.config = options.config || loadConfig(process.env)
        this.state = options.state || new PoolStateManager()
        this.metrics = options.metrics || new Metrics()
        this.client = options.client
        this.decodeAffectedPools = options.decodeAffectedPools || (() => [])
        this.evaluateRoute = options.evaluateRoute || (() => null)
        this.seen = new Map()
        this.ttlMs = options.dedupTtlMs || 120000
        this.running = false
    }

    start() {
        if (!this.config.flashblocks.enabled) return null
        if (!this.client) {
            this.client = new FlashblocksClient({
                url: this.config.flashblocks.wsUrl,
                queueSize: this.config.flashblocks.queueSize,
                reconnectDelay: this.config.flashblocks.reconnectDelay,
                maxReconnectDelay: this.config.flashblocks.maxReconnectDelay
            })
        }
        this.running = true
        this.queue = this.client.start()
        this.consume()
        return this.queue
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
        const key = event.transactionHash + ':' + (event.context || 'unknown')
        const now = Date.now()
        for (const [seenKey, seenAt] of this.seen) if (now - seenAt > this.ttlMs) this.seen.delete(seenKey)
        if (this.seen.has(key)) { this.metrics.increment('duplicateTransactions'); return }
        this.seen.set(key, now)
        this.metrics.increment('transactionsReceived')

        const affectedPools = this.decodeAffectedPools(event) || []
        const routes = this.state.routesForPools(affectedPools)
        this.metrics.increment('routesRescanned', routes.length)
        await Promise.all(routes.map(route => this.evaluateRoute(route, event, this.state, this.metrics)))
    }

    stop() {
        this.running = false
        if (this.client) this.client.stop()
    }
}

module.exports = { Scanner }
