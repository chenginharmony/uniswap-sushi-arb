'use strict'

const { quoteV3ExactInput, sqrtPriceToPrice } = require('../arbitrage/v3_math')

/**
 * @title ConcentratedLiquidityV3Adapter
 * @notice Unified quoter and state evaluator for Uniswap V3 forks on Base:
 *   - Uniswap V3
 *   - PancakeSwap V3
 *   - Aerodrome Slipstream (CL)
 *   - SushiSwap V3
 *   - Alien Base V3
 *   - BaseSwap V3
 */
class ConcentratedLiquidityV3Adapter {
    constructor(dexName = 'uniswap-v3') {
        this.dexName = dexName
        this.poolType = 'concentrated_liquidity'
    }

    /**
     * Calculates quote amountOut for an exact token input.
     *
     * @param {Object} pool - Pool state containing sqrtPriceX96, liquidity, feeBps, token0, token1
     * @param {bigint|string|number} amountIn - Exact input amount in base token units (wei)
     * @param {string} tokenIn - Address of token being sold into the pool
     * @returns {Object} Quote result with amountOut, priceImpactBps, and effectivePrice
     */
    quoteExactInput(pool, amountIn, tokenIn) {
        if (!pool || !pool.sqrtPriceX96 || !pool.liquidity) {
            return {
                amountOut: 0n,
                feePaid: 0n,
                priceImpactBps: 0,
                usable: false,
                reason: 'MISSING_POOL_STATE'
            }
        }

        const sqrtPriceX96 = BigInt(pool.sqrtPriceX96)
        const liquidity = BigInt(pool.liquidity)
        if (sqrtPriceX96 <= 0n || liquidity <= 0n) {
            return {
                amountOut: 0n,
                feePaid: 0n,
                priceImpactBps: 0,
                usable: false,
                reason: 'ZERO_LIQUIDITY'
            }
        }

        const feeBps = pool.feeBps !== undefined ? pool.feeBps : (pool.feeTier ? pool.feeTier / 100 : 30)
        const zeroForOne = String(pool.token0).toLowerCase() === String(tokenIn).toLowerCase()

        const quoteRes = quoteV3ExactInput(amountIn, sqrtPriceX96, liquidity, feeBps, zeroForOne)
        const amountOut = quoteRes && quoteRes.amountOut ? BigInt(quoteRes.amountOut) : 0n
        const usable = quoteRes && quoteRes.sufficient !== false && amountOut > 0n

        return {
            amountOut,
            usable,
            feeBps,
            sqrtPriceNextX96: quoteRes ? quoteRes.sqrtPriceNextX96 : null,
            dex: this.dexName
        }
    }

    /**
     * Resolves the spot price of token0 in terms of token1.
     */
    getSpotPrice(pool) {
        if (!pool || !pool.sqrtPriceX96) return 0
        const t0Dec = pool.token0Decimals !== undefined ? pool.token0Decimals : 18
        const t1Dec = pool.token1Decimals !== undefined ? pool.token1Decimals : 18
        return sqrtPriceToPrice(pool.sqrtPriceX96, t0Dec, t1Dec)
    }
}

module.exports = {
    ConcentratedLiquidityV3Adapter
}
