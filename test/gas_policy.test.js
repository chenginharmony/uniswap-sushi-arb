'use strict'

const assert = require('assert')
const {
    GAS_PROFILES,
    MAX_GAS_CEILING,
    classifyGasProfile,
    validateAndSizeGas
} = require('../src/execution/gas_policy')

async function main() {
    console.log('=== Gas Policy & Bounded Validation Test Suite ===\n')
    let passed = 0, failed = 0

    function pass(label) { console.log(`   ✓ ${label}`); passed++ }
    function fail(label, err) { console.error(`   ✗ ${label}: ${err}`); failed++ }

    // 1. Classification
    console.log('1. Route Classification:')
    try {
        const uniPancakeOpp = {
            buyPool: { dex: 'uniswap' },
            sellPool: { dex: 'pancakeswap' }
        }
        assert.strictEqual(classifyGasProfile(uniPancakeOpp).name, 'STANDARD_CL')
        pass('Uniswap <-> Pancake classified as STANDARD_CL')

        const aeroOpp = {
            buyPool: { dex: 'uniswap' },
            sellPool: { dex: 'aerodrome_slipstream' }
        }
        assert.strictEqual(classifyGasProfile(aeroOpp).name, 'SLIPSTREAM_CL')
        pass('Aerodrome Slipstream route classified as SLIPSTREAM_CL')
    } catch (e) { fail('Classification', e.message) }

    // 2. Default bounded sizing without estimate
    console.log('\n2. Default Sizing (Fast Path):')
    try {
        const uniPancakeOpp = { buyPool: { dex: 'uniswap' }, sellPool: { dex: 'pancakeswap' } }
        const res1 = validateAndSizeGas({}, uniPancakeOpp)
        assert.strictEqual(res1.valid, true)
        assert.strictEqual(res1.gasLimit, 320000n, 'STANDARD_CL default gas limit is 320k')
        pass('STANDARD_CL sizes to bounded 320k gas limit')

        const aeroOpp = { buyPool: { dex: 'aerodrome' }, sellPool: { dex: 'uniswap' } }
        const res2 = validateAndSizeGas({}, aeroOpp)
        assert.strictEqual(res2.valid, true)
        assert.strictEqual(res2.gasLimit, 420000n, 'SLIPSTREAM_CL default gas limit is 420k')
        pass('SLIPSTREAM_CL sizes to bounded 420k gas limit')
    } catch (e) { fail('Default sizing', e.message) }

    // 3. Dynamic sizing with estimate + buffer
    console.log('\n3. Dynamic Sizing with Simulation Estimate:')
    try {
        const uniPancakeOpp = { buyPool: { dex: 'uniswap' }, sellPool: { dex: 'pancakeswap' } }
        // 250k estimated * 1.20 = 300k
        const res = validateAndSizeGas({}, uniPancakeOpp, { estimatedGas: 250000n })
        assert.strictEqual(res.valid, true)
        assert.strictEqual(res.gasLimit, 300000n)
        pass('250k estimate + 20% buffer sized to 300k gas limit')

        // Clamp to minGas (240k)
        const lowRes = validateAndSizeGas({}, uniPancakeOpp, { estimatedGas: 150000n })
        assert.strictEqual(lowRes.valid, true)
        assert.strictEqual(lowRes.gasLimit, 240000n, 'Clamped to minGas 240k')
        pass('Low estimate clamped to minGas 240k')

        // Clamp to maxGas (380k)
        const highRes = validateAndSizeGas({}, uniPancakeOpp, { estimatedGas: 320000n })
        assert.strictEqual(highRes.valid, true)
        assert.strictEqual(highRes.gasLimit, 380000n, 'Clamped to maxGas 380k')
        pass('High estimate clamped to maxGas 380k')
    } catch (e) { fail('Dynamic sizing', e.message) }

    // 4. Policy violations and safety ceiling aborts
    console.log('\n4. Safety Ceiling & Policy Violations:')
    try {
        const uniPancakeOpp = { buyPool: { dex: 'uniswap' }, sellPool: { dex: 'pancakeswap' } }
        
        // Exceeds route envelope (STANDARD_CL maxGas is 380k, upper buffer is 418k)
        const policyExceeded = validateAndSizeGas({}, uniPancakeOpp, { estimatedGas: 450000n })
        assert.strictEqual(policyExceeded.valid, false)
        assert.strictEqual(policyExceeded.reason, 'GAS_POLICY_EXCEEDED')
        pass('450k estimate correctly triggers GAS_POLICY_EXCEEDED for STANDARD_CL')

        // Exceeds absolute ceiling (550k)
        const ceilingExceeded = validateAndSizeGas({}, uniPancakeOpp, { estimatedGas: 600000n })
        assert.strictEqual(ceilingExceeded.valid, false)
        assert.strictEqual(ceilingExceeded.reason, 'GAS_CEILING_EXCEEDED')
        pass('600k estimate correctly triggers GAS_CEILING_EXCEEDED')
    } catch (e) { fail('Safety ceiling', e.message) }

    console.log('\n=============================================================')
    if (failed === 0) {
        console.log(`ALL ${passed} GAS POLICY TESTS PASSED`)
    } else {
        console.log(`${passed} PASSED / ${failed} FAILED`)
        process.exit(1)
    }
    console.log('=============================================================')
}

main().catch(err => {
    console.error('Test crashed:', err)
    process.exit(1)
})
