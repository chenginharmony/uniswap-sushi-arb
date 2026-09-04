'use strict'

/**
 * @title AerodromeV1Adapter
 * @notice High-performance in-memory quoter for Aerodrome V1 pools on Base Mainnet.
 * Supports:
 *   - Volatile pools: Constant-product AMM (x * y = k) with pool fee
 *   - Stable pools: Solidly curve (x^3 * y + y^3 * x = k) with Newton's method solver
 */
class AerodromeV1Adapter {
    constructor() {
        this.dexName = 'aerodrome-v1'
        this.poolType = 'v1_amm'
    }

    /**
     * Internal scaling function to normalize token amounts to 18 decimals.
     */
    _scale(amount, decimals) {
        const d = BigInt(decimals !== undefined ? decimals : 18)
        if (d === 18n) return BigInt(amount)
        if (d < 18n) return BigInt(amount) * (10n ** (18n - d))
        return BigInt(amount) / (10n ** (d - 18n))
    }

    /**
     * Unscale 18 decimal normalized amount back to native token decimals.
     */
    _unscale(amount, decimals) {
        const d = BigInt(decimals !== undefined ? decimals : 18)
        if (d === 18n) return BigInt(amount)
        if (d < 18n) return BigInt(amount) / (10n ** (18n - d))
        return BigInt(amount) * (10n ** (d - 18n))
    }

    /**
     * Solidly stable invariant function f(x, y) = x^3 * y + y^3 * x.
     */
    _f(x, y) {
        const x2 = (x * x) / 1000000000000000000n
        const y2 = (y * y) / 1000000000000000000n
        const xy = (x * y) / 1000000000000000000n
        return (xy * (x2 + y2)) / 1000000000000000000n
    }

    /**
     * Derivative d/dy [f(x, y)] = x^3 + 3 * x * y^2.
     */
    _d(x, y) {
        const x3 = (x * x * x) / 1000000000000000000000000000000000000n
        const y2 = (y * y) / 1000000000000000000n
        const xy2_3 = (3n * x * y2) / 1000000000000000000n
        return x3 + xy2_3
    }

    /**
     * Newton-Raphson root solver for Solidly stable curve getAmountOut.
     */
    _getY(x0, targetK, yInit) {
        let y = yInit
        for (let i = 0; i < 255; i++) {
            const yPrev = y
            const k = this._f(x0, y)
            const d = this._d(x0, y)
            if (d === 0n) break

            if (k < targetK) {
                const dy = ((targetK - k) * 1000000000000000000n) / d
                y = y + dy
            } else {
                const dy = ((k - targetK) * 1000000000000000000n) / d
                y = y > dy ? y - dy : 0n
            }

            const diff = y > yPrev ? y - yPrev : yPrev - y
            if (diff <= 1n) return y
        }
        return y
    }

    /**
     * Quote amountOut for an exact token input on Aerodrome V1.
     *
     * @param {Object} pool - Pool state with reserve0, reserve1, token0, token1, stable, feeBps
     * @param {bigint|string|number} amountIn - Exact input in base token units
     * @param {string} tokenIn - Address of token being swapped in
     * @returns {Object} Quote result with amountOut, feePaid, and usable flag
     */
    quoteExactInput(pool, amountIn, tokenIn) {
        if (!pool || pool.reserve0 === undefined || pool.reserve1 === undefined) {
            return { amountOut: 0n, feePaid: 0n, usable: false, reason: 'MISSING_RESERVES' }
        }

        const aIn = BigInt(amountIn)
        if (aIn <= 0n) return { amountOut: 0n, feePaid: 0n, usable: false, reason: 'ZERO_INPUT' }

        const isZeroForOne = String(pool.token0).toLowerCase() === String(tokenIn).toLowerCase()
        const rIn = isZeroForOne ? BigInt(pool.reserve0) : BigInt(pool.reserve1)
        const rOut = isZeroForOne ? BigInt(pool.reserve1) : BigInt(pool.reserve0)

        if (rIn <= 0n || rOut <= 0n) {
            return { amountOut: 0n, feePaid: 0n, usable: false, reason: 'ZERO_RESERVES' }
        }

        const feeBps = BigInt(pool.feeBps !== undefined ? pool.feeBps : (pool.stable ? 5 : 30))
        const feeAmount = (aIn * feeBps) / 10000n
        const amountInAfterFee = aIn - feeAmount

        if (!pool.stable) {
            // Constant Product: x * y = k
            // amountOut = (amountInAfterFee * rOut) / (rIn + amountInAfterFee)
            const numerator = amountInAfterFee * rOut
            const denominator = rIn + amountInAfterFee
            const amountOut = numerator / denominator

            return {
                amountOut,
                feePaid: feeAmount,
                usable: amountOut > 0n,
                stable: false,
                dex: 'aerodrome-v1'
            }
        } else {
            // Solidly Stable Curve: x^3 * y + y^3 * x = k
            const decIn = isZeroForOne ? pool.token0Decimals : pool.token1Decimals
            const decOut = isZeroForOne ? pool.token1Decimals : pool.token0Decimals

            const xNorm = this._scale(rIn, decIn)
            const yNorm = this._scale(rOut, decOut)
            const targetK = this._f(xNorm, yNorm)

            const aInNorm = this._scale(amountInAfterFee, decIn)
            const xNewNorm = xNorm + aInNorm
            const yNewNorm = this._getY(xNewNorm, targetK, yNorm)

            if (yNewNorm >= yNorm) {
                return { amountOut: 0n, feePaid: feeAmount, usable: false, reason: 'CURVE_OVERFLOW' }
            }

            const amountOutNorm = yNorm - yNewNorm
            const amountOut = this._unscale(amountOutNorm, decOut)

            return {
                amountOut,
                feePaid: feeAmount,
                usable: amountOut > 0n,
                stable: true,
                dex: 'aerodrome-v1'
            }
        }
    }
}

module.exports = {
    AerodromeV1Adapter
}
