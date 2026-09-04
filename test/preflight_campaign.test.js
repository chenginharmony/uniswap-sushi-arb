'use strict'
process.env.NODE_ENV = 'test'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { PreflightCampaign, classifyOutcome, OUTCOME } = require('../src/monitoring/preflight_campaign')
const { ExecutionController } = require('../src/execution/controller')

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeOpp(overrides = {}) {
    return Object.assign({
        id: 'test-opp',
        status: 'PROFITABLE',
        profitable: true,
        createdAt: Date.now(),
        stateVersion: 7,
        routeId: 'weth-usdc-route',
        optimalSizeUsd: 500,
        peakNetProfitUsd: 1.80,
        expectedNetProfitUsd: 1.80,
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
    }, overrides)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpLog() {
    return path.join(os.tmpdir(), `campaign_test_${Date.now()}.jsonl`)
}

async function main() {
    console.log('=== Phase 5: Preflight Campaign Logger Test Suite ===\n')
    let passed = 0, failed = 0

    function pass(label) { console.log(`   ✓ ${label}`); passed++ }
    function fail(label, err) { console.error(`   ✗ ${label}: ${err}`); failed++ }

    // ── 1. classifyOutcome – SUCCESS ─────────────────────────────────────────
    console.log('1. classifyOutcome — SUCCESS:')
    try {
        const receipt = { executed: true, fingerprintParity: true }
        assert.strictEqual(classifyOutcome(receipt, null), OUTCOME.SUCCESS)
        pass('executed + fingerprintParity → PREFLIGHT_SUCCESS')
    } catch (e) { fail('SUCCESS classification', e.message) }

    // ── 2. classifyOutcome – PREFLIGHT_REVERT variants ───────────────────────
    console.log('\n2. classifyOutcome — revert variants:')
    try {
        const insufficient = classifyOutcome(
            { executed: false, reason: 'PREFLIGHT_SIMULATION_REVERTED', revertReason: 'InsufficientProfit' },
            'InsufficientProfit'
        )
        assert.strictEqual(insufficient, OUTCOME.INSUFFICIENT_PROFIT)
        pass('InsufficientProfit revert → PREFLIGHT_INSUFFICIENT_PROFIT')

        const lok = classifyOutcome(
            { executed: false, reason: 'PREFLIGHT_SIMULATION_REVERTED', revertReason: 'LOK' },
            'LOK'
        )
        assert.strictEqual(lok, OUTCOME.LOK)
        pass('LOK revert → PREFLIGHT_LOK')

        const other = classifyOutcome(
            { executed: false, reason: 'PREFLIGHT_SIMULATION_REVERTED', revertReason: 'SafeTransferFailed' },
            'SafeTransferFailed'
        )
        assert.strictEqual(other, OUTCOME.OTHER_REVERT)
        pass('Unknown revert → PREFLIGHT_OTHER_REVERT')
    } catch (e) { fail('Revert variants', e.message) }

    // ── 3. classifyOutcome – STALE + STATE_DIVERGED ──────────────────────────
    console.log('\n3. classifyOutcome — stale and state divergence:')
    try {
        assert.strictEqual(classifyOutcome({ executed: false, reason: 'OPPORTUNITY_STALE' }, null), OUTCOME.STALE)
        pass('OPPORTUNITY_STALE → PREFLIGHT_STALE')

        assert.strictEqual(classifyOutcome({ executed: false, reason: 'STATE_VERSION_DIVERGED' }, null), OUTCOME.STALE)
        pass('STATE_VERSION_DIVERGED (pre-preflight) → PREFLIGHT_STALE')

        assert.strictEqual(classifyOutcome({ executed: false, reason: 'STATE_VERSION_DIVERGED_POST_PREFLIGHT' }, null), OUTCOME.STATE_DIVERGED)
        pass('STATE_VERSION_DIVERGED_POST_PREFLIGHT → PREFLIGHT_STATE_DIVERGED')
    } catch (e) { fail('Stale/diverged classification', e.message) }

    // ── 4. classifyOutcome – ECONOMIC_FILTER ─────────────────────────────────
    console.log('\n4. classifyOutcome — economic filters:')
    try {
        for (const reason of ['NOT_PROFITABLE', 'BELOW_MIN_PROFIT_THRESHOLD', 'EXCEEDS_MAX_SIZE_LIMIT',
                              'STATE_REVALIDATION_FAILED', 'RECALCULATED_PROFIT_INSUFFICIENT']) {
            const outcome = classifyOutcome({ executed: false, reason }, null)
            assert.strictEqual(outcome, OUTCOME.ECONOMIC_FILTER, `${reason} should be ECONOMIC_FILTER`)
        }
        pass('All 5 economic filter reasons → PREFLIGHT_ECONOMIC_FILTER')
    } catch (e) { fail('Economic filter classification', e.message) }

    // ── 5. classifyOutcome – FINGERPRINT_FAILED ──────────────────────────────
    console.log('\n5. classifyOutcome — fingerprint failure:')
    try {
        const res = classifyOutcome({ executed: false, reason: 'FINGERPRINT_PARITY_FAILED' }, null)
        assert.strictEqual(res, OUTCOME.FINGERPRINT_FAILED)
        pass('FINGERPRINT_PARITY_FAILED → PREFLIGHT_FINGERPRINT_FAILED')
    } catch (e) { fail('Fingerprint fail classification', e.message) }

    // ── 6. classifyOutcome – BUILD_ERROR ─────────────────────────────────────
    console.log('\n6. classifyOutcome — build errors:')
    try {
        for (const reason of ['MISSING_POOL_STATE', 'ZERO_BORROW_AMOUNT', 'LOK_RISK_ABORTED', 'NO_VALID_FLASH_POOL']) {
            const res = classifyOutcome({ executed: false, reason }, null)
            assert.strictEqual(res, OUTCOME.BUILD_ERROR, `${reason} should be BUILD_ERROR`)
        }
        pass('MISSING_POOL_STATE / ZERO_BORROW_AMOUNT / LOK_RISK_ABORTED / NO_VALID_FLASH_POOL → PREFLIGHT_BUILD_ERROR')
    } catch (e) { fail('Build error classification', e.message) }

    // ── 7. Campaign counters and JSONL persistence ───────────────────────────
    console.log('\n7. Campaign counters and JSONL persistence:')
    try {
        const log = tmpLog()
        const camp = new PreflightCampaign({ logPath: log, verbose: false })

        const opp = makeOpp()
        const fp = { flashPool: '0xb4cb800910b228ed3d0834cf79d697127bbb00e5', borrowAmount: 200000000000000000n, expectedRepayment: 200100000000000000n, minProfitSurplus: 461538n, swapPool1: '0xb4cb800910b228ed3d0834cf79d697127bbb00e5', swapPool2: '0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38' }

        // Record a success
        camp.record({ executed: true, fingerprintParity: true, fingerprintHash: 'abc123', gasLimit: '350000' }, opp, fp, {
            preflightLatencyMs: 22,
            stateVersion: 7,
            opportunityAgeMs: 12,
            estimatedGas: 280000n,
            fingerprintHash: 'abc123'
        })
        // Record a revert
        camp.record({ executed: false, reason: 'PREFLIGHT_SIMULATION_REVERTED', revertReason: 'InsufficientProfit' }, opp, fp, {
            preflightLatencyMs: 18,
            stateVersion: 7,
            revertReason: 'InsufficientProfit'
        })
        // Record a stale
        camp.record({ executed: false, reason: 'OPPORTUNITY_STALE' }, opp, null, { opportunityAgeMs: 350, stateVersion: 7 })

        const summary = camp.getSummary()
        assert.strictEqual(summary.counts[OUTCOME.SUCCESS], 1, 'success count')
        assert.strictEqual(summary.counts[OUTCOME.INSUFFICIENT_PROFIT], 1, 'insufficient count')
        assert.strictEqual(summary.counts[OUTCOME.STALE], 1, 'stale count')
        assert.strictEqual(summary.total, 3, 'total 3 records')
        assert.strictEqual(summary.recentSuccesses.length, 1, '1 recent success')
        pass(`Counters correct: success=${summary.counts[OUTCOME.SUCCESS]} insuff=${summary.counts[OUTCOME.INSUFFICIENT_PROFIT]} stale=${summary.counts[OUTCOME.STALE]}`)

        // Verify JSONL was written
        const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
        assert.strictEqual(lines.length, 3, 'JSONL has 3 records')
        const first = JSON.parse(lines[0])
        assert.strictEqual(first.outcome, OUTCOME.SUCCESS)
        assert.strictEqual(first.routeId, 'weth-usdc-route')
        assert.strictEqual(first.stateVersion, 7)
        assert.ok(first.preflightLatencyMs >= 0, 'preflightLatencyMs present')
        assert.ok(first.fingerprintHash, 'fingerprintHash present')
        pass('JSONL: 3 records persisted with correct outcome, routeId, stateVersion, fingerprintHash')

        // Cleanup
        try { fs.unlinkSync(log) } catch (e) {}
    } catch (e) { fail('Campaign counters / JSONL', e.message) }

    // ── 8. Campaign success rate calculation ──────────────────────────────────
    console.log('\n8. Success rate calculation:')
    try {
        const camp = new PreflightCampaign({ logPath: tmpLog(), verbose: false })
        const opp = makeOpp()
        // 3 successes, 2 reverts
        for (let i = 0; i < 3; i++) camp.record({ executed: true, fingerprintParity: true }, opp, null, {})
        for (let i = 0; i < 2; i++) camp.record({ executed: false, reason: 'PREFLIGHT_SIMULATION_REVERTED', revertReason: 'InsufficientProfit' }, opp, null, {})
        const s = camp.getSummary()
        assert.strictEqual(s.successRate, '60.0')
        pass(`Success rate: ${s.successRate}% (3/5)`)
    } catch (e) { fail('Success rate', e.message) }

    // ── 9. Controller integration — campaign wired via injection ─────────────
    console.log('\n9. Controller integration — campaign records DRY_RUN_VERIFIED:')
    try {
        const log = tmpLog()
        const camp = new PreflightCampaign({ logPath: log, verbose: false })
        const mockPreflight = async () => ({ simulated: true, success: true, reverted: false, estimatedGas: 280000n })

        const ctrl = new ExecutionController({
            maxSizeUsd: 10000, minProfitUsd: 0.50, maxOpportunityAgeMs: 5000,
            preflight: mockPreflight, campaign: camp
        })

        const opp = makeOpp()
        const receipt = await ctrl.processOpportunity(opp, { now: Date.now(), currentVersion: 7, getStateVersion: () => 7 })

        assert.strictEqual(receipt.executed, true)
        assert.strictEqual(receipt.fingerprintParity, true)

        const s = camp.getSummary()
        assert.strictEqual(s.counts[OUTCOME.SUCCESS], 1, 'campaign recorded 1 success')
        const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
        assert.strictEqual(lines.length, 1, 'JSONL has 1 entry')
        const entry = JSON.parse(lines[0])
        assert.strictEqual(entry.outcome, OUTCOME.SUCCESS)
        assert.ok(entry.fingerprintHash, 'fingerprintHash in JSONL')
        assert.ok(entry.preflightLatencyMs >= 0, 'preflightLatencyMs in JSONL')
        assert.ok(entry.borrowAmount !== '0', 'borrowAmount in JSONL')
        assert.ok(entry.expectedRepayment !== '0', 'expectedRepayment in JSONL')
        pass(`DRY_RUN_VERIFIED → campaign JSONL entry: outcome=${entry.outcome} fp=${entry.fingerprintHash.slice(0, 12)}`)

        try { fs.unlinkSync(log) } catch (e) {}
    } catch (e) { fail('Controller DRY_RUN campaign integration', e.message) }

    // ── 10. Controller integration — revert is classified and recorded ────────
    console.log('\n10. Controller integration — PREFLIGHT_SIMULATION_REVERTED recorded:')
    try {
        const log = tmpLog()
        const camp = new PreflightCampaign({ logPath: log, verbose: false })
        const mockRevert = async () => ({ simulated: true, success: false, reverted: true, revertReason: 'InsufficientProfit' })

        const ctrl = new ExecutionController({
            maxSizeUsd: 10000, minProfitUsd: 0.50, maxOpportunityAgeMs: 5000,
            preflight: mockRevert, campaign: camp
        })

        const receipt = await ctrl.processOpportunity(makeOpp(), { now: Date.now(), currentVersion: 7, getStateVersion: () => 7 })
        assert.strictEqual(receipt.executed, false)
        assert.strictEqual(receipt.reason, 'PREFLIGHT_SIMULATION_REVERTED')

        const s = camp.getSummary()
        assert.strictEqual(s.counts[OUTCOME.INSUFFICIENT_PROFIT], 1)
        const entry = JSON.parse(fs.readFileSync(log, 'utf8').trim())
        assert.strictEqual(entry.outcome, OUTCOME.INSUFFICIENT_PROFIT)
        assert.strictEqual(entry.revertReason, 'InsufficientProfit')
        pass('PREFLIGHT_SIMULATION_REVERTED → PREFLIGHT_INSUFFICIENT_PROFIT recorded in JSONL')

        try { fs.unlinkSync(log) } catch (e) {}
    } catch (e) { fail('Revert campaign integration', e.message) }

    // ── 11. Controller integration — post-preflight state divergence recorded ─
    console.log('\n11. Controller integration — STATE_VERSION_DIVERGED_POST_PREFLIGHT recorded:')
    try {
        const log = tmpLog()
        const camp = new PreflightCampaign({ logPath: log, verbose: false })
        let ver = 7
        const mockPreflight = async () => { await new Promise(r => setTimeout(r, 5)); ver = 8; return { simulated: true, success: true, reverted: false } }

        const ctrl = new ExecutionController({
            maxSizeUsd: 10000, minProfitUsd: 0.50, maxOpportunityAgeMs: 5000,
            preflight: mockPreflight, campaign: camp
        })

        const receipt = await ctrl.processOpportunity(makeOpp(), { now: Date.now(), currentVersion: 7, getStateVersion: () => ver })
        assert.strictEqual(receipt.executed, false)
        assert.strictEqual(receipt.reason, 'STATE_VERSION_DIVERGED_POST_PREFLIGHT')

        const s = camp.getSummary()
        assert.strictEqual(s.counts[OUTCOME.STATE_DIVERGED], 1)
        pass('Post-preflight state divergence → PREFLIGHT_STATE_DIVERGED recorded')
        try { fs.unlinkSync(log) } catch (e) {}
    } catch (e) { fail('Post-preflight divergence campaign integration', e.message) }

    // ── 12. Taxonomy v2 — TOO_LITTLE_RECEIVED classification ────────────────
    console.log('\n12. Taxonomy v2 — TOO_LITTLE_RECEIVED:')
    try {
        const out = classifyOutcome({ executed: false, reason: 'PREFLIGHT_SIMULATION_REVERTED', revertReason: 'Too little received' })
        assert.strictEqual(out, OUTCOME.TOO_LITTLE_RECEIVED)
        pass('Too little received → PREFLIGHT_TOO_LITTLE_RECEIVED')
    } catch (e) { fail('TOO_LITTLE_RECEIVED classification', e.message) }

    // ── 13. Taxonomy v2 — SLIPPAGE_EXCEEDED classification ───────────────────
    console.log('\n13. Taxonomy v2 — SLIPPAGE_EXCEEDED:')
    try {
        const out = classifyOutcome({ executed: false, reason: 'PREFLIGHT_SIMULATION_REVERTED', revertReason: 'SLIPPAGE_EXCEEDED' })
        assert.strictEqual(out, OUTCOME.SLIPPAGE_EXCEEDED)
        pass('SLIPPAGE_EXCEEDED → PREFLIGHT_SLIPPAGE_EXCEEDED')
    } catch (e) { fail('SLIPPAGE_EXCEEDED classification', e.message) }

    // ── 14. Taxonomy v2 — RPC_ERROR classification ───────────────────────────
    console.log('\n14. Taxonomy v2 — RPC_ERROR:')
    try {
        const rateLimitOut = classifyOutcome({ executed: false, reason: 'RPC_RATE_LIMIT', revertReason: 'RPC Rate Limit Exceeded (HTTP 429)' })
        assert.strictEqual(rateLimitOut, OUTCOME.RPC_ERROR)

        const jsonOut = classifyOutcome({ executed: false, reason: 'PREFLIGHT_SIMULATION_REVERTED', revertReason: 'Unexpected token \'R\', "Rate limit"... is not valid JSON' })
        assert.strictEqual(jsonOut, OUTCOME.RPC_ERROR)

        const timeoutOut = classifyOutcome({ executed: false, reason: 'RPC_TIMEOUT', revertReason: 'The operation was aborted due to timeout' })
        assert.strictEqual(timeoutOut, OUTCOME.RPC_ERROR)
        pass('Rate limits, timeouts, and JSON syntax errors → PREFLIGHT_RPC_ERROR')
    } catch (e) { fail('RPC_ERROR classification', e.message) }

    // ── 15. Controller integration — RPC transport error recorded as RPC_ERROR ─
    console.log('\n15. Controller integration — RPC transport error recorded cleanly:')
    try {
        const log = tmpLog()
        const camp = new PreflightCampaign({ logPath: log, verbose: false })
        const mockRpcError = async () => ({ simulated: false, success: false, rpcError: true, errorType: 'RPC_RATE_LIMIT', error: 'Rate limit exceeded' })

        const ctrl = new ExecutionController({
            maxSizeUsd: 10000, minProfitUsd: 0.50, maxOpportunityAgeMs: 5000,
            preflight: mockRpcError, campaign: camp
        })

        const receipt = await ctrl.processOpportunity(makeOpp(), { now: Date.now(), currentVersion: 7, getStateVersion: () => 7 })
        assert.strictEqual(receipt.executed, false)
        assert.strictEqual(receipt.rpcError, true)

        const s = camp.getSummary()
        assert.strictEqual(s.counts[OUTCOME.RPC_ERROR], 1)
        assert.strictEqual(s.counts[OUTCOME.OTHER_REVERT], 0, 'RPC error must not be counted as OTHER_REVERT')
        pass('RPC transport failure → PREFLIGHT_RPC_ERROR (not EVM revert)')

        try { fs.unlinkSync(log) } catch (e) {}
    } catch (e) { fail('RPC transport error controller integration', e.message) }

    // ── 16. Clean Survival Rate calculation ──────────────────────────────────
    console.log('\n16. Clean Survival Rate calculation:')
    try {
        const camp = new PreflightCampaign({ logPath: tmpLog(), verbose: false })
        const opp = makeOpp()
        // 4 successes, 1 too-little-received, 1 rpc-error
        for (let i = 0; i < 4; i++) camp.record({ executed: true, fingerprintParity: true }, opp, null, {})
        camp.record({ executed: false, reason: 'PREFLIGHT_SIMULATION_REVERTED', revertReason: 'Too little received' }, opp, null, {})
        camp.record({ executed: false, reason: 'RPC_RATE_LIMIT', revertReason: 'HTTP 429' }, opp, null, {})

        const s = camp.getSummary()
        // Reached eth_call = 6, but EVM simulated = 5 (excluding 1 RPC error).
        // Clean success = 4/5 = 80.0%, Raw success = 4/6 = 66.7%
        assert.strictEqual(s.cleanSuccessRate, '80.0', 'Clean survival rate should exclude RPC errors')
        assert.strictEqual(s.ratios.preflightSuccessRate, '66.7', 'Raw preflight success rate includes all attempts')
        pass(`Clean survival rate = ${s.cleanSuccessRate}% (4/5) vs Raw = ${s.ratios.preflightSuccessRate}% (4/6)`)
    } catch (e) { fail('Clean survival rate calculation', e.message) }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n=============================================================')
    if (failed === 0) {
        console.log(`ALL ${passed} PREFLIGHT CAMPAIGN TESTS PASSED`)
    } else {
        console.log(`${passed} PASSED / ${failed} FAILED`)
    }
    console.log('=============================================================')
    if (failed > 0) process.exit(1)
}

main().catch(err => {
    console.error('Campaign test suite crashed:', err)
    process.exit(1)
})
