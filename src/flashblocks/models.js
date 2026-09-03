'use strict'

class FlashblockTransaction {
    constructor(values) {
        this.transactionHash = values.transactionHash || null
        this.from = values.from || null
        this.to = values.to || null
        this.value = values.value || '0x0'
        this.input = values.input || '0x'
        this.gas = values.gas || null
        this.gasPrice = values.gasPrice || null
        this.context = values.context || null
        this.transactionIndex = values.transactionIndex === undefined ? null : values.transactionIndex
        this.receivedAt = values.receivedAt || Date.now()
        this.receivedMonotonicNs = values.receivedMonotonicNs || process.hrtime.bigint()
        this.raw = values.raw
    }
}

module.exports = { FlashblockTransaction }
