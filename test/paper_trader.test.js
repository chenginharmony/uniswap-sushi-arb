'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { PaperTrader } = require('../src/monitoring/paper_trader')
const { generateTelemetryReport, printReport } = require('../scripts/paper_trading_report')

const TEST_LOG_FILE = path.join(__dirname, '..', 'data', 'test_paper_trades.jsonl')

async function main() {
    console.log('=== Milestone 2: Paper Trading & Telemetry Engine Unit Tests ===\n')

    // Clean test log file if exists
    if (fs.existsSync(TEST_LOG_FILE)) {
        fs.unlinkSync(TEST_LOG_FILE)
    }

    const trader = new PaperTrader({
        logFile: TEST_LOG_FILE,
        minProfitUsd: 0.10
    })

    // -------------------------------------------------------------
    // Test 1: Uniswap V3 Flash Fee Calculation
    // -------------------------------------------------------------
    console.log('Test 1: Uniswap V3 Flash Fee Calculation:')
    // 1 WETH at 500 feeTier (5 bps) -> 0.0005 WETH ($1.30 at $2600/ETH)
    const fee500 = trader.calculateFlashFee(1.0, 500, 2600)
    assert.strictEqual(fee500.flashFeeTokens, 0.0005)
    assert.strictEqual(fee500.flashFeeUsd, 1.3)

    // 1 WETH at 100 feeTier (1 bp) -> 0.0001 WETH ($0.26 at $2600/ETH)
    const fee100 = trader.calculateFlashFee(1.0, 100, 2600)
    assert.strictEqual(fee100.flashFeeTokens, 0.0001)
    assert.strictEqual(fee100.flashFeeUsd, 0.26)

    // 1 WETH at 3000 feeTier (30 bps) -> 0.003 WETH ($7.80 at $2600/ETH)
    const fee3000 = trader.calculateFlashFee(1.0, 3000, 2600)
    assert.strictEqual(fee3000.flashFeeTokens, 0.003)
    assert.strictEqual(fee3000.flashFeeUsd, 7.8)
    console.log('   ✓ Flash fee math verified across 1bp, 5bp, and 30bp tiers\n')

    // -------------------------------------------------------------
    // Test 2: Paper Trade Processing & Latency Measurements
    // -------------------------------------------------------------
    console.log('Test 2: Paper Trade Pipeline & Latency Capture:')
    const mockOpp = {
        id: 'opp-paper-test-1',
        route: 'uniswap_v3->pancakeswap_v3',
        pair: 'WETH/USDC',
        buyPool: { address: '0xb4cb800910b228ed3d0834cf79d697127bbb00e5', dex: 'uniswap', feeTier: 100 },
        sellPool: { address: '0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38', dex: 'pancakeswap', feeTier: 100 },
        tokenIn: '0x4200000000000000000000000000000000000006',
        tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        tokenInDecimals: 18,
        tokenOutDecimals: 6,
        tokenUsdPrice: 2600,
        optimalSizeTokens: 0.15,
        optimalSizeUsd: 390.0,
        expectedGrossProfitUsd: 1.80,
        expectedIntermediateOutput: 390000000n,
        expectedFinalOutput: 150600000000000000n,
        expectedNetProfitUsd: 1.45,
        profitable: true,
        status: 'PROFITABLE'
    }

    const tStart = process.hrtime.bigint()
    const receipt = await trader.processPaperTrade(mockOpp, {
        detectedAtNs: tStart,
        currentVersion: 1,
        initialSpreadBps: 20,
        subsequentSpreadBps: 5 // Dropped below 50% -> evaporated
    })

    assert.ok(receipt, 'Receipt must be generated')
    assert.strictEqual(receipt.dryRun, true)
    assert.strictEqual(receipt.pair, 'WETH/USDC')
    assert.ok(receipt.latencies.detectionToQuoteMs >= 0)
    assert.ok(receipt.latencies.quoteToPreflightMs >= 0)
    assert.ok(receipt.latencies.totalLatencyMs >= 0)
    assert.strictEqual(receipt.state.spreadEvaporated, true)
    console.log(`   ✓ Latency benchmarks captured: detection➔quote=${receipt.latencies.detectionToQuoteMs}ms, quote➔preflight=${receipt.latencies.quoteToPreflightMs}ms`)
    console.log(`   ✓ Spread evaporation captured: ${receipt.state.spreadEvaporated}\n`)

    // -------------------------------------------------------------
    // Test 3: Multiple Opportunities & Sizing Diversity in Telemetry
    // -------------------------------------------------------------
    console.log('Test 3: Telemetry Population with Multiple Samples:')
    const testCases = [
        { size: 0.05, gross: 0.60, profit: 0.45, passed: true },
        { size: 0.20, gross: 2.50, profit: 2.10, passed: true },
        { size: 0.50, gross: 6.00, profit: 5.20, passed: true },
        { size: 0.10, gross: 0.12, profit: 0.05, passed: false } // Sub-threshold
    ]

    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i]
        const opp = {
            ...mockOpp,
            id: `opp-paper-test-${i + 2}`,
            optimalSizeTokens: tc.size,
            optimalSizeUsd: tc.size * 2600,
            expectedIntermediateOutput: BigInt(Math.floor(tc.size * 2600 * 1e6)),
            expectedFinalOutput: BigInt(Math.floor((tc.size + (tc.profit / 2600)) * 1e18)),
            expectedGrossProfitUsd: tc.gross,
            expectedNetProfitUsd: tc.profit,
            profitable: tc.passed
        }
        await trader.processPaperTrade(opp, {
            detectedAtNs: process.hrtime.bigint(),
            currentVersion: 1
        })
    }

    assert.ok(fs.existsSync(TEST_LOG_FILE), 'Test JSONL log must exist')
    const fileLines = fs.readFileSync(TEST_LOG_FILE, 'utf8').split('\n').filter(Boolean)
    assert.strictEqual(fileLines.length, 5, 'Must contain 5 logged telemetry records')
    console.log(`   ✓ Logged ${fileLines.length} structured records to JSONL\n`)

    // -------------------------------------------------------------
    // Test 4: Telemetry Aggregation & Report Generation
    // -------------------------------------------------------------
    console.log('Test 4: Telemetry Aggregation & Statistical Verification:')
    const report = generateTelemetryReport(TEST_LOG_FILE)
    assert.strictEqual(report.totalRecords, 5)
    assert.ok(report.latencies.totalLatencyMs.p50 >= 0)
    assert.ok(report.latencies.totalLatencyMs.p90 >= 0)
    assert.ok(report.sizesUsd.min > 0)
    assert.ok(report.sizesUsd.max >= report.sizesUsd.min)
    assert.ok(report.economics.grossEdgeEvaluatedUsd > 0)
    console.log(`   ✓ Statistical report computed: ${report.totalRecords} records, p50 latency=${report.latencies.totalLatencyMs.p50}ms`)
    console.log(`   ✓ Sizing range: $${report.sizesUsd.min} - $${report.sizesUsd.max} (Mean: $${report.sizesUsd.mean})`)
    console.log(`   ✓ Total evaluated gross edge: $${report.economics.grossEdgeEvaluatedUsd} USD\n`)

    // -------------------------------------------------------------
    // Test 5: Successful Preflight Paper Execution & Profit Capture
    // -------------------------------------------------------------
    console.log('Test 5: Successful Preflight Execution & Profit Capture:')
    const mockPassingController = {
        processOpportunity: async (opp) => ({
            executed: true,
            simulated: true,
            broadcast: false,
            mode: 'DRY_RUN_VERIFIED',
            nonce: 42,
            preflightPassed: true,
            reason: 'SUCCESS'
        })
    }
    const passingTrader = new PaperTrader({
        logFile: TEST_LOG_FILE,
        controller: mockPassingController
    })

    const passedReceipt = await passingTrader.processPaperTrade(mockOpp, {
        detectedAtNs: process.hrtime.bigint(),
        currentVersion: 1
    })

    assert.strictEqual(passedReceipt.preflight.passed, true)
    assert.strictEqual(passedReceipt.preflight.nonce, 42)
    assert.ok(passedReceipt.capturedProfitUsd > 0)
    console.log(`   ✓ Preflight passed paper trade captured profit: +$${passedReceipt.capturedProfitUsd} USD`)

    const passedReport = generateTelemetryReport(TEST_LOG_FILE)
    assert.ok(passedReport.passedCount >= 1)
    assert.ok(passedReport.economics.netCapturedProfitUsd > 0)
    console.log(`   ✓ Report reflects captured net profit: +$${passedReport.economics.netCapturedProfitUsd} USD\n`)

    // Clean up test log
    if (fs.existsSync(TEST_LOG_FILE)) {
        fs.unlinkSync(TEST_LOG_FILE)
    }

    console.log('=============================================================')
    console.log('ALL MILESTONE 2 PAPER TRADING & TELEMETRY TESTS PASSED!')
    console.log('=============================================================')
}

main().catch(err => {
    console.error('Test suite failed:', err)
    process.exit(1)
})
