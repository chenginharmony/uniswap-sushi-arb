'use strict'

const assert = require('assert')
const crypto = require('crypto')
const {
    buildFingerprint,
    verifyFingerprintParity,
    normalizeAddress,
    normalizeUint256
} = require('../src/execution/fingerprint')

// ─── Fixtures ───────────────────────────────────────────────────────────────

const BASE_FLASH_PARAMS = {
    flashPool:          '0xB4CB800910B228ED3D0834CF79D697127BBB00e5',
    swapPool1:          '0xb4cb800910b228ed3d0834cf79d697127bbb00e5',
    swapPool2:          '0x72aB388E2e2F6FACEf59E3C3FA2C4e29011c2d38',
    borrowToken:        '0x4200000000000000000000000000000000000006', // WETH
    intermediateToken:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
    borrowAmount:       BigInt('200000000000000000'),   // 0.2 WETH
    minAmountOut1:      BigInt('498000000'),            // 498 USDC
    minAmountOut2:      BigInt('200100000000000000'),   // ~0.2001 WETH
    expectedRepayment:  BigInt('200100000000000000'),   // borrow + flash fee
    minProfitSurplus:   BigInt('461538'),               // ~$1.20 profit in WETH
    deadline:           BigInt(Math.floor(Date.now() / 1000) + 120)
}

const BASE_TX_DATA = {
    from: '0x5018bBCEFBe3aD54C4DE65f621aB0c9c5F12f4f4',
    to:   '0x1c21baaf2537de60daad1f2185b9d7823a56cd85',
    data: '0xf9a95c57' + 'a'.repeat(700), // fake but stable calldata
    value: '0x0',
    chainId: 8453,
    gasLimit: 650000n,
    maxFeePerGas: 100000000n,
    maxPriorityFeePerGas: 10000000n
}

const BASE_CONTEXT = {
    routeId: 'weth-usdc-uni-cake',
    stateVersion: 42
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {
    console.log('=== Phase 4: Fingerprint Parity Test Suite ===\n')
    let passed = 0
    let failed = 0

    function pass(label) { console.log(`   ✓ ${label}`); passed++ }
    function fail(label, err) { console.error(`   ✗ ${label}: ${err}`); failed++ }

    // ─── 1. Address normalisation ────────────────────────────────────────────
    console.log('1. Address & uint256 normalisation:')
    try {
        assert.strictEqual(normalizeAddress('0xB4CB800910B228ED3D0834CF79D697127BBB00e5'),
            '0xb4cb800910b228ed3d0834cf79d697127bbb00e5', 'lowercase')
        assert.strictEqual(normalizeAddress(null),
            '0x0000000000000000000000000000000000000000', 'null → zero addr')
        assert.strictEqual(normalizeUint256(200000000000000000n), '200000000000000000', 'bigint')
        assert.strictEqual(normalizeUint256('0xde0b6b3a7640000'), '1000000000000000000', 'hex string')
        assert.strictEqual(normalizeUint256(0), '0', 'zero')
        pass('Address and uint256 normalisation correct')
    } catch (e) { fail('Normalisation', e.message) }

    // ─── 2. Deterministic hash – identical inputs produce identical hash ─────
    console.log('\n2. Deterministic hash stability:')
    try {
        const fp1 = buildFingerprint(BASE_FLASH_PARAMS, BASE_TX_DATA, BASE_CONTEXT)
        const fp2 = buildFingerprint(BASE_FLASH_PARAMS, BASE_TX_DATA, BASE_CONTEXT)
        assert.strictEqual(fp1.hash, fp2.hash, 'identical inputs → identical hash')
        assert.strictEqual(fp1.canonical, fp2.canonical, 'canonical JSON stable')
        pass(`Deterministic hash: ${fp1.hash.slice(0, 24)}...`)
    } catch (e) { fail('Deterministic hash', e.message) }

    // ─── 3. Perfect parity – no mutations between preflight and signing ──────
    console.log('\n3. Perfect parity (no mutations):')
    try {
        const fpPre  = buildFingerprint(BASE_FLASH_PARAMS, BASE_TX_DATA, BASE_CONTEXT)
        // Simulate gasLimit update only (allowed)
        const txAfterGas = { ...BASE_TX_DATA, gasLimit: 562500n }
        const fpSign = buildFingerprint(BASE_FLASH_PARAMS, txAfterGas, BASE_CONTEXT)

        // calldata & all non-gasLimit fields must still be identical
        assert.strictEqual(fpPre.fields.calldata, fpSign.fields.calldata, 'calldata unchanged')
        assert.strictEqual(fpPre.fields.borrowAmount, fpSign.fields.borrowAmount, 'borrowAmount unchanged')
        assert.strictEqual(fpPre.fields.maxFeePerGas, fpSign.fields.maxFeePerGas, 'maxFeePerGas unchanged')

        const report = verifyFingerprintParity(fpPre, fpSign)
        // gasLimit changed so hash differs — but calldata and param parity is clean
        assert.strictEqual(report.calldataMatch, true, 'calldata parity')
        assert.deepStrictEqual(report.divergedFields, ['gasLimit'], 'only gasLimit diverged')
        pass('gasLimit update → calldataMatch=true, only gasLimit diverges')
    } catch (e) { fail('Perfect parity', e.message) }

    // ─── 4. Calldata mutation is detected ────────────────────────────────────
    console.log('\n4. Calldata mutation detection:')
    try {
        const fpPre = buildFingerprint(BASE_FLASH_PARAMS, BASE_TX_DATA, BASE_CONTEXT)

        // Mutate calldata by flipping one nibble
        const mutatedCalldata = BASE_TX_DATA.data.slice(0, 10) + 'b' + BASE_TX_DATA.data.slice(11)
        const txMutated = { ...BASE_TX_DATA, data: mutatedCalldata }
        const fpSign = buildFingerprint(BASE_FLASH_PARAMS, txMutated, BASE_CONTEXT)

        assert.notStrictEqual(fpPre.hash, fpSign.hash, 'hash changes on calldata mutation')
        const report = verifyFingerprintParity(fpPre, fpSign)
        assert.strictEqual(report.calldataMatch, false, 'calldataMatch=false detected')
        assert.strictEqual(report.parity, false, 'overall parity=false')
        pass('Single nibble calldata mutation correctly detected')
    } catch (e) { fail('Calldata mutation', e.message) }

    // ─── 5. borrowAmount mutation is detected ────────────────────────────────
    console.log('\n5. borrowAmount mutation detection:')
    try {
        const fpPre = buildFingerprint(BASE_FLASH_PARAMS, BASE_TX_DATA, BASE_CONTEXT)
        const mutatedParams = { ...BASE_FLASH_PARAMS, borrowAmount: BASE_FLASH_PARAMS.borrowAmount + 1n }
        const fpSign = buildFingerprint(mutatedParams, BASE_TX_DATA, BASE_CONTEXT)
        const report = verifyFingerprintParity(fpPre, fpSign)
        assert.strictEqual(report.parity, false)
        assert(report.divergedFields.includes('borrowAmount'), 'borrowAmount in divergedFields')
        pass('borrowAmount +1 mutation detected')
    } catch (e) { fail('borrowAmount mutation', e.message) }

    // ─── 6. minProfitSurplus mutation is detected ────────────────────────────
    console.log('\n6. minProfitSurplus mutation detection:')
    try {
        const fpPre = buildFingerprint(BASE_FLASH_PARAMS, BASE_TX_DATA, BASE_CONTEXT)
        const mutatedParams = { ...BASE_FLASH_PARAMS, minProfitSurplus: BigInt(1) }
        const fpSign = buildFingerprint(mutatedParams, BASE_TX_DATA, BASE_CONTEXT)
        const report = verifyFingerprintParity(fpPre, fpSign)
        assert.strictEqual(report.parity, false)
        assert(report.divergedFields.includes('minProfitSurplus'), 'minProfitSurplus in divergedFields')
        pass('minProfitSurplus zeroed-out mutation detected')
    } catch (e) { fail('minProfitSurplus mutation', e.message) }

    // ─── 7. flashPool address substitution is detected ───────────────────────
    console.log('\n7. flashPool substitution detection:')
    try {
        const fpPre = buildFingerprint(BASE_FLASH_PARAMS, BASE_TX_DATA, BASE_CONTEXT)
        const mutatedParams = { ...BASE_FLASH_PARAMS, flashPool: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }
        const fpSign = buildFingerprint(mutatedParams, BASE_TX_DATA, BASE_CONTEXT)
        const report = verifyFingerprintParity(fpPre, fpSign)
        assert.strictEqual(report.parity, false)
        assert(report.divergedFields.includes('flashPool'), 'flashPool in divergedFields')
        pass('flashPool address substitution detected')
    } catch (e) { fail('flashPool substitution', e.message) }

    // ─── 8. maxFeePerGas mutation is detected ────────────────────────────────
    console.log('\n8. maxFeePerGas mutation detection:')
    try {
        const fpPre = buildFingerprint(BASE_FLASH_PARAMS, BASE_TX_DATA, BASE_CONTEXT)
        const mutatedTx = { ...BASE_TX_DATA, maxFeePerGas: 999999999999n }
        const fpSign = buildFingerprint(BASE_FLASH_PARAMS, mutatedTx, BASE_CONTEXT)
        const report = verifyFingerprintParity(fpPre, fpSign)
        assert.strictEqual(report.parity, false)
        assert(report.divergedFields.includes('maxFeePerGas'), 'maxFeePerGas in divergedFields')
        pass('maxFeePerGas mutation detected')
    } catch (e) { fail('maxFeePerGas mutation', e.message) }

    // ─── 9. stateVersion change is captured ──────────────────────────────────
    console.log('\n9. stateVersion divergence captured in fingerprint:')
    try {
        const fpPre  = buildFingerprint(BASE_FLASH_PARAMS, BASE_TX_DATA, { ...BASE_CONTEXT, stateVersion: 42 })
        const fpSign = buildFingerprint(BASE_FLASH_PARAMS, BASE_TX_DATA, { ...BASE_CONTEXT, stateVersion: 43 })
        assert.notStrictEqual(fpPre.hash, fpSign.hash, 'hash differs with stateVersion change')
        const report = verifyFingerprintParity(fpPre, fpSign)
        assert(report.divergedFields.includes('stateVersion'), 'stateVersion in divergedFields')
        pass('stateVersion 42→43 change captured in fingerprint hash')
    } catch (e) { fail('stateVersion divergence', e.message) }

    // ─── 10. Null fingerprint guard ──────────────────────────────────────────
    console.log('\n10. Null fingerprint guard:')
    try {
        const report = verifyFingerprintParity(null, null)
        assert.strictEqual(report.parity, false)
        assert(report.divergedFields.includes('FINGERPRINT_MISSING'))
        pass('null fingerprints correctly rejected with FINGERPRINT_MISSING')
    } catch (e) { fail('Null guard', e.message) }

    // ─── 11. Controller integration: parity gate rejects mutation ───────────
    console.log('\n11. ExecutionController fingerprint parity gate (integration):')
    try {
        const { ExecutionController } = require('../src/execution/controller')

        // Craft a minimal valid opportunity
        const opp = {
            id: 'fp-test-opp',
            status: 'PROFITABLE',
            profitable: true,
            createdAt: Date.now(),
            stateVersion: 5,
            routeId: 'weth-usdc-test',
            optimalSizeUsd: 500,
            peakNetProfitUsd: 1.50,
            expectedNetProfitUsd: 1.50,
            tokenIn:  '0x4200000000000000000000000000000000000006',
            tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            tokenInDecimals: 18,
            tokenOutDecimals: 6,
            tokenUsdPrice: 2500,
            optimalSizeTokens: 0.2,
            expectedIntermediateOutput: 500000000n,
            expectedFinalOutput:        201000000000000000n,
            buyPool:  { address: '0xb4cb800910b228ed3d0834cf79d697127bbb00e5', dex: 'uniswap',     feeTier: 500 },
            sellPool: { address: '0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38', dex: 'pancakeswap', feeTier: 100 }
        }

        // Mock preflight that succeeds
        const mockPreflight = async () => ({ simulated: true, success: true, reverted: false })

        const ctrl = new ExecutionController({
            maxSizeUsd: 10000,
            minProfitUsd: 0.50,
            maxOpportunityAgeMs: 5000,
            preflight: mockPreflight
        })

        // State version stable → parity must pass
        let liveStateVersion = 5
        const receipt = await ctrl.processOpportunity(opp, {
            now: Date.now(),
            currentVersion: 5,
            getStateVersion: () => liveStateVersion
        })

        assert.strictEqual(receipt.executed, true, 'executed=true when parity holds')
        assert.strictEqual(receipt.fingerprintParity, true, 'fingerprintParity=true in receipt')
        assert.ok(receipt.fingerprintHash, 'fingerprintHash present in receipt')
        pass(`Controller DRY_RUN with parity: fingerprintHash=${receipt.fingerprintHash.slice(0, 16)}...`)
    } catch (e) { fail('Controller integration', e.message) }

    // ─── 12. Controller integration: post-preflight state-version gate ───────
    console.log('\n12. Controller post-preflight state-version divergence gate:')
    try {
        const { ExecutionController } = require('../src/execution/controller')

        const opp = {
            id: 'fp-stale-opp',
            status: 'PROFITABLE',
            profitable: true,
            createdAt: Date.now(),
            stateVersion: 10,
            routeId: 'weth-usdc-gate-test',
            optimalSizeUsd: 500,
            peakNetProfitUsd: 1.50,
            expectedNetProfitUsd: 1.50,
            tokenIn:  '0x4200000000000000000000000000000000000006',
            tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            tokenInDecimals: 18,
            tokenOutDecimals: 6,
            tokenUsdPrice: 2500,
            optimalSizeTokens: 0.2,
            expectedIntermediateOutput: 500000000n,
            expectedFinalOutput:        201000000000000000n,
            buyPool:  { address: '0xb4cb800910b228ed3d0834cf79d697127bbb00e5', dex: 'uniswap',     feeTier: 500 },
            sellPool: { address: '0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38', dex: 'pancakeswap', feeTier: 100 }
        }

        // Simulate Flashblock arriving DURING the eth_call round-trip
        let preflightCalls = 0
        let liveVersion = 10
        const mockPreflightWithVersionJump = async () => {
            preflightCalls++
            // Simulate 10ms for eth_call during which a Flashblock bumps the version
            await new Promise(r => setTimeout(r, 10))
            liveVersion = 11 // ← new Flashblock arrived!
            return { simulated: true, success: true, reverted: false }
        }

        const ctrl = new ExecutionController({
            maxSizeUsd: 10000,
            minProfitUsd: 0.50,
            maxOpportunityAgeMs: 5000,
            preflight: mockPreflightWithVersionJump
        })

        const result = await ctrl.processOpportunity(opp, {
            now: Date.now(),
            currentVersion: 10,
            getStateVersion: () => liveVersion
        })

        assert.strictEqual(result.executed, false, 'executed=false after state-version divergence')
        assert.strictEqual(result.reason, 'STATE_VERSION_DIVERGED_POST_PREFLIGHT', 'correct abort reason')
        assert.strictEqual(result.preflightStateVersion, 10, 'preflightStateVersion=10')
        assert.strictEqual(result.currentStateVersion, 11, 'currentStateVersion=11')
        pass('Post-preflight state-version divergence correctly aborts (10→11)')
    } catch (e) { fail('Post-preflight state gate', e.message) }

    // ─── Summary ─────────────────────────────────────────────────────────────
    console.log('\n=============================================================')
    if (failed === 0) {
        console.log(`ALL ${passed} FINGERPRINT PARITY TESTS PASSED`)
    } else {
        console.log(`${passed} PASSED / ${failed} FAILED`)
    }
    console.log('=============================================================')

    if (failed > 0) process.exit(1)
}

main().catch(err => {
    console.error('Test suite crashed:', err)
    process.exit(1)
})
