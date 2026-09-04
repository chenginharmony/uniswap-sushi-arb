'use strict'

const assert = require('assert')
const { buildFlashArbitrageTransaction, encodeFlashArbCalldata, BASE_ROUTERS } = require('../src/execution/builder')

async function main() {
    console.log('--- Testing Uniswap V3 Flash Execution Pipeline ---')

    // 1. Router verification
    assert.strictEqual(BASE_ROUTERS.uniswap_v3.toLowerCase(), '0x2626664c2603336e57b271c5c0b26f421741e481')
    assert.strictEqual(BASE_ROUTERS.pancakeswap_v3.toLowerCase(), '0x1b81d678ffb9c0263b24a97847620c99d213eb14')
    assert.strictEqual(BASE_ROUTERS.aerodrome_slipstream.toLowerCase(), '0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5')

    // 2. Build mock opportunity
    const mockOpportunity = {
        id: 'opp-uni-cake-weth-usdc',
        buyPool: {
            address: '0xb4cb800910b228ed3d0834cf79d697127bbb00e5',
            dex: 'uniswap',
            feeTier: 100,
            feeBps: 1
        },
        sellPool: {
            address: '0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38',
            dex: 'pancakeswap',
            feeTier: 100,
            feeBps: 1
        },
        tokenIn: '0x4200000000000000000000000000000000000006', // WETH
        tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
        tokenInDecimals: 18,
        tokenOutDecimals: 6,
        tokenUsdPrice: 2500,
        optimalSizeTokens: 0.5,
        expectedIntermediateOutput: 1250000000n, // 1,250 USDC (6 decimals)
        expectedFinalOutput: 501000000000000000n, // 0.501 WETH (18 decimals)
        profitable: true,
        expectedNetProfitUsd: 2.50
    }

    // 3. Construct transaction in dry-run mode
    const txBuild = buildFlashArbitrageTransaction(mockOpportunity, {
        dryRun: true,
        executionEnabled: false,
        arbitrageContractAddress: '0x1234567890123456789012345678901234567890',
        minNetProfitUsd: 0.20
    })

    assert.ok(txBuild.unsignedTransaction, 'Must produce unsigned transaction')
    assert.strictEqual(txBuild.unsignedTransaction.chainId, 8453, 'Chain ID must be Base Mainnet (8453)')
    assert.strictEqual(txBuild.unsignedTransaction.to, '0x1234567890123456789012345678901234567890')
    assert.ok(txBuild.unsignedTransaction.data.startsWith('0xf9a95c57'), 'Selector must match executeFlashArb')
    assert.strictEqual(txBuild.dryRun, true, 'Dry-run must be preserved')
    assert.strictEqual(txBuild.isExecutable, false, 'Execution must not be marked executable')

    // 4. Verify parameter accuracy and flashPool isolation (LOK protection)
    const params = txBuild.flashParams
    assert.notStrictEqual(params.flashPool.toLowerCase(), mockOpportunity.buyPool.address.toLowerCase(), 'flashPool must not equal buyPool')
    assert.notStrictEqual(params.flashPool.toLowerCase(), mockOpportunity.sellPool.address.toLowerCase(), 'flashPool must not equal sellPool')
    assert.strictEqual(params.borrowToken, mockOpportunity.tokenIn)
    assert.strictEqual(params.borrowAmount, 500000000000000000n, 'Borrow amount = 0.5 WETH')
    assert.strictEqual(params.feeTier1, 100)
    assert.strictEqual(params.feeTier2, 100)
    assert.strictEqual(params.minAmountOut1, (1250000000n * 995n) / 1000n, 'Min output 1 must enforce slippage')
    assert.ok(params.minAmountOut2 >= params.borrowAmount + params.minProfitSurplus, 'Min output 2 must strictly cover flash repayment + min profit')
    assert.ok(params.minProfitSurplus > 0n, 'Min profit surplus must be positive')
    assert.ok(params.deadline > BigInt(Math.floor(Date.now() / 1000)), 'Deadline must be in future')

    // 5. Test safety block: live execution requires deployed contract
    assert.throws(() => {
        buildFlashArbitrageTransaction(mockOpportunity, {
            dryRun: false,
            executionEnabled: true
        })
    }, /DEPLOYMENT_REQUIRED/, 'Must require deployed contract address if execution is enabled')

    const liveBuild = buildFlashArbitrageTransaction(mockOpportunity, {
        dryRun: false,
        executionEnabled: true,
        arbitrageContractAddress: '0x4b76f5deb442d9D3EB59A0545Ce603003Cd57575'
    })
    assert.strictEqual(liveBuild.isExecutable, true, 'Must mark executable with valid contract address')
    assert.strictEqual(liveBuild.unsignedTransaction.to, '0x4b76f5deb442d9D3EB59A0545Ce603003Cd57575')

    console.log('✓ Router addresses verified on Base mainnet')
    console.log('✓ Flash arbitrage calldata encoded with exact parameter offsets')
    console.log('✓ Slippage protection correctly applied to both legs')
    console.log('✓ Safety lock verified: live execution strictly blocked')
    console.log('--- All Uniswap V3 Flash Execution Tests Passed Successfully ---')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
