'use strict'

const assert = require('assert')
const { loadConfig } = require('../src/config')
const { PoolStateManager } = require('../src/arbitrage/state')
const { AerodromeAdapter, UniswapV3Adapter } = require('../src/pools/adapters')
const { PoolStateBootstrapper } = require('../src/pools/bootstrap')

const factory = '0x1000000000000000000000000000000000000001'
const tokenA = '0x2000000000000000000000000000000000000002'
const tokenB = '0x3000000000000000000000000000000000000003'
const pool = '0x4000000000000000000000000000000000000004'

function fakeProvider() {
    const calls = []
    return {
        calls,
        async call(address, abi, method, args) {
            calls.push({ address, method, args })
            if (address === factory && method === 'getPool') return pool
            if (address === factory && method === 'getPair') return pool
            if (address === pool && method === 'token0') return tokenA
            if (address === pool && method === 'token1') return tokenB
            if (address === pool && method === 'getReserves') return ['1000', '2000', '1']
            if (address === tokenA && method === 'decimals') return '18'
            if (address === tokenB && method === 'decimals') return '6'
            if (address === tokenA && method === 'symbol') return 'WETH'
            if (address === tokenB && method === 'symbol') return 'USDC'
            throw new Error(`unexpected call ${address} ${method}`)
        }
    }
}

async function main() {
    const provider = fakeProvider()
    const adapter = new AerodromeAdapter({
        provider,
        factoryAddress: factory,
        pools: [{ token0: tokenA, token1: tokenB, stable: false, feeBps: 30 }]
    })
    const state = new PoolStateManager()
    const bootstrapper = new PoolStateBootstrapper({
        state,
        provider,
        adapters: [adapter]
    })
    const records = await bootstrapper.bootstrap()
    assert.strictEqual(records.length, 1)
    assert.strictEqual(state.pools.get(pool).reserve0, '1000')
    assert.strictEqual(state.pools.get(pool).token1Symbol, 'USDC')
    assert.strictEqual(state.pools.get(pool).feeBps, 30)
    assert.strictEqual(state.version, 1)
    assert.deepStrictEqual(await bootstrapper.reconcile(2), [])
    assert.strictEqual(state.version, 1)

    assert.deepStrictEqual(bootstrapper.affectedPools({
        logs: [{ address: pool, event: 'Transfer' }]
    }), [])
    assert.deepStrictEqual(bootstrapper.affectedPools({
        logs: [{ address: pool, event: 'Swap' }]
    }), [pool.toLowerCase()])

    const config = loadConfig({
        BASE_RPC_URL: 'https://base.example',
        BASE_WS_URL: 'wss://base.example',
        BASE_POOL_CONFIG_JSON: JSON.stringify([{ adapter: 'aerodrome', factory, token0: tokenA, token1: tokenB, stable: false }])
    })
    assert.strictEqual(config.base.rpcUrl, 'https://base.example')
    assert.strictEqual(config.base.wsUrl, 'wss://base.example')
    assert.strictEqual(config.base.poolConfigs.length, 1)

    const v3 = new UniswapV3Adapter({
        provider,
        factoryAddress: factory,
        pools: [{ address: pool, fee: 3000 }]
    })
    assert.strictEqual(v3.name, 'uniswap-v3')

    // Test PoolDiscoveryPipeline classification
    const { PoolDiscoveryPipeline, CLASSIFICATION } = require('../src/pools/discovery')
    const pipeline = new PoolDiscoveryPipeline({ provider })
    const candidate = { address: pool, adapter: 'uniswap-v3' }
    const bootstrapped = {
        address: pool,
        token0: tokenA,
        token1: tokenB,
        token0Decimals: 18,
        token1Decimals: 6,
        reserve0: '1000',
        reserve1: '2000'
    }
    const report = pipeline.classifyPool(candidate, bootstrapped, [bootstrapped])
    assert.strictEqual(report.usable, true)
    assert.strictEqual(report.stage, CLASSIFICATION.USABLE)

    console.log('pools-tests-ok')
}

main().catch(error => { console.error(error); process.exitCode = 1 })