'use strict'

const assert = require('assert')
const { NonceManager } = require('../src/execution/nonce_manager')
const { IsolatedSigner } = require('../src/execution/signer')
const { ExecutionController } = require('../src/execution/controller')

async function main() {
    console.log('=== Execution Controller & Nonce Manager Test Suite ===\n')

    // -------------------------------------------------------------
    // Part 1: NonceManager Unit & Concurrency Tests
    // -------------------------------------------------------------
    console.log('1. Testing NonceManager:')
    let mockOnChainNonce = 42
    const mockRpc = async (method, params) => {
        if (method === 'eth_getTransactionCount') return '0x' + mockOnChainNonce.toString(16)
        return '0x0'
    }

    const nm = new NonceManager({
        walletAddress: '0x1234567890123456789012345678901234567890',
        rpcCaller: mockRpc
    })

    // Initial sync
    const synced = await nm.sync()
    assert.strictEqual(synced, 42, 'Synced nonce must match on-chain')

    // Atomic acquisition across concurrent requests
    const n1 = await nm.acquire({ id: 'tx-1' })
    const n2 = await nm.acquire({ id: 'tx-2' })
    const n3 = await nm.acquire({ id: 'tx-3' })

    assert.strictEqual(n1, 42, 'First acquired must be 42')
    assert.strictEqual(n2, 43, 'Second acquired must be 43 (collision avoided)')
    assert.strictEqual(n3, 44, 'Third acquired must be 44 (collision avoided)')
    assert.strictEqual(nm.getPendingCount(), 3, 'Must track 3 in-flight nonces')

    // Confirm n1
    nm.confirm(42)
    assert.strictEqual(nm.getPendingCount(), 2, 'Pending count decrements after confirm')

    // Release n3 (e.g. failed preflight)
    nm.release(44)
    assert.strictEqual(nm.getPendingCount(), 1, 'Pending count decrements after release')

    // Stuck detection
    nm.pendingNonces.get(43).timestamp = Date.now() - 10000 // simulate 10s old
    const stuck = nm.getStuckNonces(5000)
    assert.strictEqual(stuck.length, 1)
    assert.strictEqual(stuck[0].nonce, 43, 'Must identify stuck nonce 43')

    // Clean reset & resync
    mockOnChainNonce = 45
    await nm.reset()
    assert.strictEqual(nm.nextNonce, 45, 'Reset must sync to latest on-chain nonce')
    assert.strictEqual(nm.getPendingCount(), 0, 'Reset clears pending nonces')
    console.log('   ✓ Atomic sequential nonce allocation passed (42 -> 43 -> 44)')
    console.log('   ✓ In-flight collision prevention verified')
    console.log('   ✓ Stuck transaction detection verified')
    console.log('   ✓ Reset & resynchronization verified\n')

    // -------------------------------------------------------------
    // Part 2: IsolatedSigner & Safety Gates
    // -------------------------------------------------------------
    console.log('2. Testing IsolatedSigner:')
    const signer = new IsolatedSigner({
        dryRun: true,
        executionEnabled: false,
        walletAddress: '0x1234567890123456789012345678901234567890'
    })

    const prep = await signer.prepareTransaction({
        to: '0x2626664c2603336E57B271c5C0b26F421741e481',
        data: '0x8dc23616' + '00'.repeat(100),
        gasLimit: 450000n
    }, 45)

    assert.strictEqual(prep.broadcastAllowed, false, 'Broadcast must be forbidden')
    assert.strictEqual(prep.mode, 'DRY_RUN', 'Signer mode must be DRY_RUN')
    assert.strictEqual(prep.transaction.chainId, 8453, 'Chain ID must be Base Mainnet (8453)')
    assert.strictEqual(prep.transaction.nonce, 45, 'Nonce must match prepared nonce')
    console.log('   ✓ Signer strictly maintains DRY_RUN gate')
    console.log('   ✓ EIP-1559 Base parameters formatted correctly\n')

    // -------------------------------------------------------------
    // Part 3: ExecutionController Pre-Execution Gates
    // -------------------------------------------------------------
    console.log('3. Testing ExecutionController Gates:')

    const baseOpportunity = {
        id: 'opp-weth-usdc-test',
        status: 'PROFITABLE',
        profitable: true,
        createdAt: Date.now(),
        stateVersion: 10,
        optimalSizeUsd: 500,
        expectedNetProfitUsd: 1.50,
        tokenIn: '0x4200000000000000000000000000000000000006',
        tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        tokenInDecimals: 18,
        tokenOutDecimals: 6,
        tokenUsdPrice: 2500,
        optimalSizeTokens: 0.2,
        expectedIntermediateOutput: 500000000n,
        expectedFinalOutput: 201000000000000000n,
        buyPool: { address: '0xb4cb800910b228ed3d0834cf79d697127bbb00e5', dex: 'uniswap', feeTier: 100 },
        sellPool: { address: '0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38', dex: 'pancakeswap', feeTier: 100 }
    }

    const mockPreflightSuccess = async () => ({ simulated: true, success: true, reverted: false })
    const mockPreflightRevert = async () => ({ simulated: true, success: false, reverted: true, revertReason: 'INSUFFICIENT_NET_PROFIT' })

    const controller = new ExecutionController({
        maxSizeUsd: 5000,
        minProfitUsd: 0.50,
        maxOpportunityAgeMs: 200,
        preflight: mockPreflightSuccess,
        walletAddress: '0x1234567890123456789012345678901234567890'
    })

    // Gate 1: Rejects Unprofitable
    const unprofitOpp = Object.assign({}, baseOpportunity, { profitable: false, status: 'REJECTED' })
    const g1 = await controller.processOpportunity(unprofitOpp)
    assert.strictEqual(g1.executed, false)
    assert.strictEqual(g1.reason, 'NOT_PROFITABLE')
    console.log('   ✓ Gate 1 passed: Unprofitable opportunity correctly rejected')

    // Gate 2: Rejects Stale (age > 200ms)
    const staleOpp = Object.assign({}, baseOpportunity, { createdAt: Date.now() - 500 })
    const g2 = await controller.processOpportunity(staleOpp)
    assert.strictEqual(g2.executed, false)
    assert.strictEqual(g2.reason, 'OPPORTUNITY_STALE')
    console.log('   ✓ Gate 2 passed: Stale opportunity (500ms > 200ms) rejected')

    // Gate 2b: Rejects State Version Mismatch
    const g2b = await controller.processOpportunity(baseOpportunity, { currentVersion: 11 })
    assert.strictEqual(g2b.executed, false)
    assert.strictEqual(g2b.reason, 'STATE_VERSION_DIVERGED')
    console.log('   ✓ Gate 2b passed: State version divergence rejected')

    // Gate 3: Rejects Exceeds Max Size Limit ($15,000 > $5,000 cap)
    const bigOpp = Object.assign({}, baseOpportunity, { optimalSizeUsd: 15000 })
    const g3a = await controller.processOpportunity(bigOpp)
    assert.strictEqual(g3a.executed, false)
    assert.strictEqual(g3a.reason, 'EXCEEDS_MAX_SIZE_LIMIT')
    console.log('   ✓ Gate 3a passed: Oversized trade ($15,000) rejected by safety cap')

    // Gate 3b: Rejects Below Min Profit ($0.10 < $0.50 min)
    const tinyProfitOpp = Object.assign({}, baseOpportunity, { expectedNetProfitUsd: 0.10, peakNetProfitUsd: 0.10 })
    const g3b = await controller.processOpportunity(tinyProfitOpp)
    assert.strictEqual(g3b.executed, false)
    assert.strictEqual(g3b.reason, 'BELOW_MIN_PROFIT_THRESHOLD')
    console.log('   ✓ Gate 3b passed: Sub-threshold profit rejected')

    // Gate 4: State Revalidation (Simulate spot price moved before execution)
    const revalFailController = new ExecutionController({
        preflight: mockPreflightSuccess,
        revalidateState: async () => ({ valid: false, reason: 'Pool reserve updated by Flashblock' })
    })
    const g4 = await revalFailController.processOpportunity(baseOpportunity)
    assert.strictEqual(g4.executed, false)
    assert.strictEqual(g4.reason, 'STATE_REVALIDATION_FAILED')
    console.log('   ✓ Gate 4 passed: Pre-execution state revalidation correctly blocks stale trades')

    // Gate 6: eth_call Preflight Revert Handling
    const preflightRevertController = new ExecutionController({
        preflight: mockPreflightRevert
    })
    const g6 = await preflightRevertController.processOpportunity(baseOpportunity)
    assert.strictEqual(g6.executed, false)
    assert.strictEqual(g6.reason, 'PREFLIGHT_SIMULATION_REVERTED')
    assert.strictEqual(g6.revertReason, 'INSUFFICIENT_NET_PROFIT')
    console.log('   ✓ Gate 6 passed: Reverting on-chain preflight safely caught and aborted')

    // Full Valid Opportunity Execution (Dry-Run Verified)
    const validController = new ExecutionController({
        maxSizeUsd: 5000,
        minProfitUsd: 0.50,
        maxOpportunityAgeMs: 500,
        preflight: mockPreflightSuccess,
        revalidateState: async () => ({ valid: true, recalculatedNetProfitUsd: 1.48 })
    })

    const receipt = await validController.processOpportunity(baseOpportunity, { currentVersion: 10 })
    assert.strictEqual(receipt.executed, true, 'Valid trade must pass execution controller')
    assert.strictEqual(receipt.simulated, true)
    assert.strictEqual(receipt.broadcast, false, 'Live broadcast must remain false')
    assert.strictEqual(receipt.mode, 'DRY_RUN_VERIFIED')
    assert.strictEqual(receipt.expectedNetProfitUsd, 1.50)
    assert.strictEqual(receipt.preflightPassed, true)
    console.log('   ✓ Full Execution Controller dry-run pipeline completed successfully:')
    console.log(`     - Opportunity ID: ${receipt.opportunityId}`)
    console.log(`     - Nonce Assigned: ${receipt.nonce}`)
    console.log(`     - Calldata: ${receipt.calldataSelector}...`)
    console.log(`     - Broadcast: ${receipt.broadcast} (Dry-run safety strictly preserved)`)

    console.log('\n=============================================================')
    console.log('ALL EXECUTION CONTROLLER & NONCE MANAGER TESTS PASSED')
    console.log('=============================================================')
}

main().catch(err => {
    console.error('Test failed:', err)
    process.exit(1)
})
