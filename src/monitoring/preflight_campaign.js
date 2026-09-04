'use strict'

/**
 * @title PreflightCampaign
 * @notice Phase 5 real-mainnet preflight validation campaign recorder.
 *
 * Classifies every preflight attempt and appends a structured JSONL record to
 * data/preflight_campaign.jsonl. The campaign runs with broadcasting disabled
 * (DRY_RUN=true) and collects enough evidence to decide when it is safe to
 * enable live execution.
 *
 * Outcome classes:
 *   PREFLIGHT_SUCCESS               — eth_call succeeded, fingerprint parity confirmed
 *   PREFLIGHT_INSUFFICIENT_PROFIT   — InsufficientProfit / profit below floor on-chain
 *   PREFLIGHT_STALE                 — opportunity age or state-version gate fired
 *   PREFLIGHT_STATE_DIVERGED        — state-version changed during eth_call RPC round-trip
 *   PREFLIGHT_LOK                   — Uniswap V3 reentrancy lock (LOK revert)
 *   PREFLIGHT_ECONOMIC_FILTER       — rejected by off-chain economic gates before eth_call
 *   PREFLIGHT_OTHER_REVERT          — any other on-chain revert
 *   PREFLIGHT_BUILD_ERROR           — calldata/builder threw before eth_call could run
 *   PREFLIGHT_FINGERPRINT_FAILED    — byte-exact parity assertion failed
 *
 * Fields captured per record:
 *   ts, outcome, routeId, flashPool, swapPool1, swapPool2, borrowAmount,
 *   expectedRepayment, minProfitSurplus, gasLimit, fingerprintHash,
 *   stateVersion, opportunityAgeMs, preflightLatencyMs, revertReason,
 *   estimatedGas, expectedNetProfitUsd, optimalSizeUsd
 */

const fs = require('fs')
const path = require('path')

const CAMPAIGN_LOG = path.join(__dirname, '..', '..', 'data', 'preflight_campaign.jsonl')

// Outcome class constants (export for use in controller and tests)
const OUTCOME = {
    SUCCESS:              'PREFLIGHT_SUCCESS',
    INSUFFICIENT_PROFIT:  'PREFLIGHT_INSUFFICIENT_PROFIT',
    STALE:                'PREFLIGHT_STALE',
    STATE_DIVERGED:       'PREFLIGHT_STATE_DIVERGED',
    LOK:                  'PREFLIGHT_LOK',
    ECONOMIC_FILTER:      'PREFLIGHT_ECONOMIC_FILTER',
    OTHER_REVERT:         'PREFLIGHT_OTHER_REVERT',
    BUILD_ERROR:          'PREFLIGHT_BUILD_ERROR',
    FINGERPRINT_FAILED:   'PREFLIGHT_FINGERPRINT_FAILED'
}

/**
 * Classify a controller decision/receipt into one of the Phase 5 outcome classes.
 *
 * @param {Object} receipt - Result from controller.processOpportunity()
 * @param {string|null} revertReason - Raw revert string from preflight (if available)
 * @returns {string} OUTCOME class
 */
function classifyOutcome(receipt, revertReason) {
    if (!receipt) return OUTCOME.BUILD_ERROR

    // Successful execution (DRY_RUN_VERIFIED or LIVE_BROADCAST)
    if (receipt.executed && receipt.fingerprintParity) return OUTCOME.SUCCESS
    if (receipt.executed) return OUTCOME.SUCCESS

    const reason = receipt.reason || ''
    const rev = (revertReason || receipt.revertReason || '').toLowerCase()

    if (reason === 'FINGERPRINT_PARITY_FAILED') return OUTCOME.FINGERPRINT_FAILED
    if (reason === 'STATE_VERSION_DIVERGED_POST_PREFLIGHT') return OUTCOME.STATE_DIVERGED
    if (reason === 'OPPORTUNITY_STALE' || reason === 'STATE_VERSION_DIVERGED') return OUTCOME.STALE

    // Economic pre-filters (before eth_call)
    if (['NOT_PROFITABLE', 'BELOW_MIN_PROFIT_THRESHOLD', 'EXCEEDS_MAX_SIZE_LIMIT',
         'STATE_REVALIDATION_FAILED', 'RECALCULATED_PROFIT_INSUFFICIENT'].includes(reason)) {
        return OUTCOME.ECONOMIC_FILTER
    }

    if (reason === 'PREFLIGHT_SIMULATION_REVERTED') {
        // LOK = Uniswap V3 reentrancy lock
        if (rev.includes('lok') || rev.includes('locked') || rev.includes('lock')) return OUTCOME.LOK
        if (rev.includes('insufficientprofit') || rev.includes('insufficient_profit') ||
            rev.includes('profit') || rev.includes('leg2slippage') || rev.includes('leg1slippage')) {
            return OUTCOME.INSUFFICIENT_PROFIT
        }
        return OUTCOME.OTHER_REVERT
    }

    if (reason === 'SIGNER_PREPARATION_ERROR' || reason === 'MISSING_SIGNER_KEY') return OUTCOME.BUILD_ERROR
    if (reason === 'BUILD_ERROR' || reason === 'MISSING_POOL_STATE' ||
        reason === 'ZERO_BORROW_AMOUNT' || reason === 'LOK_RISK_ABORTED' ||
        reason === 'NO_VALID_FLASH_POOL') return OUTCOME.BUILD_ERROR

    return OUTCOME.OTHER_REVERT
}

/**
 * Computes P50 / P90 / P99 / max for an array of numbers.
 * Returns { p50, p90, p99, max, n } — all null when the array is empty.
 */
function percentiles(arr) {
    if (!arr || arr.length === 0) return { p50: null, p90: null, p99: null, max: null, n: 0 }
    const sorted = arr.slice().sort((a, b) => a - b)
    const n = sorted.length
    const pct = (p) => sorted[Math.min(Math.floor(p / 100 * n), n - 1)]
    return {
        p50: pct(50),
        p90: pct(90),
        p99: pct(99),
        max: sorted[n - 1],
        n
    }
}

class PreflightCampaign {
    constructor(options = {}) {
        this.logPath = options.logPath || CAMPAIGN_LOG
        this.verbose = options.verbose !== false

        // Running counters per outcome class
        this.counts = {}
        for (const k of Object.values(OUTCOME)) this.counts[k] = 0

        // Last N records for HUD display
        this.recentSuccesses = []
        this.recentFailures = []
        this.totalRecords = 0

        // Raw timing arrays — only for records that reached eth_call
        // (i.e. not ECONOMIC_FILTER or STALE, which never touch the RPC)
        this._preflightLatencies = []   // ms for eth_call round-trip
        this._opportunityAges = []      // ms from opportunity.createdAt to eth_call completion
        // All opportunity ages (including pre-eth_call rejections)
        this._allOpportunityAges = []

        // Ensure data dir exists
        try {
            const dir = path.dirname(this.logPath)
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        } catch (e) {}

        if (options.loadExisting !== false) {
            this._loadExistingRecords()
        }
    }

    /**
     * Replay existing records from logPath on startup so campaign stats persist across restarts.
     */
    _loadExistingRecords() {
        try {
            if (!fs.existsSync(this.logPath)) return
            const content = fs.readFileSync(this.logPath, 'utf8')
            const lines = content.split('\n').filter(Boolean)
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line)
                    const outcome = entry.outcome
                    if (!outcome || !this.counts.hasOwnProperty(outcome)) continue
                    this.counts[outcome] = (this.counts[outcome] || 0) + 1
                    this.totalRecords++

                    const reachedEthCall = ![
                        OUTCOME.ECONOMIC_FILTER, OUTCOME.STALE, OUTCOME.BUILD_ERROR
                    ].includes(outcome)

                    if (reachedEthCall && entry.preflightLatencyMs > 0) {
                        this._preflightLatencies.push(entry.preflightLatencyMs)
                        if (this._preflightLatencies.length > 10000) this._preflightLatencies.shift()
                    }
                    if (entry.opportunityAgeMs >= 0) {
                        this._allOpportunityAges.push(entry.opportunityAgeMs)
                        if (this._allOpportunityAges.length > 10000) this._allOpportunityAges.shift()
                    }
                    if (reachedEthCall && entry.opportunityAgeMs >= 0) {
                        this._opportunityAges.push(entry.opportunityAgeMs)
                        if (this._opportunityAges.length > 10000) this._opportunityAges.shift()
                    }

                    if (outcome === OUTCOME.SUCCESS) {
                        this.recentSuccesses.unshift(entry)
                        if (this.recentSuccesses.length > 10) this.recentSuccesses.pop()
                    } else if (outcome !== OUTCOME.ECONOMIC_FILTER) {
                        this.recentFailures.unshift(entry)
                        if (this.recentFailures.length > 10) this.recentFailures.pop()
                    }
                } catch (parseErr) {}
            }
        } catch (e) {}
    }

    /**
     * Record a preflight campaign entry.
     *
     * @param {Object} receipt       - Result from controller.processOpportunity()
     * @param {Object} opportunity   - Original opportunity object
     * @param {Object} flashParams   - flash params from the builder (or null if build failed)
     * @param {Object} preflightMeta - { preflightLatencyMs, revertReason, estimatedGas, fingerprintHash, stateVersion }
     * @returns {Object} The recorded campaign entry
     */
    record(receipt, opportunity, flashParams, preflightMeta = {}) {
        const outcome = classifyOutcome(receipt, preflightMeta.revertReason)
        this.counts[outcome] = (this.counts[outcome] || 0) + 1
        this.totalRecords++

        const fp = flashParams || {}
        const opp = opportunity || {}

        const entry = {
            ts:                  Date.now(),
            outcome,

            // Route identity
            routeId:             opp.routeId || opp.route || opp.id || '',

            // Pool addresses
            flashPool:           String(fp.flashPool || receipt?.flashPool || '').toLowerCase(),
            swapPool1:           String(fp.swapPool1 || opp.buyPool?.address || '').toLowerCase(),
            swapPool2:           String(fp.swapPool2 || opp.sellPool?.address || '').toLowerCase(),

            // Amounts (all as decimal strings for JSON safety)
            borrowAmount:        fp.borrowAmount != null ? fp.borrowAmount.toString() : '0',
            expectedRepayment:   fp.expectedRepayment != null ? fp.expectedRepayment.toString() : '0',
            minProfitSurplus:    fp.minProfitSurplus != null ? fp.minProfitSurplus.toString() : '0',

            // Gas
            gasLimit:            receipt?.gasLimit || (fp.gasLimit ? fp.gasLimit.toString() : '650000'),

            // Fingerprint & state
            fingerprintHash:     receipt?.fingerprintHash || preflightMeta.fingerprintHash || '',
            stateVersion:        preflightMeta.stateVersion !== undefined
                                     ? preflightMeta.stateVersion
                                     : (opp.stateVersion || -1),

            // Timing
            opportunityAgeMs:    preflightMeta.opportunityAgeMs !== undefined
                                     ? preflightMeta.opportunityAgeMs
                                     : (opp.createdAt ? Date.now() - opp.createdAt : -1),
            preflightLatencyMs:  preflightMeta.preflightLatencyMs || 0,

            // On-chain result
            revertReason:        preflightMeta.revertReason || receipt?.revertReason || '',
            estimatedGas:        preflightMeta.estimatedGas ? preflightMeta.estimatedGas.toString() : '',

            // Economic
            expectedNetProfitUsd: opp.peakNetProfitUsd ?? opp.expectedNetProfitUsd ?? 0,
            optimalSizeUsd:       opp.optimalSizeUsd || 0
        }

        // Persist to JSONL (best-effort, never blocks the hot path)
        try {
            fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf8')
        } catch (e) {}

        // Accumulate timing samples for percentile computation
        // Only track latency for candidates that actually reached eth_call
        const reachedEthCall = ![
            OUTCOME.ECONOMIC_FILTER, OUTCOME.STALE, OUTCOME.BUILD_ERROR
        ].includes(outcome)

        if (reachedEthCall && entry.preflightLatencyMs > 0) {
            this._preflightLatencies.push(entry.preflightLatencyMs)
            // Cap at 10k samples to bound memory
            if (this._preflightLatencies.length > 10000) this._preflightLatencies.shift()
        }
        if (entry.opportunityAgeMs >= 0) {
            this._allOpportunityAges.push(entry.opportunityAgeMs)
            if (this._allOpportunityAges.length > 10000) this._allOpportunityAges.shift()
        }
        if (reachedEthCall && entry.opportunityAgeMs >= 0) {
            this._opportunityAges.push(entry.opportunityAgeMs)
            if (this._opportunityAges.length > 10000) this._opportunityAges.shift()
        }

        // Maintain rolling windows for HUD
        if (outcome === OUTCOME.SUCCESS) {
            this.recentSuccesses.unshift(entry)
            if (this.recentSuccesses.length > 10) this.recentSuccesses.pop()
        } else if (outcome !== OUTCOME.ECONOMIC_FILTER) {
            this.recentFailures.unshift(entry)
            if (this.recentFailures.length > 10) this.recentFailures.pop()
        }

        if (this.verbose) {
            const tag = outcome === OUTCOME.SUCCESS
                ? '\x1b[92m✓\x1b[0m'
                : outcome === OUTCOME.ECONOMIC_FILTER
                    ? '\x1b[90m–\x1b[0m'
                    : '\x1b[91m✗\x1b[0m'
            console.log(
                `[campaign] ${tag} ${outcome.padEnd(32)} ` +
                `route=${entry.routeId.slice(0, 28).padEnd(28)} ` +
                `profit=$${entry.expectedNetProfitUsd.toFixed(2).padStart(6)} ` +
                `age=${entry.opportunityAgeMs.toFixed(0).padStart(5)}ms ` +
                `pflt=${entry.preflightLatencyMs.toFixed(0).padStart(5)}ms` +
                (entry.revertReason ? `  revert=${entry.revertReason}` : '') +
                (entry.fingerprintHash ? `  fp=${entry.fingerprintHash.slice(0, 12)}` : '')
            )
        }

        return entry
    }

    /**
     * Returns a summary object suitable for HUD rendering.
     * Includes four key ratios and P50/P90/P99 latency percentiles.
     */
    getSummary() {
        const total = this.totalRecords
        const successCount      = this.counts[OUTCOME.SUCCESS] || 0
        const revertCount       = (this.counts[OUTCOME.INSUFFICIENT_PROFIT] || 0) +
                                  (this.counts[OUTCOME.LOK] || 0) +
                                  (this.counts[OUTCOME.OTHER_REVERT] || 0)
        const insufficientCount = this.counts[OUTCOME.INSUFFICIENT_PROFIT] || 0
        const stateDivCount     = this.counts[OUTCOME.STATE_DIVERGED] || 0
        const fpFailCount       = this.counts[OUTCOME.FINGERPRINT_FAILED] || 0
        const staleCount        = (this.counts[OUTCOME.STALE] || 0)

        // Denominator: candidates that actually reached eth_call
        const reachedEthCall = total
            - (this.counts[OUTCOME.ECONOMIC_FILTER] || 0)
            - (this.counts[OUTCOME.STALE] || 0)
            - (this.counts[OUTCOME.BUILD_ERROR] || 0)

        // ── Key campaign ratios ───────────────────────────────────────────────
        // 1. Preflight success rate  =  SUCCESS / candidates reaching eth_call
        const preflightSuccessRate = reachedEthCall > 0
            ? (successCount / reachedEthCall * 100).toFixed(1)
            : '0.0'

        // 2. State divergence rate   =  STATE_DIVERGED / successful preflights
        const stateDivRate = successCount > 0
            ? (stateDivCount / successCount * 100).toFixed(1)
            : '0.0'

        // 3. Insufficient-profit rate = INSUFFICIENT / candidates reaching eth_call
        const insufficientRate = reachedEthCall > 0
            ? (insufficientCount / reachedEthCall * 100).toFixed(1)
            : '0.0'

        // 4. Fingerprint failure rate  (should be 0.0%)
        const fpFailRate = reachedEthCall > 0
            ? (fpFailCount / reachedEthCall * 100).toFixed(1)
            : '0.0'

        // Overall pass rate across all records (for the header badge)
        const successRate = total > 0 ? (successCount / total * 100).toFixed(1) : '0.0'

        return {
            total,
            successCount,
            revertCount,
            staleCount,
            reachedEthCall,
            successRate,
            // Four key ratios
            ratios: {
                preflightSuccessRate,
                stateDivRate,
                insufficientRate,
                fpFailRate
            },
            counts: { ...this.counts },
            // P50/P90/P99 timing percentiles
            preflightLatencyPct: percentiles(this._preflightLatencies),
            opportunityAgePct:   percentiles(this._opportunityAges),
            recentSuccesses: this.recentSuccesses.slice(0, 5),
            recentFailures:  this.recentFailures.slice(0, 5)
        }
    }

    /**
     * Resets all counters and clears rolling windows (used in tests).
     */
    reset() {
        for (const k of Object.values(OUTCOME)) this.counts[k] = 0
        this.recentSuccesses = []
        this.recentFailures = []
        this.totalRecords = 0
        this._preflightLatencies = []
        this._opportunityAges = []
        this._allOpportunityAges = []
    }
}

// Singleton instance for use across the live trader process
const campaignLogger = new PreflightCampaign({ verbose: true })

module.exports = { PreflightCampaign, campaignLogger, classifyOutcome, OUTCOME }
