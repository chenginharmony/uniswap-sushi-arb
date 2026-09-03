'use strict'

const assert = require('assert')
const { calculateProfitability, quoteConstantProduct } = require('../src/arbitrage/profitability')

assert.strictEqual(quoteConstantProduct(100, 1000, 1000, 30) > 0, true)

const belowThreshold = calculateProfitability({
    grossProfitUsd: 0.52,
    dexFeesUsd: 0.14,
    flashloanFeeUsd: 0.03,
    gasCostUsd: 0.04,
    slippageCostUsd: 0.05,
    safetyMarginUsd: 0.04,
    minimumNetProfitUsd: 0.20
})
assert.strictEqual(belowThreshold.expectedNetProfitUsd, 0.22)
assert.strictEqual(belowThreshold.netProfitUsd, 0.22)
assert.strictEqual(belowThreshold.profitable, true)

const rejected = calculateProfitability({
    grossProfitUsd: 0.48,
    dexFeesUsd: 0.14,
    flashloanFeeUsd: 0.03,
    gasCostUsd: 0.04,
    slippageCostUsd: 0.05,
    safetyMarginUsd: 0.04,
    minimumNetProfitUsd: 0.20
})
assert.ok(Math.abs(rejected.expectedNetProfitUsd - 0.18) < 1e-12)
assert.strictEqual(rejected.profitable, false)

for (const minimum of [0.15, 0.20, 0.50]) {
    const result = calculateProfitability({
        grossProfitUsd: minimum + 0.30,
        dexFeesUsd: 0.10,
        flashloanFeeUsd: 0.05,
        gasCostUsd: 0.05,
        minimumNetProfitUsd: minimum
    })
    assert.strictEqual(result.profitable, true)
}

assert.strictEqual(calculateProfitability({ grossProfitUsd: 1, slippageBps: 101, maxSlippageBps: 100, minimumNetProfitUsd: 0 }).profitable, false)
assert.strictEqual(calculateProfitability({ grossProfitUsd: -1, slippageBps: 1000, maxSlippageBps: Infinity, minimumNetProfitUsd: 0 }).slippageCostUsd >= 0, true)

const illiquid = calculateProfitability({ grossProfitUsd: 1, liquiditySufficient: false, minimumNetProfitUsd: 0 })
assert.strictEqual(illiquid.profitable, false)

console.log('profitability-tests-ok')
