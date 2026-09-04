'use strict'

const fs = require('fs')
const path = require('path')

function percentile(arr, p) {
    if (!arr.length) return 0
    const sorted = [...arr].sort((a, b) => a - b)
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]
}

function generateTelemetryReport(filePath) {
    if (!fs.existsSync(filePath)) {
        return { totalRecords: 0 }
    }

    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    const records = lines.map(l => {
        try { return JSON.parse(l) } catch (e) { return null }
    }).filter(Boolean)

    if (!records.length) {
        return { totalRecords: 0 }
    }

    const totalLats = records.map(r => r.latencies ? r.latencies.totalLatencyMs : 0).filter(Number.isFinite)
    const sizes = records.map(r => r.optimalSizeUsd !== undefined ? r.optimalSizeUsd : (r.trade ? r.trade.sizeUsd : 0)).filter(Number.isFinite)
    const grossEdges = records.map(r => r.grossEdgeUsd !== undefined ? r.grossEdgeUsd : (r.trade ? r.trade.expectedGrossProfitUsd : 0)).filter(Number.isFinite)
    const netProfits = records.map(r => r.netEdgeUsd !== undefined ? r.netEdgeUsd : (r.trade ? r.trade.expectedNetProfitUsd : 0)).filter(Number.isFinite)

    const executed = records.filter(r => (r.preflight && r.preflight.passed) || (r.preflight && r.preflight.executed))
    const capturedProfit = records.reduce((acc, r) => acc + (r.capturedProfitUsd !== undefined ? r.capturedProfitUsd : ((r.preflight && r.preflight.capturedProfitUsd) || 0)), 0)

    const sum = (arr) => arr.reduce((a, b) => a + b, 0)
    const avg = (arr) => arr.length ? sum(arr) / arr.length : 0

    return {
        totalRecords: records.length,
        executedRecords: executed.length,
        passedCount: executed.length,
        latencies: {
            totalLatencyMs: {
                p50: Number(percentile(totalLats, 50).toFixed(2)),
                p90: Number(percentile(totalLats, 90).toFixed(2)),
                p99: Number(percentile(totalLats, 99).toFixed(2)),
                mean: Number(avg(totalLats).toFixed(2))
            }
        },
        sizesUsd: {
            min: sizes.length ? Math.min(...sizes) : 0,
            max: sizes.length ? Math.max(...sizes) : 0,
            mean: Math.round(avg(sizes))
        },
        economics: {
            grossEdgeEvaluatedUsd: Number(sum(grossEdges).toFixed(2)),
            netEdgeEvaluatedUsd: Number(sum(netProfits).toFixed(2)),
            capturedProfitUsd: Number(capturedProfit.toFixed(3)),
            netCapturedProfitUsd: Number(capturedProfit.toFixed(3))
        }
    }
}

function printReport(report) {
    console.log('====================================')
    console.log(' TELEMETRY REPORT')
    console.log('====================================')
    console.log(`Total Records:    ${report.totalRecords}`)
    console.log(`Executed Trades:  ${report.executedRecords}`)
    if (report.latencies) {
        console.log(`Latency p50:      ${report.latencies.totalLatencyMs.p50} ms`)
        console.log(`Latency p90:      ${report.latencies.totalLatencyMs.p90} ms`)
    }
    if (report.economics) {
        console.log(`Captured Profit:  $${report.economics.capturedProfitUsd} USD`)
    }
}

module.exports = { generateTelemetryReport, printReport }
