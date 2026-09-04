'use strict'

const Q96 = 2n ** 96n
const MIN_TICK = -887272
const MAX_TICK = 887272

function toBigIntSafe(val) {
    if (typeof val === 'bigint') return val
    if (typeof val === 'number') {
        if (!Number.isFinite(val) || val < 0) return 0n
        return BigInt(Math.floor(val))
    }
    if (typeof val === 'string') {
        const clean = val.trim()
        if (/^\d+$/.test(clean)) return BigInt(clean)
        if (/^0x[0-9a-fA-F]+$/i.test(clean)) return BigInt(clean)
        const floatVal = Number(clean)
        if (Number.isFinite(floatVal) && floatVal >= 0) return BigInt(Math.floor(floatVal))
    }
    return 0n
}

/**
 * Returns the exact sqrt ratio as a Q64.96 for a given tick.
 * Port of Uniswap V3 TickMath.getSqrtRatioAtTick.
 */
function getSqrtRatioAtTick(tick) {
    const absTick = Math.abs(tick)
    if (absTick > MAX_TICK) throw new Error(`Tick ${tick} out of bounds [${MIN_TICK}, ${MAX_TICK}]`)

    let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n
    if ((absTick & 0x2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n
    if ((absTick & 0x4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n
    if ((absTick & 0x8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n
    if ((absTick & 0x10) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n
    if ((absTick & 0x20) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n
    if ((absTick & 0x40) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n
    if ((absTick & 0x80) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n
    if ((absTick & 0x100) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n
    if ((absTick & 0x200) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n
    if ((absTick & 0x400) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n
    if ((absTick & 0x800) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n
    if ((absTick & 0x1000) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n
    if ((absTick & 0x2000) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n
    if ((absTick & 0x4000) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n
    if ((absTick & 0x8000) !== 0) ratio = (ratio * 0x31be135b97d08fd981231505542fcfa6n) >> 128n
    if ((absTick & 0x10000) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n
    if ((absTick & 0x20000) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n
    if ((absTick & 0x40000) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n
    if ((absTick & 0x80000) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n

    if (tick > 0) {
        ratio = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn / ratio
    }

    return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n)
}

function getAmount0Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp = true) {
    let a = sqrtRatioAX96, b = sqrtRatioBX96
    if (a > b) [a, b] = [b, a]
    if (a <= 0n) return 0n
    const numerator1 = liquidity << 96n
    const numerator2 = b - a
    const denom = b * a
    if (denom <= 0n) return 0n
    if (roundUp) {
        return (numerator1 * numerator2 + (denom - 1n)) / denom
    }
    return (numerator1 * numerator2) / denom
}

function getAmount1Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp = true) {
    let a = sqrtRatioAX96, b = sqrtRatioBX96
    if (a > b) [a, b] = [b, a]
    if (roundUp) {
        return (liquidity * (b - a) + (Q96 - 1n)) / Q96
    }
    return (liquidity * (b - a)) / Q96
}

/**
 * Quote exact input for a V3 pool within a single tick.
 */
function quoteV3ExactInput(amountIn, sqrtPriceX96, liquidity, feeBps = 30, zeroForOne = true) {
    const input = toBigIntSafe(amountIn)
    const sqrtPrice = toBigIntSafe(sqrtPriceX96)
    const L = toBigIntSafe(liquidity)

    if (input <= 0n) {
        return { amountOut: 0n, sqrtPriceNextX96: sqrtPrice, sufficient: false, reason: 'ZERO_INPUT' }
    }
    if (sqrtPrice <= 0n || L <= 0n) {
        return { amountOut: 0n, sqrtPriceNextX96: sqrtPrice, sufficient: false, reason: 'INSUFFICIENT_LIQUIDITY' }
    }

    const feePpm = BigInt(Math.round(Number(feeBps) * 100))
    const feeMultiplier = 1000000n - (feePpm > 1000000n ? 1000000n : feePpm)
    const amountInWithFee = (input * feeMultiplier) / 1000000n

    if (amountInWithFee <= 0n) {
        return { amountOut: 0n, sqrtPriceNextX96: sqrtPrice, sufficient: false, reason: 'FEE_EXCEEDS_INPUT' }
    }

    try {
        if (zeroForOne) {
            const numerator = L * sqrtPrice * Q96
            const denominator = (L * Q96) + (amountInWithFee * sqrtPrice)
            if (denominator <= 0n) {
                return { amountOut: 0n, sqrtPriceNextX96: sqrtPrice, sufficient: false, reason: 'INSUFFICIENT_LIQUIDITY' }
            }
            const sqrtPriceNextX96 = numerator / denominator
            if (sqrtPrice <= sqrtPriceNextX96) {
                return { amountOut: 0n, sqrtPriceNextX96: sqrtPrice, sufficient: false, reason: 'INSUFFICIENT_LIQUIDITY' }
            }
            const amountOut = (L * (sqrtPrice - sqrtPriceNextX96)) / Q96
            return {
                amountOut,
                sqrtPriceNextX96,
                ticksCrossed: 0,
                sufficient: amountOut > 0n,
                reason: amountOut > 0n ? null : 'INSUFFICIENT_LIQUIDITY'
            }
        } else {
            const deltaSqrtPrice = (amountInWithFee * Q96) / L
            const sqrtPriceNextX96 = sqrtPrice + deltaSqrtPrice
            const numerator = L * Q96 * deltaSqrtPrice
            const denominator = sqrtPriceNextX96 * sqrtPrice
            if (denominator <= 0n) {
                return { amountOut: 0n, sqrtPriceNextX96: sqrtPrice, sufficient: false, reason: 'INSUFFICIENT_LIQUIDITY' }
            }
            const amountOut = numerator / denominator
            return {
                amountOut,
                sqrtPriceNextX96,
                ticksCrossed: 0,
                sufficient: amountOut > 0n,
                reason: amountOut > 0n ? null : 'INSUFFICIENT_LIQUIDITY'
            }
        }
    } catch (err) {
        return { amountOut: 0n, sqrtPriceNextX96: sqrtPrice, sufficient: false, reason: 'INSUFFICIENT_LIQUIDITY' }
    }
}

/**
 * Quote exact input simulating multi-tick traversal across initialized ticks.
 *
 * @param {Object} params
 * @param {bigint|number|string} params.amountIn - Input amount in base units
 * @param {bigint|number|string} params.sqrtPriceX96 - Current sqrt price
 * @param {number} params.currentTick - Current pool tick
 * @param {bigint|number|string} params.liquidity - Active liquidity L
 * @param {number} params.feeBps - Pool fee in basis points
 * @param {boolean} params.zeroForOne - Swap direction
 * @param {Array<{ tick: number, liquidityNet: bigint }>} [params.initializedTicks] - Initialized ticks
 * @returns {{ amountOut: bigint, sqrtPriceNextX96: bigint, ticksCrossed: number, sufficient: boolean, reason?: string }}
 */
function quoteV3MultiTick(params) {
    const amountIn = toBigIntSafe(params.amountIn)
    let sqrtPrice = toBigIntSafe(params.sqrtPriceX96)
    let L = toBigIntSafe(params.liquidity)
    const feeBps = params.feeBps !== undefined ? params.feeBps : 30
    const zeroForOne = Boolean(params.zeroForOne)
    const ticks = (params.initializedTicks || []).slice().sort((a, b) => a.tick - b.tick)

    if (amountIn <= 0n) return { amountOut: 0n, sqrtPriceNextX96: sqrtPrice, ticksCrossed: 0, sufficient: false, reason: 'ZERO_INPUT' }
    if (sqrtPrice <= 0n || L <= 0n) return { amountOut: 0n, sqrtPriceNextX96: sqrtPrice, ticksCrossed: 0, sufficient: false, reason: 'INSUFFICIENT_LIQUIDITY' }

    // If no initialized ticks supplied, fallback to exact single-tick
    if (!ticks.length) {
        return quoteV3ExactInput(amountIn, sqrtPrice, L, feeBps, zeroForOne)
    }

    const feePpm = BigInt(Math.round(Number(feeBps) * 100))
    const feeMultiplier = 1000000n - (feePpm > 1000000n ? 1000000n : feePpm)

    let amountRemaining = amountIn
    let totalAmountOut = 0n
    let ticksCrossed = 0

    // Filter relevant ticks ahead of trade direction
    const currentTick = params.currentTick !== undefined ? params.currentTick : 0
    let relevantTicks
    if (zeroForOne) {
        // Price moves down, ticks decrease
        relevantTicks = ticks.filter(t => t.tick <= currentTick).reverse()
    } else {
        // Price moves up, ticks increase
        relevantTicks = ticks.filter(t => t.tick > currentTick)
    }

    let tickIdx = 0
    while (amountRemaining > 0n && L > 0n) {
        const nextTick = relevantTicks[tickIdx++]
        if (!nextTick) {
            // No further initialized ticks: finish trade in remaining liquidity band
            const finalLeg = quoteV3ExactInput(amountRemaining, sqrtPrice, L, feeBps, zeroForOne)
            totalAmountOut += finalLeg.amountOut
            sqrtPrice = finalLeg.sqrtPriceNextX96
            break
        }

        const sqrtTarget = getSqrtRatioAtTick(nextTick.tick)

        // Calculate max amountIn to reach target tick
        let maxAmountInToTarget
        if (zeroForOne) {
            const amount0Needed = getAmount0Delta(sqrtTarget, sqrtPrice, L, true)
            maxAmountInToTarget = (amount0Needed * 1000000n + (feeMultiplier - 1n)) / feeMultiplier
        } else {
            const amount1Needed = getAmount1Delta(sqrtPrice, sqrtTarget, L, true)
            maxAmountInToTarget = (amount1Needed * 1000000n + (feeMultiplier - 1n)) / feeMultiplier
        }

        if (amountRemaining <= maxAmountInToTarget) {
            // Swap finishes before crossing nextTick
            const leg = quoteV3ExactInput(amountRemaining, sqrtPrice, L, feeBps, zeroForOne)
            totalAmountOut += leg.amountOut
            sqrtPrice = leg.sqrtPriceNextX96
            amountRemaining = 0n
            break
        } else {
            // Swap consumes entire tick range and crosses boundary
            let amountOutThisTick
            if (zeroForOne) {
                amountOutThisTick = getAmount1Delta(sqrtTarget, sqrtPrice, L, false)
            } else {
                amountOutThisTick = getAmount0Delta(sqrtPrice, sqrtTarget, L, false)
            }

            totalAmountOut += amountOutThisTick
            amountRemaining -= maxAmountInToTarget
            sqrtPrice = sqrtTarget
            ticksCrossed++

            // Cross tick and update active liquidity
            const liqNet = toBigIntSafe(nextTick.liquidityNet)
            if (zeroForOne) {
                L = L - liqNet
            } else {
                L = L + liqNet
            }

            if (L <= 0n) {
                return {
                    amountOut: totalAmountOut,
                    sqrtPriceNextX96: sqrtPrice,
                    ticksCrossed,
                    sufficient: false,
                    reason: 'INSUFFICIENT_LIQUIDITY'
                }
            }
        }
    }

    return {
        amountOut: totalAmountOut,
        sqrtPriceNextX96: sqrtPrice,
        ticksCrossed,
        sufficient: totalAmountOut > 0n,
        reason: totalAmountOut > 0n ? null : 'INSUFFICIENT_LIQUIDITY'
    }
}

/**
 * Calculate the spot price of token0 in terms of token1, and vice versa.
 */
function sqrtPriceToPrice(sqrtPriceX96, token0Decimals = 18, token1Decimals = 18) {
    const sqrtPrice = Number(toBigIntSafe(sqrtPriceX96))
    if (sqrtPrice <= 0) return { priceToken1PerToken0: 0, priceToken0PerToken1: 0 }

    const ratio = sqrtPrice / Number(Q96)
    const rawPrice = ratio * ratio
    const decimalShift = Math.pow(10, Number(token0Decimals) - Number(token1Decimals))
    const priceToken1PerToken0 = rawPrice * decimalShift
    const priceToken0PerToken1 = priceToken1PerToken0 > 0 ? 1 / priceToken1PerToken0 : 0

    return { priceToken1PerToken0, priceToken0PerToken1 }
}

module.exports = {
    Q96,
    MIN_TICK,
    MAX_TICK,
    toBigIntSafe,
    getSqrtRatioAtTick,
    getAmount0Delta,
    getAmount1Delta,
    quoteV3ExactInput,
    quoteV3MultiTick,
    sqrtPriceToPrice
}
