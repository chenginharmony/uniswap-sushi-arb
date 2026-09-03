'use strict'

class Metrics {
    constructor() {
        this.counters = Object.create(null)
        this.latencies = Object.create(null)
        this.netProfits = []
    }

    increment(name, amount = 1) { this.counters[name] = (this.counters[name] || 0) + amount }

    observe(name, milliseconds) {
        if (!this.latencies[name]) this.latencies[name] = []
        this.latencies[name].push(milliseconds)
    }

    recordNetProfit(value) { this.netProfits.push(Number(value)) }

    percentile(name, percentile) {
        const values = (this.latencies[name] || []).slice().sort((a, b) => a - b)
        if (!values.length) return 0
        return values[Math.min(values.length - 1, Math.ceil(values.length * percentile) - 1)]
    }

    summary() {
        return {
            counters: Object.assign({}, this.counters),
            p95LatencyMs: this.percentile('totalDetectionToSubmission', 0.95),
            p99LatencyMs: this.percentile('totalDetectionToSubmission', 0.99),
            averageNetProfit: this.netProfits.length ? this.netProfits.reduce((sum, value) => sum + value, 0) / this.netProfits.length : 0
        }
    }
}

module.exports = { Metrics }
