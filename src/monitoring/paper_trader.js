'use strict'

const fs = require('fs')
const path = require('path')
const { ExecutionController } = require('../execution/controller')
const { BASE_ROUTERS } = require('../execution/builder')

const DEFAULT_RPC_URLS = [
    'https://base-rpc.publicnode.com',
    'https://1rpc.io/base',
    'https://mainnet.base.org'
]

const DATA_DIR = path.join(__dirname, '..', '..', 'data')
const DEFAULT_LOG_FILE = path.join(DATA_DIR, 'paper_trades.jsonl')
const DEPLOYMENT_FILE = path.join(__dirname, '..', '..', 'deployments', 'base_mainnet.json')

class PaperTrader {
    constructor(options = {}) {
        this.config = options.config || {}
        this.rpcUrls = options.rpcUrls ||
            (this.config.base && this.config.base.rpcUrls) ||
            DEFAULT_RPC_URLS
        this.rpcUrl = this.rpcUrls[0]

        // Load deployed contract address
        let contractAddress = options.contractAddress || (this.config.arbitrageContractAddress)
        if (!contractAddress && fs.existsSync(DEPLOYMENT_FILE)) {
            try {
                const dep = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'))
                contractAddress = dep.address
            } catch (e) {}
        }
        this.contractAddress = contractAddress || '0x4b76f5deb442d9D3EB59A0545Ce603003Cd57575'

        this.logFile = options.logFile || DEFAULT_LOG_FILE
        this.controller = options.controller || new ExecutionController({
            config: {
                arbitrageContractAddress: this.contractAddress,
                dryRun: true,
                executionEnabled: false,
                minNetProfitUsd: options.minProfitUsd || this.config.minNetProfitUsd || 0.10
            },
            rpcUrl: this.rpcUrl,
            maxSizeUsd: options.maxSizeUsd || (process.env.MAX_SIZE_USD ? Number(process.env.MAX_SIZE_USD) : 20000),
            minProfitUsd: options.minProfitUsd || 0.10,
            maxOpportunityAgeMs: options.maxOpportunityAgeMs || 500
        })

        this.trades = []
        this.metrics = {
            totalEvaluated: 0,
            preflightPassed: 0,
            preflightFailed: 0,
            stateInvalidated: 0,
            spreadEvaporated: 0,
            hypotheticalProfitUsd: 0.0,
            grossEdgeUsd: 0.0,
            flashFeesUsd: 0.0,
            gasCostUsd: 0.0
        }

        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true })
        }
    }

    async rpcCall(method, params = []) {
        for (const url of this.rpcUrls) {
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
                })
                const data = await res.json()
                if (data && data.result !== undefined) return data.result
            } catch (e) {}
        }
        return null
    }

    /**
     * Calculates flash loan fee for Uniswap V3 pool:
     * fee = ceil(amount * feeTier / 1,000,000)
     */
    calculateFlashFee(amountTokens, feeTier, tokenPriceUsd = 2600) {
        const feeTierNum = Number(feeTier) || 500
        const flashFeeTokens = (amountTokens * feeTierNum) / 1000000
        const flashFeeUsd = flashFeeTokens * tokenPriceUsd
        return { flashFeeTokens, flashFeeUsd }
    }

    /**
     * Evaluates a candidate arbitrage opportunity through the complete paper execution pipeline:
     * 1. Measures detectionToQuote latency
     * 2. Calculates optimal size & economics (gross edge, flash fee, gas, net edge)
     * 3. Executes controller Gates (state revalidation, eth_call preflight, nonce assignment)
     * 4. Measures quoteToPreflight & total latency
     * 5. Checks subsequent block spread status (spread evaporation)
     * 6. Writes JSONL telemetry record
     */
    async processPaperTrade(opportunity, context = {}) {
        const tDetect = context.detectedAtNs || process.hrtime.bigint()
        this.metrics.totalEvaluated++

        const tokenPriceUsd = opportunity.tokenUsdPrice || 2600
        const sizeTokens = opportunity.optimalSizeTokens || opportunity.inputSize || 0.1
        const sizeUsd = opportunity.optimalSizeUsd || (sizeTokens * tokenPriceUsd)
        
        // Fee calculation
        const poolFee = (opportunity.buyPool && (opportunity.buyPool.feeTier || opportunity.buyPool.feeBps * 100)) || 500
        const { flashFeeTokens, flashFeeUsd } = this.calculateFlashFee(sizeTokens, poolFee, tokenPriceUsd)
        
        // Gas estimation for Base L2 (average ~250,000 - 350,000 gas units, $0.02 - $0.05 on Base)
        const gasEstimateUnits = 285000
        const gasCostUsd = this.config.gasCostUsd || 0.04

        const grossEdgeUsd = opportunity.expectedGrossProfitUsd ||
            Math.max(0, (opportunity.expectedFinalOutputUsd || (sizeUsd * 1.002)) - sizeUsd)
        const netEdgeUsd = Math.max(0, grossEdgeUsd - flashFeeUsd - gasCostUsd)

        const tQuote = process.hrtime.bigint()
        const detectionToQuoteMs = Number(tQuote - tDetect) / 1e6

        // Invoke 7-Gate Pre-Execution Controller
        const controllerDecision = await this.controller.processOpportunity(opportunity, {
            now: Date.now(),
            currentVersion: context.currentVersion
        })

        const tPreflight = process.hrtime.bigint()
        const quoteToPreflightMs = Number(tPreflight - tQuote) / 1e6
        const totalLatencyMs = Number(tPreflight - tDetect) / 1e6

        const preflightPassed = Boolean(controllerDecision.executed && controllerDecision.preflightPassed)
        const stateInvalidated = controllerDecision.reason === 'STATE_VERSION_DIVERGED' ||
            controllerDecision.reason === 'STATE_REVALIDATION_FAILED'

        if (preflightPassed) {
            this.metrics.preflightPassed++
            this.metrics.hypotheticalProfitUsd += netEdgeUsd
            this.metrics.grossEdgeUsd += grossEdgeUsd
            this.metrics.flashFeesUsd += flashFeeUsd
            this.metrics.gasCostUsd += gasCostUsd
        } else {
            this.metrics.preflightFailed++
            if (stateInvalidated) {
                this.metrics.stateInvalidated++
            }
        }

        // Assess spread evaporation status
        // An opportunity whose spread has evaporated returns non-positive revalidated net edge
        let spreadEvaporated = false
        if (context.subsequentSpreadBps !== undefined && context.initialSpreadBps !== undefined) {
            spreadEvaporated = context.subsequentSpreadBps < (context.initialSpreadBps * 0.5)
            if (spreadEvaporated) this.metrics.spreadEvaporated++
        }

        const telemetryRecord = {
            timestamp: Date.now(),
            opportunityId: opportunity.id || `opp-${Date.now()}-${this.metrics.totalEvaluated}`,
            route: opportunity.route || `${opportunity.buyPool?.dex || 'dex1'}->${opportunity.sellPool?.dex || 'dex2'}`,
            pair: opportunity.pair || 'WETH/USDC',
            buyPool: opportunity.buyPool ? { address: opportunity.buyPool.address, dex: opportunity.buyPool.dex, feeTier: opportunity.buyPool.feeTier } : null,
            sellPool: opportunity.sellPool ? { address: opportunity.sellPool.address, dex: opportunity.sellPool.dex, feeTier: opportunity.sellPool.feeTier } : null,
            optimalSizeTokens: Number(sizeTokens.toFixed(6)),
            optimalSizeUsd: Number(sizeUsd.toFixed(2)),
            grossEdgeUsd: Number(grossEdgeUsd.toFixed(4)),
            flashFeeTokens: Number(flashFeeTokens.toFixed(8)),
            flashFeeUsd: Number(flashFeeUsd.toFixed(4)),
            gasEstimateUnits,
            gasCostUsd: Number(gasCostUsd.toFixed(4)),
            netEdgeUsd: Number(netEdgeUsd.toFixed(4)),
            latencies: {
                detectionToQuoteMs: Number(detectionToQuoteMs.toFixed(2)),
                quoteToPreflightMs: Number(quoteToPreflightMs.toFixed(2)),
                totalLatencyMs: Number(totalLatencyMs.toFixed(2))
            },
            preflight: {
                passed: preflightPassed,
                reason: controllerDecision.reason || (preflightPassed ? 'SUCCESS' : 'UNKNOWN'),
                revertReason: controllerDecision.revertReason || null,
                nonce: controllerDecision.nonce !== undefined ? controllerDecision.nonce : null
            },
            state: {
                stateInvalidated,
                spreadEvaporated,
                stateVersion: context.currentVersion || 1
            },
            capturedProfitUsd: preflightPassed ? Number(netEdgeUsd.toFixed(4)) : 0.0,
            dryRun: true
        }

        // Persist JSONL record
        this.writeTelemetryRecord(telemetryRecord)
        this.trades.unshift(telemetryRecord)
        if (this.trades.length > 200) this.trades.pop()

        return telemetryRecord
    }

    writeTelemetryRecord(record) {
        try {
            fs.appendFileSync(this.logFile, JSON.stringify(record) + '\n', 'utf8')
        } catch (err) {
            console.error('[PAPER_TRADER] Failed to write JSONL telemetry:', err.message)
        }
    }

    getMetrics() {
        const total = this.metrics.totalEvaluated
        const passRate = total > 0 ? ((this.metrics.preflightPassed / total) * 100).toFixed(1) : '0.0'
        const invalidationRate = total > 0 ? ((this.metrics.stateInvalidated / total) * 100).toFixed(1) : '0.0'
        const evaporationRate = total > 0 ? ((this.metrics.spreadEvaporated / total) * 100).toFixed(1) : '0.0'

        return {
            ...this.metrics,
            preflightPassRatePct: Number(passRate),
            stateInvalidationRatePct: Number(invalidationRate),
            spreadEvaporationRatePct: Number(evaporationRate)
        }
    }

    getRecentTrades(limit = 10) {
        return this.trades.slice(0, limit)
    }
}

module.exports = { PaperTrader, DEFAULT_LOG_FILE }
