'use strict'

const zlib = require('zlib')
const rlp = require('rlp')
const { keccak256 } = require('ethereum-cryptography/keccak')
const { FlashblockTransaction } = require('./models')

function first(object, keys) {
    for (const key of keys) {
        if (object && object[key] !== undefined && object[key] !== null) return object[key]
    }
    return null
}

function decompressPayload(payload) {
    if (Buffer.isBuffer(payload)) {
        try {
            return zlib.brotliDecompressSync(payload).toString('utf8')
        } catch (e) {
            try {
                return zlib.gunzipSync(payload).toString('utf8')
            } catch (e2) {
                return payload.toString('utf8')
            }
        }
    }
    return payload
}

function decodeRawTx(txHex, blockNumber, context) {
    let raw = txHex
    let type = 0
    if (raw.startsWith('0x02')) {
        type = 2
        raw = '0x' + raw.slice(4)
    } else if (raw.startsWith('0x01')) {
        type = 1
        raw = '0x' + raw.slice(4)
    }

    let to = null
    let input = '0x'
    let from = null
    try {
        const buf = Buffer.from(raw.replace('0x', ''), 'hex')
        const decoded = rlp.decode(buf)
        if (type === 2 && decoded.length >= 8) {
            to = decoded[5] && decoded[5].length === 20 ? '0x' + Buffer.from(decoded[5]).toString('hex').toLowerCase() : null
            input = '0x' + Buffer.from(decoded[7]).toString('hex')
        } else if (type === 0 && decoded.length >= 6) {
            to = decoded[3] && decoded[3].length === 20 ? '0x' + Buffer.from(decoded[3]).toString('hex').toLowerCase() : null
            input = '0x' + Buffer.from(decoded[5]).toString('hex')
        }
    } catch (e) {}

    const txHash = '0x' + Buffer.from(keccak256(Buffer.from(txHex.replace('0x', ''), 'hex'))).toString('hex')

    return new FlashblockTransaction({
        transactionHash: txHash,
        from,
        to,
        value: '0x0',
        input,
        blockNumber,
        context,
        receivedAt: Date.now(),
        receivedMonotonicNs: process.hrtime.bigint(),
        raw: txHex
    })
}

function parseFlashblockMessage(payload) {
    const raw = decompressPayload(payload)
    const message = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!message || typeof message !== 'object') throw new Error('Flashblocks payload must be an object')

    // Handle native Base Mainnet Flashblocks bundle format: { metadata, diff: { transactions: [...] } }
    if (message.diff && Array.isArray(message.diff.transactions)) {
        const blockNumber = message.metadata ? message.metadata.block_number : null
        const context = message.metadata ? (message.metadata.prev_flashblock_id || String(blockNumber)) : 'flashblock'
        const txs = []
        for (const txHex of message.diff.transactions) {
            if (typeof txHex === 'string') {
                txs.push(decodeRawTx(txHex, blockNumber, context))
            }
        }
        return txs
    }

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
        logs: first(transaction, ['logs', 'events']) || first(result, ['logs', 'events']) || [],
        blockNumber: first(transaction, ['blockNumber']) || first(result, ['blockNumber']),
        context: first(result, ['flashblock', 'context', 'blockHash', 'blockNumber']),
        transactionIndex: first(transaction, ['transactionIndex', 'index']),
        receivedAt: Date.now(),
        receivedMonotonicNs: process.hrtime.bigint(),
        raw: message
    })
}

module.exports = { parseFlashblockMessage, decodeRawTx }
