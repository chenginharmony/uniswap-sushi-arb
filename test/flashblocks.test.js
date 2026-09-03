'use strict'

const assert = require('assert')
const { parseFlashblockMessage } = require('../src/flashblocks/parser')
const { BoundedEventQueue } = require('../src/flashblocks/queue')
const { PoolStateManager } = require('../src/arbitrage/state')
const { opportunityFromRoute, isFresh } = require('../src/arbitrage/engine')

const event = parseFlashblockMessage({ params: { result: { transaction: { hash: '0xabc', from: '0x1', to: '0x2', input: '0x123', value: '0x0' }, flashblock: 'fb-1' } } })
assert.strictEqual(event.transactionHash, '0xabc')
assert.strictEqual(event.input, '0x123')
assert.strictEqual(event.context, 'fb-1')
assert.throws(() => parseFlashblockMessage({ result: {} }), /missing transaction hash or input/)

const queue = new BoundedEventQueue(2)
queue.push(1); queue.push(2); queue.push(3)
assert.deepStrictEqual([queue.items.shift(), queue.items.shift()], [2, 3])
assert.strictEqual(queue.dropped, 1)

const state = new PoolStateManager()
state.upsertPool({ address: 'pool-a', token0: '0xaaa', token1: '0xbbb', reserve0: 1000, reserve1: 1000, feeBps: 30 })
state.upsertPool({ address: 'pool-b', token0: '0xbbb', token1: '0xccc', reserve0: 1000, reserve1: 2000, feeBps: 30 })
state.registerRoute({ id: 'route-a', pools: ['pool-a'], buyPool: { reserveIn: 1000, reserveOut: 1100, feeBps: 30 }, sellPool: { reserveIn: 1000, reserveOut: 1200, feeBps: 30 }, tokenIn: '0xaaa', tokenOut: '0xbbb', tokenUsdPrice: 1 })
assert.deepStrictEqual(state.routesForPools(['pool-a']).map(route => route.id), ['route-a'])
const opportunity = opportunityFromRoute(state.routes.get('route-a'), 10, { minNetProfitUsd: 0, minProfitMarginBps: 0, maxSlippageBps: Infinity, safetyMarginUsd: 0 })
assert.ok(opportunity.netProfitUsd > 0)
assert.strictEqual(opportunityFromRoute(state.routes.get('route-a'), 10, { minNetProfitUsd: 0.20, minProfitMarginBps: 0, maxSlippageBps: Infinity, safetyMarginUsd: 0 }).profitable, true)
assert.strictEqual(opportunityFromRoute(state.routes.get('route-a'), 10, { minNetProfitUsd: 0.20, minProfitMarginBps: 0, maxSlippageBps: Infinity, safetyMarginUsd: 3 }).profitable, false)
assert.strictEqual(isFresh(opportunity, state.version, 150), true)
assert.strictEqual(isFresh(opportunity, state.version, 150, opportunity.createdAt + 151), false)
assert.strictEqual(isFresh(opportunity, state.version + 1, 150), false)

console.log('flashblocks-tests-ok')
