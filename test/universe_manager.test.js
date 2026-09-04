'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { UniverseManager } = require('../src/discovery/universe_manager')

async function runTests() {
    console.log('=== Universe Manager Test Suite ===\n')

    const testHot = path.resolve(__dirname, '../scratch/test_hot_universe.json')
    const testDisc = path.resolve(__dirname, '../scratch/test_disc_universe.json')

    const manager = new UniverseManager({
        maxHotPools: 3,
        hotUniverseFile: testHot,
        discoveryFile: testDisc
    })

    // Test 1: Register pools
    console.log('Test 1: Register Pool Candidates:')
    const samplePools = [
        { address: '0xPool1', token0: '0xWETH', token1: '0xUSDC', token0Symbol: 'WETH', token1Symbol: 'USDC', liquidityUsd: 1000000, dex: 'uniswap' },
        { address: '0xPool2', token0: '0xWETH', token1: '0xUSDC', token0Symbol: 'WETH', token1Symbol: 'USDC', liquidityUsd: 500000, dex: 'pancakeswap' },
        { address: '0xPool3', token0: '0xWETH', token1: '0xUSDC', token0Symbol: 'WETH', token1Symbol: 'USDC', liquidityUsd: 2000000, dex: 'aerodrome_slipstream' },
        { address: '0xPool4', token0: '0xDEAD', token1: '0xUSDC', token0Symbol: 'DEAD', token1Symbol: 'USDC', liquidityUsd: 500, dex: 'uniswap' },
        { address: '0xZeroLiq', token0: '0xWETH', token1: '0xUSDC', token0Symbol: 'WETH', token1Symbol: 'USDC', liquidity: 0n, reserve0: 0n, reserve1: 0n }
    ]

    const added = manager.registerPools(samplePools)
    assert.strictEqual(added, 5, 'Must register all 5 pools')
    console.log(`   ✓ Registered ${added} candidate pools`)

    // Test 2: Recompute Hot Universe & Eligibility Filtering
    console.log('\nTest 2: Recompute Hot Universe with Scoring & Promotion:')
    const diag = manager.recomputeHotUniverse()
    assert.strictEqual(diag.totalRegistered, 5)
    assert.strictEqual(diag.eligibleCandidates, 4, 'Zero liquidity pool must be filtered out')
    assert.strictEqual(diag.hotPromotedCount, 3, 'Hot pool count must be capped at maxHotPools=3')
    assert.ok(manager.isHot('0xPool3'), 'Highest TVL pool (Pool 3) must be promoted to hot')
    assert.ok(manager.isHot('0xPool1'), 'Pool 1 must be in hot')
    assert.ok(!manager.isHot('0xPool4'), 'Low liquidity Pool 4 must be demoted out of hot')
    console.log(`   ✓ Hot Universe capped at: ${diag.hotPromotedCount} pools`)
    console.log(`   ✓ Filtered zero-liquidity pools cleanly`)
    console.log(`   ✓ Top score pool promoted: ${manager.getHotPools()[0].address}`)

    // Test 3: Disk persistence & restore
    console.log('\nTest 3: Disk Persistence & Clean Recovery:')
    assert.strictEqual(manager.saveToDisk(), true, 'Must save successfully')
    assert.ok(fs.existsSync(testHot), 'Hot universe file created')
    assert.ok(fs.existsSync(testDisc), 'Discovery file created')

    const newManager = new UniverseManager({
        maxHotPools: 3,
        hotUniverseFile: testHot,
        discoveryFile: testDisc
    })
    assert.strictEqual(newManager.loadFromDisk(), true, 'Must restore successfully')
    assert.strictEqual(newManager.getHotPools().length, 3, 'Restored hot pools length matches')
    console.log(`   ✓ Restored ${newManager.getHotPools().length} hot pools from disk`)

    console.log('\n=============================================================')
    console.log('ALL UNIVERSE MANAGER TESTS PASSED')
    console.log('=============================================================')
}

runTests().catch(err => {
    console.error('Test failed:', err)
    process.exit(1)
})
