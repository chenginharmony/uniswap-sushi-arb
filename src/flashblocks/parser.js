'use strict'

const { FlashblockTransaction } = require('./models')

function first(object, keys) {
    for (const key of keys) {
        if (object && object[key] !== undefined && object[key] !== null) return object[key]
    }
    return null
}

function parseFlashblockMessage(payload) {
    const message = typeof payload === 'string' ? JSON.parse(payload) : payload
    if (!message || typeof message !== 'object') throw new Error('Flashblocks payload must be an object')
    const result = message.result || message.params && message.params.result || message.data || message
    const transaction = result.transaction || result.tx || result
    const transactionHash = first(transaction, ['hash', 'transactionHash', 'txHash'])
    const input = first(transaction, ['input', 'data', 'calldata'])
    if (!transactionHash || input === null) throw new Error('Flashblocks payload is missing transaction hash or input')

    return new FlashblockTransaction({
        transactionHash,
        from: first(transaction, ['from', 'sender']),
        to: first(transaction, ['to', 'recipient']),
        value: first(transaction, ['value']) || '0x0',
        input,
        gas: first(transaction, ['gas', 'gasLimit']),
        gasPrice: first(transaction, ['gasPrice', 'maxFeePerGas']),
        context: first(result, ['flashblock', 'context', 'blockHash', 'blockNumber']),
        transactionIndex: first(transaction, ['transactionIndex', 'index']),
        receivedAt: Date.now(),
        receivedMonotonicNs: process.hrtime.bigint(),
        raw: message
    })
}

module.exports = { parseFlashblockMessage }
