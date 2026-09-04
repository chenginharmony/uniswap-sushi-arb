'use strict'

const crypto = require('crypto')

/**
 * @title ExecutionFingerprint
 * @notice Produces a canonical, deterministic 14-field execution fingerprint for a
 * flash arbitrage trade. The fingerprint captures every parameter that must remain
 * byte-for-byte identical from the moment the optimizer emits the opportunity to the
 * moment the signed calldata is submitted for broadcast.
 *
 * Usage contract:
 *  1. Call `buildFingerprint(flashParams, txData, context)` immediately BEFORE eth_call.
 *  2. Call `buildFingerprint(flashParams, txData, context)` again immediately BEFORE signing.
 *  3. Call `verifyFingerprintParity(fp1, fp2)` to assert byte-exact parity.
 *
 * If parity fails, the controller MUST abort — not retry, not re-quote.
 */

/**
 * Normalizes an Ethereum address to lowercase 0x-prefixed hex.
 * Returns '0x0000000000000000000000000000000000000000' for null/undefined.
 * @param {string} addr
 * @returns {string}
 */
function normalizeAddress(addr) {
    if (!addr || typeof addr !== 'string') return '0x0000000000000000000000000000000000000000'
    const clean = addr.trim().toLowerCase()
    return clean.startsWith('0x') ? clean : ('0x' + clean)
}

/**
 * Converts a BigInt, number, or string to a consistent decimal string.
 * @param {BigInt|number|string} val
 * @returns {string}
 */
function normalizeUint256(val) {
    if (val === null || val === undefined) return '0'
    if (typeof val === 'bigint') return val.toString(10)
    if (typeof val === 'number') return Math.floor(val).toString(10)
    if (typeof val === 'string') {
        // Accept both hex and decimal
        if (val.startsWith('0x') || val.startsWith('0X')) {
            return BigInt(val).toString(10)
        }
        return val.replace(/^0+/, '') || '0'
    }
    return String(val)
}

/**
 * Builds a deterministic execution fingerprint from flash arbitrage parameters.
 *
 * @param {Object} flashParams  - Result of buildFlashArbitrageTransaction().flashParams
 * @param {Object} txData       - Unsigned transaction payload (to, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas)
 * @param {Object} context      - Ambient context { routeId, stateVersion }
 * @returns {Object} fingerprint containing:
 *   - fields {Object}: all 14 normalized canonical fields + calldata + stateVersion
 *   - canonical {string}: deterministic JSON serialization
 *   - hash {string}: SHA-256 hex digest of the canonical JSON
 *   - capturedAt {number}: epoch ms at capture time
 */
function buildFingerprint(flashParams, txData, context = {}) {
    if (!flashParams || !txData) {
        throw new Error('FINGERPRINT_BUILD_ERROR: flashParams and txData are required')
    }

    const fields = {
        // Route identity
        routeId: String(context.routeId || flashParams.routeId || ''),

        // Pool addresses
        flashPool:  normalizeAddress(flashParams.flashPool),
        swapPool1:  normalizeAddress(flashParams.swapPool1 || context.swapPool1),
        swapPool2:  normalizeAddress(flashParams.swapPool2 || context.swapPool2),

        // Token addresses
        tokenIn:    normalizeAddress(flashParams.borrowToken),
        tokenOut:   normalizeAddress(flashParams.intermediateToken),

        // Amounts (all in uint256 base-unit strings)
        borrowAmount:       normalizeUint256(flashParams.borrowAmount),
        amountOutMinLeg1:   normalizeUint256(flashParams.minAmountOut1),
        amountOutMinLeg2:   normalizeUint256(flashParams.minAmountOut2),
        expectedRepayment:  normalizeUint256(flashParams.expectedRepayment || '0'),
        minProfitSurplus:   normalizeUint256(flashParams.minProfitSurplus),

        // Gas fields (from the frozen unsigned transaction)
        gasLimit:            normalizeUint256(txData.gasLimit),
        maxFeePerGas:        normalizeUint256(txData.maxFeePerGas || '0'),
        maxPriorityFeePerGas: normalizeUint256(txData.maxPriorityFeePerGas || '0'),

        // Exact encoded calldata — this is the ground truth
        calldata: typeof txData.data === 'string' ? txData.data.toLowerCase() : '',

        // Chain state version at time of capture
        stateVersion: context.stateVersion !== undefined ? Number(context.stateVersion) : -1
    }

    // Deterministic canonical JSON: keys are sorted alphabetically to prevent
    // key-ordering attacks or accidental reordering mutations.
    const sortedKeys = Object.keys(fields).sort()
    const canonical = JSON.stringify(
        Object.fromEntries(sortedKeys.map(k => [k, fields[k]]))
    )

    const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')

    return {
        fields,
        canonical,
        hash,
        capturedAt: Date.now()
    }
}

/**
 * Compares two fingerprints and returns a detailed parity report.
 * Both the SHA-256 hash and the raw calldata must be identical for parity to pass.
 *
 * @param {Object} fpPreflight  - Fingerprint captured before eth_call
 * @param {Object} fpSigning    - Fingerprint captured before signing
 * @returns {Object} { parity: boolean, hashMatch: boolean, calldataMatch: boolean, divergedFields: string[] }
 */
function verifyFingerprintParity(fpPreflight, fpSigning) {
    if (!fpPreflight || !fpSigning) {
        return {
            parity: false,
            hashMatch: false,
            calldataMatch: false,
            divergedFields: ['FINGERPRINT_MISSING'],
            reason: 'One or both fingerprints are null/undefined'
        }
    }

    const hashMatch = fpPreflight.hash === fpSigning.hash
    const calldataMatch = fpPreflight.fields.calldata === fpSigning.fields.calldata

    // Field-level diffing for diagnostics
    const divergedFields = []
    if (fpPreflight.fields && fpSigning.fields) {
        const allKeys = new Set([
            ...Object.keys(fpPreflight.fields),
            ...Object.keys(fpSigning.fields)
        ])
        for (const k of allKeys) {
            if (String(fpPreflight.fields[k]) !== String(fpSigning.fields[k])) {
                divergedFields.push(k)
            }
        }
    }

    const parity = hashMatch && calldataMatch && divergedFields.length === 0

    return {
        parity,
        hashMatch,
        calldataMatch,
        divergedFields,
        preflightHash: fpPreflight.hash,
        signingHash: fpSigning.hash,
        latencyMs: fpSigning.capturedAt - fpPreflight.capturedAt,
        reason: parity
            ? 'PARITY_VERIFIED'
            : `PARITY_FAILED: diverged fields=[${divergedFields.join(', ')}]`
    }
}

/**
 * Produces a compact human-readable fingerprint summary for logging.
 * @param {Object} fp - Fingerprint from buildFingerprint()
 * @param {string} label - Label for the log line (e.g. 'PRE-PREFLIGHT' / 'PRE-SIGNING')
 * @returns {string}
 */
function formatFingerprintLog(fp, label = 'FINGERPRINT') {
    if (!fp) return `[${label}] null`
    const f = fp.fields
    return [
        `[${label}] hash=${fp.hash.slice(0, 16)}...`,
        `  routeId=${f.routeId}`,
        `  flashPool=${f.flashPool}`,
        `  swapPool1=${f.swapPool1}`,
        `  swapPool2=${f.swapPool2}`,
        `  tokenIn=${f.tokenIn}  tokenOut=${f.tokenOut}`,
        `  borrowAmount=${f.borrowAmount}`,
        `  amountOutMinLeg1=${f.amountOutMinLeg1}`,
        `  amountOutMinLeg2=${f.amountOutMinLeg2}`,
        `  expectedRepayment=${f.expectedRepayment}`,
        `  minProfitSurplus=${f.minProfitSurplus}`,
        `  gasLimit=${f.gasLimit}`,
        `  maxFeePerGas=${f.maxFeePerGas}`,
        `  maxPriorityFeePerGas=${f.maxPriorityFeePerGas}`,
        `  stateVersion=${f.stateVersion}`,
        `  calldata=${f.calldata.slice(0, 18)}...`,
        `  capturedAt=${fp.capturedAt}`
    ].join('\n')
}

module.exports = {
    buildFingerprint,
    verifyFingerprintParity,
    formatFingerprintLog,
    normalizeAddress,
    normalizeUint256
}
