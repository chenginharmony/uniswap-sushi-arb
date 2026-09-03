'use strict'

function toNumber(value, fallback = 0) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
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
    return amountInWithFee * outputReserve / (inputReserve * 10000n + amountInWithFee)
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
    const profitMarginBps = amountInUsd > 0 ? expectedNetProfitUsd / amountInUsd * 10000 : 0
    const minimumNetProfitUsd = toNumber(values.minimumNetProfitUsd)
    const minimumProfitMarginBps = toNumber(values.minimumProfitMarginBps)
    const maxSlippageBps = toNumber(values.maxSlippageBps, Infinity)
    const slippageBps = toNumber(values.slippageBps)
    const liquiditySufficient = values.liquiditySufficient !== false

    return {
        grossProfitUsd,
        dexFeesUsd,
        flashloanFeeUsd,
        gasCostUsd,
        executionBufferUsd,
        slippageCostUsd: executionBufferUsd,
        safetyMarginUsd,
        expectedNetProfitUsd,
        netProfitUsd: expectedNetProfitUsd,
        profitMarginBps,
        slippageBps,
        liquiditySufficient,
        profitable: liquiditySufficient &&
            expectedNetProfitUsd >= minimumNetProfitUsd &&
            profitMarginBps >= minimumProfitMarginBps &&
            slippageBps <= maxSlippageBps
    }
}

function evaluateTrade({ amountIn, buyPool, sellPool, tokenUsdPrice, flashloanFeeBps = 0, gasCostUsd = 0, slippageBps = 0, executionBufferUsd = 0, slippageCostUsd, safetyMarginUsd = 0, minimumNetProfitUsd = 0, minimumProfitMarginBps = 0, maxSlippageBps = Infinity }) {
    const firstOutput = quoteConstantProduct(amountIn, buyPool.reserveIn, buyPool.reserveOut, buyPool.feeBps)
    const finalOutput = quoteConstantProduct(firstOutput, sellPool.reserveIn, sellPool.reserveOut, sellPool.feeBps)
    const grossProfitTokens = finalOutput - toNumber(amountIn)
    const grossProfitUsd = grossProfitTokens * toNumber(tokenUsdPrice)
    const amountInUsd = toNumber(amountIn) * toNumber(tokenUsdPrice)
    const dexFeesUsd = (toNumber(amountIn) * toNumber(buyPool.feeBps) / 10000 + firstOutput * toNumber(sellPool.feeBps) / 10000) * toNumber(tokenUsdPrice)
    const flashloanFeeUsd = amountInUsd * toNumber(flashloanFeeBps) / 10000

    return {
        amountIn,
        expectedAmountOut: finalOutput,
        ...calculateProfitability({ grossProfitUsd, dexFeesUsd, flashloanFeeUsd, gasCostUsd, executionBufferUsd: slippageCostUsd === undefined ? executionBufferUsd : slippageCostUsd, safetyMarginUsd, amountInUsd, slippageBps, minimumNetProfitUsd, minimumProfitMarginBps, maxSlippageBps, liquiditySufficient: firstOutput > 0 && finalOutput > 0 })
    }
}

    module.exports = { quoteConstantProduct, quoteConstantProductExact, calculateProfitability, evaluateTrade }
