'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { LatencyProfiler } = require('../src/monitoring/latency_profiler')

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function runTests() {
    console.log('=== Latency Profiler Test Suite ===\n')

    const testLog = path.resolve(__dirname, '../scratch/test_latency.jsonl')
    if (fs.existsSync(testLog)) fs.unlinkSync(testLog)

    const profiler = new LatencyProfiler({ logFile: testLog })

    // Test 1: Full Pipeline Trace
    console.log('Test 1: Full Pipeline Trace & Checkpoint Intervals:')
    const traceId = 'opp-profiler-test-1'
    profiler.startTrace(traceId, { route: 'uniswap->pancake', stateVersion: 100 })

    await sleep(2)
    profiler.mark(traceId, 'stateUpdated')

    await sleep(2)
    profiler.mark(traceId, 'routesRepriced')

    await sleep(2)
    profiler.mark(traceId, 'optimized')

    await sleep(2)
    profiler.mark(traceId, 'built')

    await sleep(5)
    profiler.mark(traceId, 'preflighted')

    await sleep(1)
    profiler.mark(traceId, 'signed')

    await sleep(3)
    profiler.mark(traceId, 'broadcasted')

    const finishedTrace = profiler.endTrace(traceId, { status: 'EXECUTED', profitUsd: 4.50 })
    assert.ok(finishedTrace, 'Finished trace must exist')
    assert.strictEqual(finishedTrace.completed, true)
    assert.ok(finishedTrace.intervals.stateUpdateMs >= 1, 'stateUpdateMs captured')
    assert.ok(finishedTrace.intervals.preflightMs >= 3, 'preflightMs captured')
    assert.ok(finishedTrace.intervals.totalPipelineMs >= 10, 'totalPipelineMs captured')
    console.log('   ✓ Checkpoints successfully recorded')
    console.log(`   ✓ Total pipeline latency: ${finishedTrace.intervals.totalPipelineMs.toFixed(2)}ms`)

    // Test 2: Waterfall Formatting
    console.log('\nTest 2: ASCII Latency Waterfall Formatting:')
    const waterfall = profiler.formatWaterfall(finishedTrace)
    assert.ok(waterfall.includes('Latency Waterfall'), 'Waterfall contains header')
    assert.ok(waterfall.includes('Preflight Sim'), 'Waterfall contains preflight')
    console.log(waterfall)

    // Test 3: Percentile Summaries Across Multiple Runs
    console.log('\nTest 3: Statistical Percentile Aggregation:')
    for (let i = 2; i <= 6; i++) {
        const id = `opp-profiler-test-${i}`
        profiler.startTrace(id, { route: 'aero->pancake' })
        await sleep(1)
        profiler.mark(id, 'preflighted')
        profiler.mark(id, 'broadcasted')
        profiler.endTrace(id, { status: 'EXECUTED' })
    }

    const summary = profiler.getSummary()
    assert.ok(summary.totalSamples >= 5, 'Must have recorded 5+ samples')
    assert.ok(summary.stages.totalPipelineMs.p50 > 0, 'p50 total pipeline > 0')
    assert.ok(summary.stages.totalPipelineMs.p90 >= summary.stages.totalPipelineMs.p50, 'p90 >= p50')
    console.log(`   ✓ Recorded ${summary.totalSamples} traces`)
    console.log(`   ✓ p50 Pipeline Latency: ${summary.stages.totalPipelineMs.p50}ms`)
    console.log(`   ✓ p90 Pipeline Latency: ${summary.stages.totalPipelineMs.p90}ms`)
    console.log(`   ✓ Mean Pipeline Latency: ${summary.stages.totalPipelineMs.mean}ms`)

    console.log('\n=============================================================')
    console.log('ALL LATENCY PROFILER TESTS PASSED')
    console.log('=============================================================')
}

runTests().catch(err => {
    console.error('Test failed:', err)
    process.exit(1)
})
