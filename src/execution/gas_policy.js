'use strict'

/**
 * @title BoundedGasPolicy
 * @notice Deterministic gas validation & bounded sizing policy for Base Flash Arbitrage.
 *
 * Prevents dangerous hard-coded 650,000 gas limits from reaching live broadcast.
 * Classifies route complexity, validates estimated gas consumption against bounded
 * envelopes, and enforces strict safety ceilings before transaction signing.
 *
 * Architecture Position:
 *   Flashblock → Candidate → Fast eth_call (650k sim ceiling) → State-Version Check (Gate B)
 *   → Fingerprint Parity (Gate C) → WOULD BROADCAST → BoundedGasPolicy → Sign
 */

const GAS_PROFILES = {
    // Standard 2-hop Concentrated Liquidity (Uniswap V3 <-> PancakeSwap V3)
    STANDARD_CL: {
        name: 'STANDARD_CL',
        typicalGas: 260000,
        minGas:     240000,
        defaultGas: 320000,
        maxGas:     380000
    },
    // Routes involving Aerodrome Slipstream (tick bitmap walks & custom spacing)
    SLIPSTREAM_CL: {
        name: 'SLIPSTREAM_CL',
        typicalGas: 340000,
        minGas:     280000,
        defaultGas: 420000,
        maxGas:     480000
    },
    // Fallback profile
    DEFAULT: {
        name: 'DEFAULT',
        typicalGas: 300000,
        minGas:     250000,
        defaultGas: 360000,
        maxGas:     450000
    }
}

// Absolute hard ceiling on Base Mainnet. Any trade requiring more than this
// indicates an abnormal execution path (e.g. infinite tick loop, griefing pool).
const MAX_GAS_CEILING = 550000

/**
 * Classifies an opportunity into a bounded gas profile based on pool protocols.
 *
 * @param {Object} opportunity
 * @returns {Object} Gas profile definition
 */
function classifyGasProfile(opportunity) {
    if (!opportunity) return GAS_PROFILES.DEFAULT

    const buyPool = opportunity.buyPool || (opportunity.routeObj && opportunity.routeObj.buyPool) || {}
    const sellPool = opportunity.sellPool || (opportunity.routeObj && opportunity.routeObj.sellPool) || {}

    const dex1 = String(buyPool.dex || buyPool.adapter || '').toLowerCase()
    const dex2 = String(sellPool.dex || sellPool.adapter || '').toLowerCase()

    const hasSlipstream = dex1.includes('aero') || dex1.includes('slipstream') ||
                          dex2.includes('aero') || dex2.includes('slipstream')

    if (hasSlipstream) {
        return GAS_PROFILES.SLIPSTREAM_CL
    }

    const isStandardCL = (dex1.includes('uni') || dex1.includes('pancake')) &&
                         (dex2.includes('uni') || dex2.includes('pancake'))
    if (isStandardCL) {
        return GAS_PROFILES.STANDARD_CL
    }

    return GAS_PROFILES.DEFAULT
}

/**
 * Validates and sizes transaction gasLimit according to the bounded gas policy.
 *
 * @param {Object} txBuild     - Result of buildFlashArbitrageTransaction
 * @param {Object} opportunity - Opportunity candidate
 * @param {Object} options     - Optional validation overrides { estimatedGas, maxGasCeiling }
 * @returns {Object} { valid: boolean, gasLimit: bigint, profile: Object, reason?: string }
 */
function validateAndSizeGas(txBuild, opportunity, options = {}) {
    const profile = classifyGasProfile(opportunity)
    const ceiling = options.maxGasCeiling || MAX_GAS_CEILING

    let assignedGas = profile.defaultGas

    if (options.estimatedGas != null) {
        const est = Number(options.estimatedGas)

        // Gate: Hard ceiling check
        if (est > ceiling) {
            return {
                valid: false,
                reason: 'GAS_CEILING_EXCEEDED',
                estimatedGas: est,
                maxAllowed: ceiling,
                profile: profile.name
            }
        }

        // Gate: Route profile envelope check
        // Allow up to a 10% buffer above profile.maxGas before considering anomalous
        const profileUpperLimit = Math.floor(profile.maxGas * 1.10)
        if (est > profileUpperLimit) {
            return {
                valid: false,
                reason: 'GAS_POLICY_EXCEEDED',
                estimatedGas: est,
                maxAllowed: profileUpperLimit,
                profile: profile.name
            }
        }

        // Dynamic sizing: add 20% safety margin clamped to profile bounds
        const withMargin = Math.floor(est * 1.20)
        assignedGas = Math.min(profile.maxGas, Math.max(profile.minGas, withMargin))
    }

    // Ensure within absolute bounds
    assignedGas = Math.min(ceiling, Math.max(profile.minGas, assignedGas))

    return {
        valid: true,
        gasLimit: BigInt(assignedGas),
        profile: profile.name,
        typicalGas: profile.typicalGas,
        maxGas: profile.maxGas
    }
}

module.exports = {
    GAS_PROFILES,
    MAX_GAS_CEILING,
    classifyGasProfile,
    validateAndSizeGas
}
