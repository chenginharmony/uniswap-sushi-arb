'use strict'

// Base Mainnet DEX Router Addresses
const BASE_ROUTERS = {
    uniswap_v3: '0x2626664c2603336E57B271c5C0b26F421741e481',    // Uniswap SwapRouter02 on Base
    pancakeswap_v3: '0x1b81D678ffb9C0263b24A97847620C99d213eB14', // PancakeSwap V3 SwapRouter on Base
    aerodrome_slipstream: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5' // Aerodrome Slipstream SwapRouter on Base
}

function getRouterForDex(dexName) {
    const dex = String(dexName || '').toLowerCase()
    if (dex.includes('pancake')) return BASE_ROUTERS.pancakeswap_v3
    if (dex.includes('aero') || dex.includes('slipstream')) return BASE_ROUTERS.aerodrome_slipstream
    return BASE_ROUTERS.uniswap_v3
}

const EXECUTION_ABI = [
    {
        name: 'executeFlashArb',
        type: 'function',
        inputs: [
            {
                name: 'params',
                type: 'tuple',
                components: [
                    { name: 'flashPool', type: 'address' },
                    { name: 'borrowToken', type: 'address' },
                    { name: 'borrowAmount', type: 'uint256' },
                    { name: 'router1', type: 'address' },
                    { name: 'feeTier1', type: 'uint24' },
                    { name: 'minAmountOut1', type: 'uint256' },
                    { name: 'router2', type: 'address' },
                    { name: 'feeTier2', type: 'uint24' },
                    { name: 'minAmountOut2', type: 'uint256' },
                    { name: 'intermediateToken', type: 'address' },
                    { name: 'minProfitSurplus', type: 'uint256' },
                    { name: 'deadline', type: 'uint256' }
                ]
            }
        ],
        outputs: []
    }
]

/**
 * Encodes the FlashArbParams struct into ABI hex data.
 */
function encodeFlashArbCalldata(params) {
    const selector = '0xf9a95c57' // executeFlashArb((address,address,uint256,address,uint24,uint256,address,uint24,uint256,address,uint256,uint256))

    function padAddress(addr) {
        return (addr || '').toLowerCase().replace('0x', '').padStart(64, '0')
    }

    function padUint(val) {
        const b = typeof val === 'bigint' ? val : BigInt(Math.floor(Number(val) || 0))
        return b.toString(16).padStart(64, '0')
    }

    const tupleData = [
        padAddress(params.flashPool),
        padAddress(params.borrowToken),
        padUint(params.borrowAmount),
        padAddress(params.router1),
        padUint(params.feeTier1),
        padUint(params.minAmountOut1),
        padAddress(params.router2),
        padUint(params.feeTier2),
        padUint(params.minAmountOut2),
        padAddress(params.intermediateToken),
        padUint(params.minProfitSurplus),
        padUint(params.deadline)
    ].join('')

    // In EVM ABI specification, a struct of static types is encoded directly head-inline without a dynamic tuple offset
    return selector + tupleData
}

/**
 * Builds an unsigned execution transaction payload for a validated profitable opportunity.
 *
 * @param {Object} opportunity - Evaluated profitable arbitrage opportunity
 * @param {Object} config - System config (dryRun, executionEnabled, contract addresses)
 * @returns {Object} Unsigned transaction payload and parameter metadata
 */
function buildFlashArbitrageTransaction(opportunity, config = {}) {
    const isDryRun = config.dryRun !== undefined ? Boolean(config.dryRun) : true
    const isExecutionEnabled = config.executionEnabled !== undefined ? Boolean(config.executionEnabled) : false
    const isLive = isExecutionEnabled && !isDryRun

    if (isLive && (!config.arbitrageContractAddress || config.arbitrageContractAddress === '0x0000000000000000000000000000000000000000')) {
        throw new Error('DEPLOYMENT_REQUIRED: Valid arbitrage contract address required for live execution.')
    }

    const buyPool = opportunity.buyPool || (opportunity.routeObj && opportunity.routeObj.buyPool)
    const sellPool = opportunity.sellPool || (opportunity.routeObj && opportunity.routeObj.sellPool)
    if (!buyPool || !sellPool) throw new Error('MISSING_POOL_STATE')

    const borrowToken = opportunity.tokenIn
    const intermediateToken = opportunity.tokenOut
    const decimalsIn = opportunity.tokenInDecimals !== undefined ? opportunity.tokenInDecimals : 18
    const decimalsOut = opportunity.tokenOutDecimals !== undefined ? opportunity.tokenOutDecimals : 18

    const inputTokens = opportunity.optimalSizeTokens || opportunity.inputSize || 0
    const borrowAmount = BigInt(Math.floor(inputTokens * Math.pow(10, decimalsIn)))
    if (borrowAmount <= 0n) throw new Error('ZERO_BORROW_AMOUNT')

    // Assign routers based on DEX
    const dex1 = String(buyPool.dex || buyPool.adapter || '').toLowerCase()
    const dex2 = String(sellPool.dex || sellPool.adapter || '').toLowerCase()
    const router1 = getRouterForDex(dex1)
    const router2 = getRouterForDex(dex2)

    const feeTier1 = dex1.includes('aero') || dex1.includes('slipstream')
        ? (buyPool.tickSpacing !== undefined ? buyPool.tickSpacing : buyPool.feeTier)
        : (buyPool.feeTier || (buyPool.feeBps ? buyPool.feeBps * 100 : 3000))

    const feeTier2 = dex2.includes('aero') || dex2.includes('slipstream')
        ? (sellPool.tickSpacing !== undefined ? sellPool.tickSpacing : sellPool.feeTier)
        : (sellPool.feeTier || (sellPool.feeBps ? sellPool.feeBps * 100 : 3000))

    if (router1.toLowerCase() === router2.toLowerCase() && feeTier1 === feeTier2) {
        throw new Error('SAME_ROUTER_SAME_TIER_NOT_ALLOWED: Flash arbitrage requires cross-DEX execution or distinct fee tiers.')
    }

    function toBaseUnits(val, decimals) {
        if (typeof val === 'bigint') return val
        if (val === null || val === undefined) return 0n
        if (typeof val === 'number') {
            if (!Number.isFinite(val) || val <= 0) return 0n
            const str = val.toFixed(Math.min(decimals, 18))
            const [intPart, fracPart = ''] = str.split('.')
            const paddedFrac = fracPart.padEnd(decimals, '0').slice(0, decimals)
            return BigInt((intPart || '0') + paddedFrac)
        }
        if (typeof val === 'string') {
            if (/^\d+$/.test(val)) return BigInt(val)
            const [intPart, fracPart = ''] = val.split('.')
            const paddedFrac = fracPart.padEnd(decimals, '0').slice(0, decimals)
            return BigInt((intPart || '0') + paddedFrac)
        }
        return 0n
    }

    // Calculate slippage bounds (0.5% tolerance)
    const slippageFactor = 995n // 99.5%
    const expectedOut1 = toBaseUnits(opportunity.expectedIntermediateOutput, decimalsOut)
    const expectedOut2 = toBaseUnits(opportunity.expectedFinalOutput, decimalsIn)

    const minAmountOut1 = expectedOut1 > 0n ? (expectedOut1 * slippageFactor) / 1000n : 0n

    // Minimum profit required in token base units
    const minProfitUsd = config.minNetProfitUsd !== undefined ? config.minNetProfitUsd : 0.01
    const tokenPrice = opportunity.tokenUsdPrice || 2600
    const minProfitTokens = minProfitUsd / tokenPrice
    const minProfitSurplus = BigInt(Math.max(1, Math.floor(minProfitTokens * Math.pow(10, decimalsIn))))

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120) // 2 minute deadline

    // ── Flash Pool Isolation ──────────────────────────────────────────────────────
    // CRITICAL: The flash loan source pool MUST NOT be the same pool that either
    // swap leg routes through. If the same pool is used for both the flash loan
    // and a swap leg, Uniswap V3's internal reentrancy lock (slot0.unlocked) will
    // trigger a 'LOK' revert because the lock is held for the entire duration of
    // pool.flash(), and any attempt to call back into the same pool (even via the
    // router) is blocked.
    //
    // Strategy:
    //   1. Collect the swap leg pool addresses (buyPool and sellPool).
    //   2. Find a Uniswap V3 pool for the same token pair that is NOT one of the
    //      swap leg pools. Prefer a different fee tier (e.g. 500 or 3000 vs 100).
    //   3. Only fall back to a swap leg pool if no alternative exists.
    // ─────────────────────────────────────────────────────────────────────────────

    const swapPoolAddresses = new Set([
        String(buyPool.address || '').toLowerCase(),
        String(sellPool.address || '').toLowerCase()
    ])

    let flashPoolAddress = null

    // Load full pool universe to find an isolated flash pool
    try {
        const universePath = require('path').join(__dirname, '..', '..', 'data', 'base_pool_universe.json')
        if (require('fs').existsSync(universePath)) {
            const pools = JSON.parse(require('fs').readFileSync(universePath, 'utf8'))
            const tIn = String(borrowToken).toLowerCase()
            const tOut = String(intermediateToken).toLowerCase()

            // Priority 1: Uniswap V3 pool for this pair that is NOT a swap leg pool
            const isolatedUniPool = pools.find(p => {
                const dex = String(p.dex || p.adapter || '').toLowerCase()
                if (!dex.includes('uniswap')) return false
                if (swapPoolAddresses.has(String(p.address || '').toLowerCase())) return false
                const p0 = String(p.token0 || '').toLowerCase()
                const p1 = String(p.token1 || '').toLowerCase()
                return (p0 === tIn && p1 === tOut) || (p0 === tOut && p1 === tIn)
            })

            if (isolatedUniPool) {
                flashPoolAddress = isolatedUniPool.address
            } else {
                // Priority 2: Any Uniswap V3 pool for this pair (last resort)
                const anyUniPool = pools.find(p => {
                    const dex = String(p.dex || p.adapter || '').toLowerCase()
                    if (!dex.includes('uniswap')) return false
                    const p0 = String(p.token0 || '').toLowerCase()
                    const p1 = String(p.token1 || '').toLowerCase()
                    return (p0 === tIn && p1 === tOut) || (p0 === tOut && p1 === tIn)
                })
                if (anyUniPool) flashPoolAddress = anyUniPool.address
            }
        }
    } catch (e) {}

    // Priority 3: Fall back to the buy or sell pool if it is a Uniswap V3 pool
    // and no better alternative was found. This is a risk — emit a warning.
    if (!flashPoolAddress) {
        const isBuyUni = String(buyPool.dex || buyPool.adapter || '').toLowerCase().includes('uniswap')
        const isSellUni = String(sellPool.dex || sellPool.adapter || '').toLowerCase().includes('uniswap')
        if (isBuyUni) {
            flashPoolAddress = buyPool.address
            console.warn('[builder] WARNING: flashPool === leg1 swap pool — LOK revert risk!')
        } else if (isSellUni) {
            flashPoolAddress = sellPool.address
            console.warn('[builder] WARNING: flashPool === leg2 swap pool — LOK revert risk!')
        } else {
            throw new Error('NO_VALID_FLASH_POOL: Cannot find a Uniswap V3 canonical pool for this pair to flash from.')
        }
    }

    // Final guard: if the chosen flashPool overlaps with a swap leg pool, throw
    // rather than submit a transaction guaranteed to revert with LOK.
    if (swapPoolAddresses.has(String(flashPoolAddress).toLowerCase())) {
        throw new Error(
            `LOK_RISK_ABORTED: flashPool ${flashPoolAddress} is also used as a swap leg pool. ` +
            'This would trigger Uniswap V3 reentrancy lock (LOK). Trade skipped.'
        )
    }

    // ── Hard Slippage & Repayment Floor ──────────────────────────────────────────
    // Determine flash pool fee tier to calculate exact repayment obligation
    let flashFeeTier = 500
    try {
        const universePath = require('path').join(__dirname, '..', '..', 'data', 'base_pool_universe.json')
        if (require('fs').existsSync(universePath)) {
            const pools = JSON.parse(require('fs').readFileSync(universePath, 'utf8'))
            const fPool = pools.find(p => String(p.address || '').toLowerCase() === String(flashPoolAddress).toLowerCase())
            if (fPool && fPool.feeTier) flashFeeTier = fPool.feeTier
        }
    } catch (e) {}

    const flashFee = (borrowAmount * BigInt(flashFeeTier) + 999999n) / 1000000n
    const repayment = borrowAmount + flashFee
    const requiredMinOut2 = repayment + minProfitSurplus

    if (expectedOut2 < requiredMinOut2) {
        throw new Error(
            `INSUFFICIENT_PROJECTED_OUTPUT: Projected output ${expectedOut2} cannot cover repayment ${repayment} + min profit ${minProfitSurplus}.`
        )
    }

    // Slippage tolerance cannot violate the flash loan repayment obligation
    const calculatedMinOut2 = expectedOut2 > 0n ? (expectedOut2 * slippageFactor) / 1000n : 0n
    const minAmountOut2 = calculatedMinOut2 > requiredMinOut2 ? calculatedMinOut2 : requiredMinOut2

    const flashParams = {
        flashPool: flashPoolAddress,
        borrowToken,
        borrowAmount,
        router1,
        feeTier1,
        minAmountOut1,
        router2,
        feeTier2,
        minAmountOut2,
        intermediateToken,
        minProfitSurplus,
        deadline,
        // Attached for fingerprint use — not encoded into calldata
        expectedRepayment: repayment,
        swapPool1: String(buyPool.address || ''),
        swapPool2: String(sellPool.address || '')
    }

    const calldata = encodeFlashArbCalldata(flashParams)
    const contractAddress = config.arbitrageContractAddress || '0x0000000000000000000000000000000000000000'

    // ── Freeze gas fields at build time ───────────────────────────────────────
    // These values are locked here and must remain unchanged through preflight,
    // fingerprint capture, signing, and broadcast. The controller may increase
    // gasLimit after eth_call gas estimation — but it must re-fingerprint after
    // that update and only then sign.
    const frozenMaxFeePerGas = config.maxFeePerGas
        ? BigInt(config.maxFeePerGas)
        : 100000000n          // 0.1 gwei floor — controller will override from network
    const frozenMaxPriorityFeePerGas = config.maxPriorityFeePerGas
        ? BigInt(config.maxPriorityFeePerGas)
        : 10000000n           // 0.01 gwei floor

    return {
        unsignedTransaction: {
            from: config.walletAddress || opportunity.walletAddress || process.env.WALLET_ADDRESS || '0x5018bbcefbe3ad54c4de65f621ab0c9c5f12f4f4',
            to: contractAddress,
            data: calldata,
            value: '0x0',
            chainId: 8453, // Base Mainnet
            gasLimit: 650000n,
            maxFeePerGas: frozenMaxFeePerGas,
            maxPriorityFeePerGas: frozenMaxPriorityFeePerGas
        },
        flashParams,
        calldata,
        isExecutable: isLive,
        dryRun: isDryRun,
        reason: isLive ? 'READY_FOR_EXECUTION' : 'DRY_RUN_ENFORCED'
    }
}

module.exports = {
    BASE_ROUTERS,
    EXECUTION_ABI,
    encodeFlashArbCalldata,
    buildFlashArbitrageTransaction
}
