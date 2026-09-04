'use strict'

const assert = require('assert')
const { PoolScanner, FACTORIES } = require('../src/discovery/pool_scanner')

async function runTests() {
    console.log('=== Pool Scanner Test Suite ===\n')

    assert.ok(FACTORIES.uniswap_v3, 'Uniswap V3 factory configured')
    assert.ok(FACTORIES.aerodrome_v1, 'Aerodrome V1 factory configured')
    assert.ok(FACTORIES.sushiswap_v3, 'SushiSwap V3 factory configured')

    const mockBroadcaster = {
        async rpcCall(method, params) {
            const calldata = params[0].data
            // If getPool(0x1698ee82)
            if (calldata.startsWith('0x1698ee82')) {
                return { result: '0x0000000000000000000000001111111111111111111111111111111111111111' }
            }
            // If aero getPool(0x79bc57d5)
            if (calldata.startsWith('0x79bc57d5')) {
                return { result: '0x0000000000000000000000002222222222222222222222222222222222222222' }
            }
            return { result: '0x0' }
        }
    }

    const scanner = new PoolScanner(mockBroadcaster)

    const weth = { address: '0xWETH', symbol: 'WETH', decimals: 18 }
    const usdc = { address: '0xUSDC', symbol: 'USDC', decimals: 6 }

    console.log('Test 1: Multi-Factory Candidate Discovery:')
    const pools = await scanner.scanTokenPair(weth, usdc)
    assert.ok(pools.length >= 5, 'Must discover multiple pools across factories')
    assert.ok(pools.some(p => p.dex === 'uniswap'), 'Contains Uniswap V3 pools')
    assert.ok(pools.some(p => p.dex === 'aerodrome-v1'), 'Contains Aerodrome V1 pools')
    assert.ok(pools.some(p => p.dex === 'sushiswap'), 'Contains SushiSwap V3 pools')
    console.log(`   ✓ Discovered ${pools.length} candidate pools across all DEX protocols`)

    console.log('\n=============================================================')
    console.log('ALL POOL SCANNER TESTS PASSED')
    console.log('=============================================================')
}

runTests().catch(err => {
    console.error('Test failed:', err)
    process.exit(1)
})
