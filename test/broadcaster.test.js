'use strict'

const assert = require('assert')
const { Broadcaster } = require('../src/execution/broadcaster')
const { IsolatedSigner, deriveAddressFromPrivateKey, signEIP1559Transaction } = require('../src/execution/signer')
const { ExecutionController } = require('../src/execution/controller')

async function main() {
    console.log('=== Live Broadcaster & EIP-1559 Signing Test Suite ===\n')

    const TEST_KEY = '4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d'
    const EXPECTED_ADDR = '0x90f8bf6a479f320ead074411a4b0e7944ea8c9c1'

    // -------------------------------------------------------------
    // Test 1: Native EIP-1559 Signer & Key Derivation
    // -------------------------------------------------------------
    console.log('Test 1: Native EIP-1559 Signer & Address Derivation:')
    const derivedAddr = deriveAddressFromPrivateKey(TEST_KEY)
    assert.strictEqual(derivedAddr.toLowerCase(), EXPECTED_ADDR.toLowerCase(), 'Derived address must match expected')
    console.log(`   ✓ Address derived correctly: ${derivedAddr}`)

    const signer = new IsolatedSigner({
        privateKey: TEST_KEY,
        dryRun: false,
        executionEnabled: true,
        chainId: 8453
    })
    assert.strictEqual(signer.isReady(), true)
    assert.strictEqual(signer.isBroadcastAllowed(), true)

    const dummyTx = {
        to: '0x5018bBCEFBe3aD54C4DE65f621aB0c9c5F12f4f4',
        data: '0x8dc23616',
        value: '0x0',
        gasLimit: 350000n,
        maxFeePerGas: 100000000n,
        maxPriorityFeePerGas: 10000000n
    }

    const prep = await signer.prepareTransaction(dummyTx, 5)
    assert.strictEqual(prep.isSigned, true)
    assert.strictEqual(prep.broadcastAllowed, true)
    assert.strictEqual(prep.mode, 'LIVE_SIGNED')
    assert.ok(prep.rawTransaction.startsWith('0x02'), 'EIP-1559 raw transaction must start with type prefix 0x02')
    assert.ok(prep.transactionHash.startsWith('0x'), 'Transaction hash must be valid 32-byte hex')
    console.log(`   ✓ EIP-1559 signed transaction generated: ${prep.transactionHash}`)
    console.log(`   ✓ Raw transaction hex length: ${prep.rawTransaction.length} chars\n`)

    // -------------------------------------------------------------
    // Test 2: Live Base Mainnet Gas Estimation
    // -------------------------------------------------------------
    console.log('Test 2: Dynamic Gas Fee Estimation on Base Mainnet:')
    const broadcaster = new Broadcaster()
    const fees = await broadcaster.getDynamicGasFees()
    assert.ok(fees.baseFeePerGas > 0n, 'Base fee must be greater than zero')
    assert.ok(fees.maxPriorityFeePerGas > 0n, 'Priority fee tip must be greater than zero')
    assert.ok(fees.maxFeePerGas > fees.baseFeePerGas, 'Max fee must cover base fee + tip buffer')
    console.log(`   ✓ Base fee: ${Number(fees.baseFeePerGas) / 1e9} gwei`)
    console.log(`   ✓ Priority tip: ${Number(fees.maxPriorityFeePerGas) / 1e9} gwei`)
    console.log(`   ✓ Max fee per gas: ${Number(fees.maxFeePerGas) / 1e9} gwei\n`)

    // -------------------------------------------------------------
    // Test 3: Base Mainnet Balance Inspection
    // -------------------------------------------------------------
    console.log('Test 3: Wallet Balance Inspection on Base Mainnet:')
    const profitWallet = '0x5018bBCEFBe3aD54C4DE65f621aB0c9c5F12f4f4'
    const balanceRes = await broadcaster.checkBalance(profitWallet, 100000000000000n)
    console.log(`   ✓ Balance of ${profitWallet}: ${balanceRes.balanceEth} ETH (sufficient for gas: ${balanceRes.sufficient})\n`)

    // -------------------------------------------------------------
    // Test 4: ExecutionController Gate 8 Live Broadcast Pipeline
    // -------------------------------------------------------------
    console.log('Test 4: ExecutionController Gate 8 Live Broadcast Pipeline:')
    let broadcastCalled = false
    const mockBroadcaster = {
        broadcastRawTransaction: async (rawTx) => {
            broadcastCalled = true
            return {
                broadcast: true,
                transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
                submittedAt: Date.now(),
                rpcUrl: 'https://base-rpc.publicnode.com'
            }
        },
        waitForReceipt: async (txHash) => ({
            confirmed: true,
            status: 'SUCCESS',
            blockNumber: 50845300,
            gasUsed: 215000,
            transactionHash: txHash
        })
    }

    const mockOpp = {
        id: 'opp-live-test',
        buyPool: { address: '0xb4cb800910b228ed3d0834cf79d697127bbb00e5', dex: 'uniswap', feeTier: 100 },
        sellPool: { address: '0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38', dex: 'pancakeswap', feeTier: 100 },
        tokenIn: '0x4200000000000000000000000000000000000006',
        tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        tokenInDecimals: 18,
        tokenOutDecimals: 6,
        tokenUsdPrice: 2600,
        optimalSizeTokens: 0.1,
        optimalSizeUsd: 260,
        expectedIntermediateOutput: 260000000n,
        expectedFinalOutput: 100300000000000000n,
        expectedNetProfitUsd: 0.78,
        profitable: true,
        status: 'PROFITABLE'
    }

    const liveController = new ExecutionController({
        dryRun: false,
        executionEnabled: true,
        walletAddress: EXPECTED_ADDR,
        signer: signer,
        broadcaster: mockBroadcaster,
        preflight: async () => ({ simulated: true, success: true, reverted: false }),
        config: {
            arbitrageContractAddress: '0x4b76f5deb442d9D3EB59A0545Ce603003Cd57575',
            dryRun: false,
            executionEnabled: true
        }
    })

    const liveReceipt = await liveController.processOpportunity(mockOpp, { now: Date.now() })
    assert.strictEqual(liveReceipt.executed, true)
    assert.strictEqual(liveReceipt.broadcast, true)
    assert.strictEqual(liveReceipt.mode, 'LIVE_BROADCAST')
    assert.strictEqual(liveReceipt.status, 'SUCCESS')
    assert.strictEqual(broadcastCalled, true)
    console.log(`   ✓ Live broadcast pipeline executed: txHash=${liveReceipt.transactionHash}`)
    console.log(`   ✓ Nonce confirmed on mining: nonce=${liveReceipt.nonce}, status=${liveReceipt.status}\n`)

    // -------------------------------------------------------------
    // Test 5: Revert Blocking Safety Verification
    // -------------------------------------------------------------
    console.log('Test 5: Revert Blocking Safety Gate Verification:')
    broadcastCalled = false
    const revertingController = new ExecutionController({
        dryRun: false,
        executionEnabled: true,
        walletAddress: EXPECTED_ADDR,
        signer: signer,
        broadcaster: mockBroadcaster,
        preflight: async () => ({ simulated: true, success: false, reverted: true, revertReason: 'SLIPPAGE_EXCEEDED' }),
        config: {
            arbitrageContractAddress: '0x4b76f5deb442d9D3EB59A0545Ce603003Cd57575',
            dryRun: false,
            executionEnabled: true
        }
    })

    const blockedReceipt = await revertingController.processOpportunity(mockOpp, { now: Date.now() })
    assert.strictEqual(blockedReceipt.executed, false)
    assert.strictEqual(broadcastCalled, false, 'Broadcaster must NEVER be called if preflight reverts')
    assert.strictEqual(blockedReceipt.reason, 'PREFLIGHT_SIMULATION_REVERTED')
    console.log(`   ✓ Reverting trade blocked before broadcast: ${blockedReceipt.reason} (${blockedReceipt.revertReason})`)

    console.log('\n=============================================================')
    console.log('ALL LIVE BROADCASTER & SIGNING TESTS PASSED!')
    console.log('=============================================================')
}

main().catch(err => {
    console.error('Test suite failed:', err)
    process.exit(1)
})
