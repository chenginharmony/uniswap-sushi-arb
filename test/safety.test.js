'use strict'

const assert = require('assert')
const { loadConfig } = require('../src/config')
const { optimizeRoute } = require('../src/arbitrage/optimizer')
const { simulate } = require('../src/execution/simulator')

const config = loadConfig({ MIN_NET_PROFIT_USD: '0.20', DRY_RUN: 'true', MAX_OPPORTUNITY_AGE_MS: '150' })
assert.strictEqual(config.dryRun, true)
assert.strictEqual(config.minNetProfitUsd, 0.20)
const route = {
    id: 'r1', tokenIn: 'A', tokenOut: 'B', tokenUsdPrice: 1, stateVersion: 0,
    buyPool: { reserveIn: 1000, reserveOut: 1100, feeBps: 30 },
    sellPool: { reserveIn: 1000, reserveOut: 1300, feeBps: 30 }
}
const candidate = optimizeRoute(route, [100, 250], config)
assert.ok(candidate === null || candidate.expectedNetProfitUsd >= config.minNetProfitUsd)
simulate({ createdAt: Date.now() - 1000 }, { call: async () => ({ success: true, netProfitUsd: 1 }) }, config).then(result => {
    assert.strictEqual(result.success, false)
    console.log('safety-tests-ok')
})
