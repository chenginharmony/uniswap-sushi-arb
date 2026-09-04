'use strict'

const fs = require('fs')
const path = require('path')

/**
 * @title LatencyProfiler
 * @notice High-resolution microsecond/millisecond pipeline profiler for Base 200ms Flashblocks.
 * Tracks time consumed at every discrete stage of the MEV lifecycle:
 *   Flashblock Ingestion ➔ State Update ➔ Route Pricing ➔ Optimizer ➔ Builder ➔ Preflight ➔ Signer ➔ Broadcast ➔ Inclusion
 */
class LatencyProfiler {
    constructor(options = {}) {
        this.logFile = options.logFile || path.resolve(__dirname, '../../data/latency_profiles.jsonl')
        this.activeTraces = new Map()
        this.history = []
        this.maxHistory = options.maxHistory || 100
        
        // Stage metrics buckets
        this.stageSamples = {
            stateUpdateMs: [],
            ingestionToStateStartMs: [],
            quoteRoutingMs: [],
            optimizerMs: [],
            builderMs: [],
            preflightMs: [],
            signingMs: [],
            broadcastMs: [],
            opportunityAgeMs: [],
            totalPipelineMs: [],
            inclusionMs: []
        }
    }

    /**
     * Initiates a new high-resolution execution trace.
     *
     * @param {string} traceId - Unique trace ID or opportunity ID
     * @param {Object} metadata - Context (route, stateVersion, pool, blockNumber, trigger, isHotPath)
     * @returns {Object} Active trace tracker
     */
    startTrace(traceId, metadata = {}) {
        const nowNs = process.hrtime.bigint()
        const nowMs = Date.now()
        const trace = {
            traceId,
            startedAtMs: nowMs,
            metadata,
            checkpoints: {
                fbReceived: nowNs
            },
            intervals: {},
            completed: false
        }
        this.activeTraces.set(traceId, trace)
        return trace
    }

    /**
     * Records a milestone checkpoint in an active trace.
     * Checkpoint names:
     *   - 'stateUpdateStarted': Ingestion complete, state decode begins
     *   - 'stateUpdated': Pool reserves/slot0 state decoded into memory
     *   - 'quoteStarted': Cross-DEX arbitrage quoting begins
     *   - 'routesRepriced': Affected cross-DEX routes quoted
     *   - 'optimizerStarted': Dynamic trade sizing search begins
     *   - 'optimized': Dynamic sizing and profit curve finalized
     *   - 'builderStarted': Calldata construction begins
     *   - 'built': Calldata constructed with repayment floor
     *   - 'preflightStarted': eth_call simulation begins
     *   - 'preflighted': eth_call simulation + estimateGas completed
     *   - 'signed': EIP-1559 transaction signed locally
     *   - 'broadcasted': Transaction submitted to RPC mempool
     *   - 'confirmed': Transaction receipt mined/confirmed on-chain
     */
    mark(traceId, checkpointName) {
        const trace = this.activeTraces.get(traceId)
        if (!trace) return null

        const nowNs = process.hrtime.bigint()
        trace.checkpoints[checkpointName] = nowNs
        return trace
    }

    /**
     * Finalizes the trace, computes exact elapsed millisecond intervals,
     * updates statistical distributions, and logs to JSONL.
     *
     * @param {string} traceId
     * @param {Object} outcome - Result metadata (status, txHash, profitUsd, error)
     * @returns {Object} Finalized trace record
     */
    endTrace(traceId, outcome = {}) {
        const trace = this.activeTraces.get(traceId)
        if (!trace) return null

        const cp = trace.checkpoints
        const toMs = (startNs, endNs) => {
            if (!startNs || !endNs || endNs < startNs) return 0
            return Number(endNs - startNs) / 1e6
        }

        // Compute step-by-step latency intervals with fine-grained isolation
        trace.intervals = {
            stateUpdateMs: toMs(cp.stateUpdateStarted || cp.fbReceived, cp.stateUpdated),
            ingestionToStateStartMs: toMs(cp.fbReceived, cp.stateUpdateStarted),
            quoteRoutingMs: toMs(cp.quoteStarted || cp.stateUpdated || cp.fbReceived, cp.routesRepriced),
            optimizerMs: toMs(cp.optimizerStarted || cp.routesRepriced || cp.stateUpdated || cp.fbReceived, cp.optimized),
            builderMs: toMs(cp.builderStarted || cp.optimized, cp.built),
            preflightMs: toMs(cp.preflightStarted || cp.built, cp.preflighted),
            signingMs: toMs(cp.preflighted, cp.signed),
            broadcastMs: toMs(cp.signed, cp.broadcasted),
            opportunityAgeMs: toMs(cp.fbReceived, cp.broadcasted || cp.signed || cp.preflighted || cp.optimized),
            totalPipelineMs: toMs(cp.fbReceived, cp.broadcasted || cp.signed || cp.preflighted || cp.optimized || cp.routesRepriced || cp.stateUpdated),
            inclusionMs: toMs(cp.broadcasted, cp.confirmed)
        }

        trace.outcome = outcome
        trace.completed = true
        this.activeTraces.delete(traceId)

        // Only record into hot-path 200ms MEV statistics if this trace is a hot-path execution
        // Prevents background periodic HTTP RPC poll cycles from poisoning 200ms Flashblock telemetry
        const isHotPath = trace.metadata.isHotPath !== false && trace.metadata.trigger !== 'rotation'
        if (isHotPath) {
            for (const [stage, val] of Object.entries(trace.intervals)) {
                if (val > 0 && this.stageSamples[stage]) {
                    this.stageSamples[stage].push(val)
                    if (this.stageSamples[stage].length > 500) {
                        this.stageSamples[stage].shift()
                    }
                }
            }
        }

        this.history.unshift(trace)
        if (this.history.length > this.maxHistory) {
            this.history.pop()
        }

        // Asynchronous non-blocking file append
        this.logTrace(trace)
        return trace
    }

    /**
     * Appends finalized trace record to disk.
     */
    logTrace(trace) {
        try {
            const dir = path.dirname(this.logFile)
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
            
            const line = JSON.stringify({
                timestamp: trace.startedAtMs,
                traceId: trace.traceId,
                route: trace.metadata.route || null,
                pair: trace.metadata.pair || null,
                stateVersion: trace.metadata.stateVersion || null,
                intervals: trace.intervals,
                outcome: trace.outcome
            }) + '\n'
            
            fs.appendFile(this.logFile, line, 'utf8', () => {})
        } catch (e) {}
    }

    /**
     * Calculates percentile for a specific metric array.
     */
    _percentile(arr, p) {
        if (!arr || arr.length === 0) return 0
        const sorted = arr.slice().sort((a, b) => a - b)
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))
        return Number(sorted[idx].toFixed(2))
    }

    /**
     * Returns comprehensive latency percentiles across the 200ms budget.
     */
    getSummary() {
        const summary = {
            totalSamples: this.stageSamples.totalPipelineMs.length,
            budgetMs: 200,
            stages: {}
        }

        for (const [stage, samples] of Object.entries(this.stageSamples)) {
            if (!samples.length) {
                summary.stages[stage] = { count: 0, p50: 0, p90: 0, p99: 0, max: 0, mean: 0 }
                continue
            }
            const sum = samples.reduce((a, b) => a + b, 0)
            summary.stages[stage] = {
                count: samples.length,
                p50: this._percentile(samples, 0.50),
                p90: this._percentile(samples, 0.90),
                p99: this._percentile(samples, 0.99),
                max: Number(Math.max(...samples).toFixed(2)),
                mean: Number((sum / samples.length).toFixed(2))
            }
        }

        return summary
    }

    /**
     * Formats an ASCII latency waterfall for a single execution trace.
     */
    formatWaterfall(trace) {
        if (!trace || !trace.intervals) return 'No trace data available'
        const iv = trace.intervals
        const total = iv.totalPipelineMs || 1
        const width = 24

        const bar = (val) => {
            const fraction = Math.min(1, Math.max(0, val / 200)) // 200ms scale
            const filled = Math.round(fraction * width)
            return '█'.repeat(filled) + '░'.repeat(width - filled)
        }

        const lines = [
            `Latency Waterfall (Trace: ${trace.traceId.slice(0, 16)}... | Budget: 200ms)`,
            `  1. State Update:   ${iv.stateUpdateMs.toFixed(2).padStart(6)}ms  [${bar(iv.stateUpdateMs)}]`,
            `  2. Quote Routing:  ${iv.quoteRoutingMs.toFixed(2).padStart(6)}ms  [${bar(iv.quoteRoutingMs)}]`,
            `  3. Size Optimizer: ${iv.optimizerMs.toFixed(2).padStart(6)}ms  [${bar(iv.optimizerMs)}]`,
            `  4. Tx Builder:     ${iv.builderMs.toFixed(2).padStart(6)}ms  [${bar(iv.builderMs)}]`,
            `  5. Preflight Sim:  ${iv.preflightMs.toFixed(2).padStart(6)}ms  [${bar(iv.preflightMs)}]`,
            `  6. Local Sign:     ${iv.signingMs.toFixed(2).padStart(6)}ms  [${bar(iv.signingMs)}]`,
            `  7. Broadcast:      ${iv.broadcastMs.toFixed(2).padStart(6)}ms  [${bar(iv.broadcastMs)}]`,
            `  ─────────────────────────────────────────────────────────────`,
            `  Total Pipeline:    ${iv.totalPipelineMs.toFixed(2).padStart(6)}ms  (${((iv.totalPipelineMs / 200) * 100).toFixed(1)}% of 200ms budget)`
        ]

        if (iv.inclusionMs > 0) {
            lines.push(`  Inclusion Delay:   ${iv.inclusionMs.toFixed(2).padStart(6)}ms`)
        }
        return lines.join('\n')
    }
}

// Global singleton instance for easy cross-module recording
const defaultProfiler = new LatencyProfiler()

module.exports = {
    LatencyProfiler,
    defaultProfiler
}
