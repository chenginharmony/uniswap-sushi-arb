'use strict'

const { buildFlashArbitrageTransaction } = require('./builder')
const { preflightSimulation } = require('./preflight')
const { NonceManager } = require('./nonce_manager')
const { IsolatedSigner } = require('./signer')
const { buildFingerprint, verifyFingerprintParity, formatFingerprintLog } = require('./fingerprint')
const { campaignLogger } = require('../monitoring/preflight_campaign')

/**
 * @title ExecutionController
 * @notice Orchestrates the production pre-execution lifecycle for Uniswap V3 flash arbitrage.
 * Revalidates state, enforces profit/size gates, performs eth_call preflight, acquires nonces,
 * and maintains strict dry-run broadcast safety.
 */
class ExecutionController {
    constructor(options = {}) {
        this.config = options.config || {}
        this.rpcUrl = options.rpcUrl || (this.config.base && this.config.base.rpcUrl) || 'https://mainnet.base.org'
        this.maxSizeUsd = options.maxSizeUsd !== undefined
            ? options.maxSizeUsd
            : (this.config.maxSizeUsd || (process.env.MAX_SIZE_USD ? Number(process.env.MAX_SIZE_USD) : 25000))
        this.minProfitUsd = options.minProfitUsd !== undefined
            ? options.minProfitUsd
            : (this.config.minNetProfitUsd !== undefined ? this.config.minNetProfitUsd : 0.01)
        this.maxOpportunityAgeMs = options.maxOpportunityAgeMs || (this.config.maxOpportunityAgeMs || 300)
        
        this.nonceManager = options.nonceManager || new NonceManager({
            rpcUrl: this.rpcUrl,
            walletAddress: options.walletAddress
        })
        
        this.dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : (this.config.dryRun !== undefined ? Boolean(this.config.dryRun) : true)
        this.executionEnabled = options.executionEnabled !== undefined ? Boolean(options.executionEnabled) : Boolean(this.config.executionEnabled)

        const { Broadcaster } = require('./broadcaster')
        this.broadcaster = options.broadcaster || new Broadcaster({ rpcUrls: options.rpcUrls || [this.rpcUrl] })

        this.signer = options.signer || new IsolatedSigner({
            dryRun: this.dryRun,
            executionEnabled: this.executionEnabled,
            walletAddress: options.walletAddress
        })

        this.preflight = options.preflight || preflightSimulation
        this.revalidateState = options.revalidateState || null
        this.executionLogs = []
        // Allow tests to inject a mock campaign logger; production uses the singleton
        this.campaign = options.campaign || campaignLogger
    }

    /**
     * Evaluates and processes an opportunity through the 7 pre-execution gates.
     *
     * @param {Object} opportunity - The opportunity candidate from the scanner
     * @param {Object} context - Current environment context (stateVersion, now, etc.)
     * @returns {Promise<Object>} Execution controller decision and dry-run receipt
     */
    async processOpportunity(opportunity, context = {}) {
        // Gate 1: Profitable status check
        if (!opportunity || !opportunity.profitable || (opportunity.status && opportunity.status !== 'PROFITABLE')) {
            const res = {
                executed: false,
                reason: 'NOT_PROFITABLE',
                status: opportunity ? opportunity.status : 'NULL_OPPORTUNITY'
            }
            this.campaign.record(res, opportunity, null, {})
            return res
        }

        // Gate 2: Freshness check (age + state version)
        const now = context.now || Date.now()
        const createdAt = opportunity.createdAt || now
        const ageMs = now - createdAt

        if (ageMs > this.maxOpportunityAgeMs) {
            const res = { executed: false, reason: 'OPPORTUNITY_STALE', ageMs, maxAgeMs: this.maxOpportunityAgeMs }
            this.campaign.record(res, opportunity, null, {
                opportunityAgeMs: ageMs,
                stateVersion: context.currentVersion !== undefined ? context.currentVersion : opportunity.stateVersion
            })
            return res
        }

        if (context.currentVersion !== undefined && opportunity.stateVersion !== undefined) {
            if (opportunity.stateVersion !== context.currentVersion) {
                const res = {
                    executed: false,
                    reason: 'STATE_VERSION_DIVERGED',
                    expectedVersion: context.currentVersion,
                    opportunityVersion: opportunity.stateVersion
                }
                this.campaign.record(res, opportunity, null, {
                    opportunityAgeMs: ageMs,
                    stateVersion: context.currentVersion
                })
                return res
            }
        }

        // Gate 3: Maximum size and minimum profit limits
        const sizeUsd = opportunity.optimalSizeUsd || opportunity.inputSizeUsd || 25
        if (sizeUsd > this.maxSizeUsd) {
            return {
                executed: false,
                reason: 'EXCEEDS_MAX_SIZE_LIMIT',
                sizeUsd,
                maxSizeUsd: this.maxSizeUsd
            }
        }

        const netProfitUsd = opportunity.peakNetProfitUsd !== undefined ? opportunity.peakNetProfitUsd : opportunity.expectedNetProfitUsd
        if (netProfitUsd < this.minProfitUsd) {
            return {
                executed: false,
                reason: 'BELOW_MIN_PROFIT_THRESHOLD',
                netProfitUsd,
                minProfitUsd: this.minProfitUsd
            }
        }

        // Gate 4: State Revalidation (Verify spread still exists immediately before dispatch)
        if (typeof this.revalidateState === 'function') {
            const reval = await this.revalidateState(opportunity)
            if (!reval.valid) {
                return {
                    executed: false,
                    reason: 'STATE_REVALIDATION_FAILED',
                    detail: reval.reason || 'Prices moved before execution'
                }
            }
            if (reval.recalculatedNetProfitUsd !== undefined && reval.recalculatedNetProfitUsd < this.minProfitUsd) {
                return {
                    executed: false,
                    reason: 'RECALCULATED_PROFIT_INSUFFICIENT',
                    recalculatedProfit: reval.recalculatedNetProfitUsd,
                    minProfitUsd: this.minProfitUsd
                }
            }
        }

        // Gate 5: Construct Transaction Calldata
        const txBuild = buildFlashArbitrageTransaction(opportunity, {
            dryRun: this.dryRun,
            executionEnabled: this.executionEnabled,
            minNetProfitUsd: this.minProfitUsd,
            arbitrageContractAddress: this.config.arbitrageContractAddress || '0x0000000000000000000000000000000000000000'
        })
        if (context.profiler && context.traceId) context.profiler.mark(context.traceId, 'built')

        // ─────────────────────────────────────────────────────────────────────────────
        // Phase 4 Gate A: PRE-PREFLIGHT FINGERPRINT
        // Capture the canonical trade fingerprint BEFORE eth_call. This is the
        // ground truth for the trade. Every field that follows must remain
        // byte-for-byte identical until broadcast.
        // ─────────────────────────────────────────────────────────────────────────────
        const preflightStateVersion = typeof context.getStateVersion === 'function'
            ? context.getStateVersion()
            : (context.currentVersion !== undefined ? context.currentVersion : opportunity.stateVersion)

        const preflightFingerprint = buildFingerprint(
            txBuild.flashParams,
            txBuild.unsignedTransaction,
            {
                routeId: opportunity.routeId || opportunity.route || opportunity.id,
                stateVersion: preflightStateVersion
            }
        )
        console.log(formatFingerprintLog(preflightFingerprint, 'PRE-PREFLIGHT'))

        // Gate 6: eth_call Preflight Simulation (Verify transaction would succeed without reverting)
        const _preflightT0 = Date.now()
        const preflightResult = await this.preflight(txBuild.unsignedTransaction, this.rpcUrl)
        const _preflightLatencyMs = Date.now() - _preflightT0

        if (!preflightResult.success || preflightResult.reverted) {
            if (context.profiler && context.traceId) {
                context.profiler.mark(context.traceId, 'preflighted')
                context.profiler.endTrace(context.traceId, { status: 'PREFLIGHT_REVERTED', error: preflightResult.revertReason })
            }
            const res = {
                executed: false,
                reason: 'PREFLIGHT_SIMULATION_REVERTED',
                revertReason: preflightResult.revertReason || preflightResult.error || 'PREFLIGHT_FAILED'
            }
            this.campaign.record(res, opportunity, txBuild.flashParams, {
                preflightLatencyMs: _preflightLatencyMs,
                revertReason: res.revertReason,
                stateVersion: preflightStateVersion,
                opportunityAgeMs: ageMs,
                fingerprintHash: preflightFingerprint.hash
            })
            return res
        }
        if (context.profiler && context.traceId) context.profiler.mark(context.traceId, 'preflighted')

        // ─────────────────────────────────────────────────────────────────────────────
        // Phase 4 Gate B: POST-PREFLIGHT STATE-VERSION DIVERGENCE
        // The eth_call RPC round-trip may take 10–50 ms. A new Flashblock can arrive
        // and update pool state in that window. If the state version has changed,
        // the opportunity is now stale relative to the simulation. ABORT.
        // ─────────────────────────────────────────────────────────────────────────────
        if (typeof context.getStateVersion === 'function') {
            const postPreflightVersion = context.getStateVersion()
            if (postPreflightVersion !== preflightStateVersion) {
                console.warn(
                    `[controller] ABORT: State version changed during eth_call. ` +
                    `preflight=${preflightStateVersion} current=${postPreflightVersion}. ` +
                    `The chain moved while we were simulating — aborting.`
                )
                const res = {
                    executed: false,
                    reason: 'STATE_VERSION_DIVERGED_POST_PREFLIGHT',
                    preflightStateVersion,
                    currentStateVersion: postPreflightVersion
                }
                this.campaign.record(res, opportunity, txBuild.flashParams, {
                    preflightLatencyMs: _preflightLatencyMs,
                    stateVersion: preflightStateVersion,
                    opportunityAgeMs: ageMs,
                    estimatedGas: preflightResult.estimatedGas,
                    fingerprintHash: preflightFingerprint.hash
                })
                return res
            }
        }

        // Dynamic Gas Sizing: apply 25% safety buffer clamped to [450k, 700k]
        // IMPORTANT: gasLimit is the only field the controller is allowed to update
        // after eth_call. After this update, a fresh signing fingerprint is computed
        // and verified for parity with the pre-preflight fingerprint (minus gasLimit).
        if (preflightResult.estimatedGas) {
            const est = Number(preflightResult.estimatedGas)
            const withBuffer = Math.floor(est * 1.25)
            const clamped = Math.min(700000, Math.max(450000, withBuffer))
            txBuild.unsignedTransaction.gasLimit = BigInt(clamped)
        } else if (!txBuild.unsignedTransaction.gasLimit) {
            txBuild.unsignedTransaction.gasLimit = 650000n
        }

        // ─────────────────────────────────────────────────────────────────────────────
        // Phase 4 Gate C: PRE-SIGNING FINGERPRINT & BYTE-EXACT PARITY ASSERTION
        // Recompute the fingerprint with the final gas limit. Verify that EVERY field
        // other than gasLimit is identical to the pre-preflight capture. Calldata must
        // be byte-for-byte identical. Any mutation — no matter how small — is fatal.
        // ─────────────────────────────────────────────────────────────────────────────
        const signingFingerprint = buildFingerprint(
            txBuild.flashParams,
            txBuild.unsignedTransaction,
            {
                routeId: opportunity.routeId || opportunity.route || opportunity.id,
                stateVersion: preflightStateVersion
            }
        )
        console.log(formatFingerprintLog(signingFingerprint, 'PRE-SIGNING '))

        // Verify parity on all fields EXCEPT gasLimit (which may be updated by gas estimation)
        const parityFields = ['calldata', 'flashPool', 'swapPool1', 'swapPool2',
            'tokenIn', 'tokenOut', 'borrowAmount', 'amountOutMinLeg1', 'amountOutMinLeg2',
            'expectedRepayment', 'minProfitSurplus', 'maxFeePerGas', 'maxPriorityFeePerGas']

        const calldataMutation = preflightFingerprint.fields.calldata !== signingFingerprint.fields.calldata
        const paramMutations = parityFields.filter(
            k => String(preflightFingerprint.fields[k]) !== String(signingFingerprint.fields[k])
        )

        if (calldataMutation || paramMutations.length > 0) {
            const diverged = calldataMutation ? ['calldata', ...paramMutations] : paramMutations
            console.error(
                `[controller] FINGERPRINT_PARITY_FAILED: diverged fields=[${diverged.join(', ')}]\n` +
                `  preflightHash=${preflightFingerprint.hash}\n` +
                `  signingHash=${signingFingerprint.hash}`
            )
            const res = {
                executed: false,
                reason: 'FINGERPRINT_PARITY_FAILED',
                divergedFields: diverged,
                preflightHash: preflightFingerprint.hash,
                signingHash: signingFingerprint.hash
            }
            this.campaign.record(res, opportunity, txBuild.flashParams, {
                preflightLatencyMs: _preflightLatencyMs,
                stateVersion: preflightStateVersion,
                opportunityAgeMs: ageMs,
                estimatedGas: preflightResult.estimatedGas,
                fingerprintHash: preflightFingerprint.hash
            })
            return res
        }

        const parityReport = verifyFingerprintParity(preflightFingerprint, signingFingerprint)
        console.log(
            `[controller] ✓ FINGERPRINT PARITY VERIFIED hash=${preflightFingerprint.hash.slice(0, 16)}... ` +
            `latency=${parityReport.latencyMs}ms`
        )

        // Gate 7: Atomic Nonce Acquisition & Preparation
        const nonce = await this.nonceManager.acquire({
            opportunityId: opportunity.id || opportunity.opportunityId,
            route: opportunity.route || opportunity.routeId
        })

        try {
            const prep = await this.signer.prepareTransaction(txBuild.unsignedTransaction, nonce)
            if (context.profiler && context.traceId) context.profiler.mark(context.traceId, 'signed')

            // Gate 8: Real On-Chain Broadcast (Live execution mode)
            if (!this.dryRun && this.executionEnabled && prep.isSigned && prep.rawTransaction) {
                const broadcastRes = await this.broadcaster.broadcastRawTransaction(prep.rawTransaction)
                if (context.profiler && context.traceId) context.profiler.mark(context.traceId, 'broadcasted')
                const receipt = {
                    executed: true,
                    simulated: true,
                    broadcast: true,
                    mode: 'LIVE_BROADCAST',
                    transactionHash: broadcastRes.transactionHash,
                    nonce,
                    opportunityId: opportunity.id || opportunity.opportunityId,
                    optimalSizeUsd: sizeUsd,
                    expectedNetProfitUsd: netProfitUsd,
                    calldataSelector: txBuild.unsignedTransaction.data.slice(0, 10),
                    chainId: prep.transaction.chainId,
                    preflightPassed: true,
                    fingerprintParity: true,
                    fingerprintHash: preflightFingerprint.hash,
                    submittedAt: broadcastRes.submittedAt,
                    rpcUrl: broadcastRes.rpcUrl,
                    gasLimit: txBuild.unsignedTransaction.gasLimit ? txBuild.unsignedTransaction.gasLimit.toString() : '650000',
                    estimatedGas: preflightResult.estimatedGas ? preflightResult.estimatedGas.toString() : null,
                    timestamp: Date.now()
                }

                const confirmation = await this.broadcaster.waitForReceipt(broadcastRes.transactionHash)
                if (context.profiler && context.traceId) {
                    context.profiler.mark(context.traceId, 'confirmed')
                    context.profiler.endTrace(context.traceId, { status: confirmation.status, txHash: broadcastRes.transactionHash, profitUsd: netProfitUsd })
                }
                receipt.confirmed = confirmation.confirmed
                receipt.status = confirmation.status
                receipt.blockNumber = confirmation.blockNumber
                receipt.gasUsed = confirmation.gasUsed

                if (confirmation.status === 'SUCCESS') {
                    this.nonceManager.confirm(nonce)
                } else {
                    this.nonceManager.release(nonce)
                }

                this.executionLogs.unshift(receipt)
                if (this.executionLogs.length > 50) this.executionLogs.pop()
                this.campaign.record(receipt, opportunity, txBuild.flashParams, {
                    preflightLatencyMs: _preflightLatencyMs,
                    stateVersion: preflightStateVersion,
                    opportunityAgeMs: ageMs,
                    estimatedGas: preflightResult.estimatedGas,
                    fingerprintHash: preflightFingerprint.hash
                })
                return receipt
            }

            // Dry-Run Mode Receipt
            const receipt = {
                executed: true,
                simulated: true,
                broadcast: false,
                mode: 'DRY_RUN_VERIFIED',
                nonce,
                opportunityId: opportunity.id || opportunity.opportunityId,
                optimalSizeUsd: sizeUsd,
                expectedNetProfitUsd: netProfitUsd,
                calldataSelector: txBuild.unsignedTransaction.data.slice(0, 10),
                chainId: prep.transaction.chainId,
                gasLimit: txBuild.unsignedTransaction.gasLimit ? txBuild.unsignedTransaction.gasLimit.toString() : '650000',
                estimatedGas: preflightResult.estimatedGas ? preflightResult.estimatedGas.toString() : null,
                preflightPassed: true,
                fingerprintParity: true,
                fingerprintHash: preflightFingerprint.hash,
                timestamp: Date.now()
            }

            if (context.profiler && context.traceId) {
                context.profiler.mark(context.traceId, 'signed')
                context.profiler.endTrace(context.traceId, { status: 'DRY_RUN_VERIFIED', profitUsd: netProfitUsd })
            }

            this.nonceManager.confirm(nonce)
            this.executionLogs.unshift(receipt)
            if (this.executionLogs.length > 50) this.executionLogs.pop()
            this.campaign.record(receipt, opportunity, txBuild.flashParams, {
                preflightLatencyMs: _preflightLatencyMs,
                stateVersion: preflightStateVersion,
                opportunityAgeMs: ageMs,
                estimatedGas: preflightResult.estimatedGas,
                fingerprintHash: preflightFingerprint.hash
            })

            return receipt
        } catch (err) {
            if (context.profiler && context.traceId) {
                context.profiler.endTrace(context.traceId, { status: 'SIGNER_ERROR', error: err.message })
            }
            this.nonceManager.release(nonce)
            return {
                executed: false,
                reason: 'SIGNER_PREPARATION_ERROR',
                error: err.message
            }
        }
    }

    getExecutionLogs() {
        return this.executionLogs
    }
}

module.exports = { ExecutionController }
