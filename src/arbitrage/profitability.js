'use strict'

const { quoteV3ExactInput, toBigIntSafe } = require('./v3_math')

function toNumber(value, fallback = 0) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
}

function sameToken(a, b) {
    if (!a || !b) return false
    return String(a).toLowerCase() === String(b).toLowerCase()
}

function quoteConstantProduct(amountIn, reserveIn, reserveOut, feeBps = 30) {
    const input = toNumber(amountIn)
    const inputReserve = toNumber(reserveIn)
    const outputReserve = toNumber(reserveOut)
    const fee = 10000 - toNumber(feeBps, 30)

    if (input <= 0 || inputReserve <= 0 || outputReserve <= 0 || fee <= 0) return 0
    const amountInWithFee = input * fee
    return (amountInWithFee * outputReserve) / (inputReserve * 10000 + amountInWithFee)
}

function toBigInt(value) {
    if (typeof value === 'bigint') return value
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
    throw new TypeError('integer token amounts must be safe integers, decimal strings, or BigInt values')
}

function quoteConstantProductExact(amountIn, reserveIn, reserveOut, feeBps = 30) {
    const input = toBigInt(amountIn)
    const inputReserve = toBigInt(reserveIn)
    const outputReserve = toBigInt(reserveOut)
    const fee = 10000n - toBigInt(feeBps)
    if (input <= 0n || inputReserve <= 0n || outputReserve <= 0n || fee <= 0n) return 0n
    const amountInWithFee = input * fee
    return (amountInWithFee * outputReserve) / (inputReserve * 10000n + amountInWithFee)
}

function calculateProfitability(values) {
    const grossProfitUsd = toNumber(values.grossProfitUsd)
    const dexFeesUsd = toNumber(values.dexFeesUsd)
    const flashloanFeeUsd = toNumber(values.flashloanFeeUsd)
    const gasCostUsd = toNumber(values.gasCostUsd)
    const executionBufferUsd = toNumber(values.executionBufferUsd !== undefined ? values.executionBufferUsd : values.slippageCostUsd)
    const safetyMarginUsd = toNumber(values.safetyMarginUsd)
    const expectedNetProfitUsd = grossProfitUsd - flashloanFeeUsd - gasCostUsd - executionBufferUsd - safetyMarginUsd
    const amountInUsd = toNumber(values.amountInUsd)
    const profitMarginBps = amountInUsd > 0 ? (expectedNetProfitUsd / amountInUsd) * 10000 : 0
    const minimumNetProfitUsd = toNumber(values.minimumNetProfitUsd)
    const minimumProfitMarginBps = toNumber(values.minimumProfitMarginBps)
    const maxSlippageBps = toNumber(values.maxSlippageBps, Infinity)
    const slippageBps = toNumber(values.slippageBps)
    const liquiditySufficient = values.liquiditySufficient !== false

    const profitable = liquiditySufficient &&
        expectedNetProfitUsd >= minimumNetProfitUsd &&
        profitMarginBps >= minimumProfitMarginBps &&
        slippageBps <= maxSlippageBps

    let rejectionReason = null
    if (!profitable) {
        if (values.rejectionReason) {
            rejectionReason = values.rejectionReason
        } else if (!liquiditySufficient) {
            rejectionReason = 'INSUFFICIENT_LIQUIDITY'
        } else if (slippageBps > maxSlippageBps) {
            rejectionReason = 'SLIPPAGE_TOO_HIGH'
        } else if (grossProfitUsd < 0) {
            rejectionReason = 'NEGATIVE_GROSS_PROFIT'
        } else if (dexFeesUsd > 0 && grossProfitUsd < dexFeesUsd) {
            rejectionReason = 'DEX_FEES_EXCEED_EDGE'
        } else if (grossProfitUsd < flashloanFeeUsd) {
            rejectionReason = 'FLASHLOAN_COST_EXCEEDS_EDGE'
        } else if (grossProfitUsd < flashloanFeeUsd + gasCostUsd) {
            rejectionReason = 'GAS_EXCEEDS_EDGE'
        } else if (grossProfitUsd < flashloanFeeUsd + gasCostUsd + executionBufferUsd + safetyMarginUsd) {
            rejectionReason = 'SAFETY_MARGIN_EXCEEDS_EDGE'
        } else if (profitMarginBps < minimumProfitMarginBps) {
            rejectionReason = 'BELOW_MIN_MARGIN'
        } else if (expectedNetProfitUsd < minimumNetProfitUsd) {
            rejectionReason = 'BELOW_MIN_NET_PROFIT'
        } else {
            rejectionReason = 'UNPROFITABLE'
        }
    }

    return {
        grossOutputAfterAmmFees: grossProfitUsd,
        grossProfitUsd,
        dexFeeAttribution: dexFeesUsd,
        dexFeesUsd,
        flashloanFeeUsd,
        gasCostUsd,
        executionBufferUsd,
        slippageCostUsd: executionBufferUsd,
        safetyMarginUsd,
        netTradingEdge: expectedNetProfitUsd,
        expectedNetProfitUsd,
        netProfitUsd: expectedNetProfitUsd,
        amountInUsd,
        profitMarginBps,
        slippageBps,
        liquiditySufficient,
        profitable,
        status: profitable ? 'PROFITABLE' : 'REJECTED',
        rejectionReason
    }
}

function isV3Pool(pool) {
    if (!pool) return false
    return pool.quoteModel === 'concentrated-liquidity' ||
        (pool.sqrtPriceX96 !== undefined && pool.liquidity !== undefined) ||
        String(pool.dex || pool.adapter || '').toLowerCase().includes('v3')
}

function quoteLeg(pool, amountIn, tokenIn, tokenOut) {
    const input = toNumber(amountIn)
    if (input <= 0) return { output: 0, sufficient: false, reason: 'ZERO_INPUT' }

    if (isV3Pool(pool)) {
        const sqrtPriceX96 = pool.sqrtPriceX96
        const liquidity = pool.liquidity
        const feeBps = pool.feeBps !== undefined ? pool.feeBps : (pool.feeTier ? pool.feeTier / 100 : 30)

        // Strict zeroForOne derived from token identity
        let zeroForOne
        if (pool.zeroForOne !== undefined) {
            zeroForOne = Boolean(pool.zeroForOne)
        } else if (tokenIn && pool.token0) {
            zeroForOne = sameToken(tokenIn, pool.token0)
        } else if (tokenOut && pool.token1) {
            zeroForOne = sameToken(tokenOut, pool.token1)
        } else {
            zeroForOne = true
        }

        const inDecimals = zeroForOne ? (pool.token0Decimals !== undefined ? pool.token0Decimals : 18)
                                      : (pool.token1Decimals !== undefined ? pool.token1Decimals : 18)
        const outDecimals = zeroForOne ? (pool.token1Decimals !== undefined ? pool.token1Decimals : 18)
                                       : (pool.token0Decimals !== undefined ? pool.token0Decimals : 18)

        // Scale human amount to base units
        const rawIn = input > 1e12 ? toBigIntSafe(input) : toBigIntSafe(Math.floor(input * Math.pow(10, inDecimals)))
        const res = quoteV3ExactInput(rawIn, sqrtPriceX96, liquidity, feeBps, zeroForOne)

        if (!res.sufficient || res.amountOut <= 0n) {
            return { output: 0, sufficient: false, reason: res.reason || 'INSUFFICIENT_LIQUIDITY' }
        }

        const output = input > 1e12 ? Number(res.amountOut) : Number(res.amountOut) / Math.pow(10, outDecimals)
        return { output, sufficient: output > 0 }
    } else {
        // V2 pool constant-product
        if (pool.reserveIn === undefined || pool.reserveOut === undefined) {
            return { output: 0, sufficient: false, reason: 'INVALID_POOL_STATE' }
        }
        const output = quoteConstantProduct(input, pool.reserveIn, pool.reserveOut, pool.feeBps)
        return { output, sufficient: output > 0, reason: output > 0 ? null : 'INSUFFICIENT_LIQUIDITY' }
    }
}

function evaluateTrade({
    amountIn,
    buyPool,
    sellPool,
    tokenIn,
    tokenOut,
    tokenUsdPrice,
    flashloanFeeBps = 0,
    gasCostUsd = 0,
    slippageBps = 0,
    executionBufferUsd = 0,
    slippageCostUsd,
    safetyMarginUsd = 0,
    minimumNetProfitUsd = 0,
    minimumProfitMarginBps = 0,
    maxSlippageBps = Infinity
}) {
    const usdPrice = toNumber(tokenUsdPrice)
    if (usdPrice <= 0) {
        return {
            amountIn,
            firstOutput: 0,
            expectedAmountOut: 0,
            grossProfitUsd: 0,
            dexFeesUsd: 0,
            flashloanFeeUsd: 0,
            gasCostUsd,
            executionBufferUsd,
            slippageCostUsd: executionBufferUsd,
            safetyMarginUsd,
            expectedNetProfitUsd: 0,
            netProfitUsd: 0,
            amountInUsd: 0,
            profitMarginBps: 0,
            slippageBps,
            liquiditySufficient: false,
            profitable: false,
            status: 'REJECTED',
            rejectionReason: 'MISSING_PRICE'
        }
    }

    const tIn = tokenIn || buyPool.tokenIn || (buyPool.zeroForOne === false ? buyPool.token1 : buyPool.token0)
    const tOut = tokenOut || buyPool.tokenOut || (buyPool.zeroForOne === false ? buyPool.token0 : buyPool.token1)

    // Leg 1: swap tIn -> tOut on buyPool
    const firstLeg = quoteLeg(buyPool, amountIn, tIn, tOut)
    const firstOutput = firstLeg.output

    // Leg 2: swap tOut -> tIn on sellPool
    let finalOutput = 0
    let secondLeg = { output: 0, sufficient: false }
    if (firstLeg.sufficient && firstOutput > 0) {
        secondLeg = quoteLeg(sellPool, firstOutput, tOut, tIn)
        finalOutput = secondLeg.output
    }

    const liquiditySufficient = Boolean(firstLeg.sufficient && secondLeg.sufficient && firstOutput > 0 && finalOutput > 0)
    const grossProfitTokens = finalOutput - toNumber(amountIn)
    const grossProfitUsd = grossProfitTokens * usdPrice
    const amountInUsd = toNumber(amountIn) * usdPrice

    const buyFeeBps = buyPool.feeBps !== undefined ? buyPool.feeBps : (buyPool.feeTier ? buyPool.feeTier / 100 : 30)
    const sellFeeBps = sellPool.feeBps !== undefined ? sellPool.feeBps : (sellPool.feeTier ? sellPool.feeTier / 100 : 30)
    const dexFeesUsd = (amountInUsd * (toNumber(buyFeeBps) + toNumber(sellFeeBps))) / 10000
    const flashloanFeeUsd = (amountInUsd * toNumber(flashloanFeeBps)) / 10000

    const initialReason = !liquiditySufficient ? (firstLeg.reason || secondLeg.reason || 'INSUFFICIENT_LIQUIDITY') : null

    return {
        amountIn,
        firstOutput,
        expectedAmountOut: finalOutput,
        ...calculateProfitability({
            grossProfitUsd,
            dexFeesUsd,
            flashloanFeeUsd,
            gasCostUsd,
            executionBufferUsd: slippageCostUsd === undefined ? executionBufferUsd : slippageCostUsd,
            safetyMarginUsd,
            amountInUsd,
            slippageBps,
            minimumNetProfitUsd,
            minimumProfitMarginBps,
            maxSlippageBps,
            liquiditySufficient,
            rejectionReason: initialReason
        })
    }
}

module.exports = {
    quoteConstantProduct,
    quoteConstantProductExact,
    calculateProfitability,
    evaluateTrade,
    isV3Pool,
    quoteLeg,
    sameToken
}
