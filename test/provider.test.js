'use strict'

const assert = require('assert')
const { CanonicalBlockFeed } = require('../src/pools/provider')

const sockets = []

class FakeWebSocket {
    constructor(url) {
        this.url = url
        this.handlers = {}
        this.sent = []
        sockets.push(this)
    }

    on(event, handler) {
        this.handlers[event] = handler
    }

    send(message) {
        this.sent.push(JSON.parse(message))
    }

    emit(event, value) {
        if (this.handlers[event]) this.handlers[event](value)
    }

    close() {
        this.emit('close')
    }
}

function notification(number, hash) {
    return JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_subscription',
        params: { subscription: 'sub-1', result: { number, hash } }
    })
}

function waitForProcessing(feed) {
    return feed.processing
}

async function main() {
    const events = []
    const metrics = {
        counters: {},
        increment(name, amount = 1) { this.counters[name] = (this.counters[name] || 0) + amount }
    }
    const recovered = []
    const feed = new CanonicalBlockFeed({
        url: 'wss://canonical-base.example',
        WebSocket: FakeWebSocket,
        provider: {
            async getBlock(number) {
                recovered.push(number)
                return { number, hash: `hash-${number}` }
            }
        },
        metrics,
        reconnectDelay: 0.001,
        maxReconnectDelay: 0.002,
        logger: { info() {}, warn() {}, error() {} },
        onBlock: async block => events.push(block)
    })

    feed.start()
    assert.strictEqual(sockets.length, 1)
    assert.strictEqual(sockets[0].url, 'wss://canonical-base.example')
    sockets[0].emit('open')
    assert.strictEqual(sockets[0].sent[0].method, 'eth_subscribe')
    assert.deepStrictEqual(sockets[0].sent[0].params, ['newHeads'])

    sockets[0].emit('message', notification('0x10', 'hash-16'))
    sockets[0].emit('message', notification('0x12', 'hash-18'))
    await waitForProcessing(feed)

    assert.deepStrictEqual(events.map(event => event.number), [16, 17, 18])
    assert.strictEqual(events[1].recovered, true)
    assert.deepStrictEqual(recovered, [17])
    assert.strictEqual(metrics.counters.canonicalMissedBlocks, 1)
    assert.strictEqual(metrics.counters.canonicalBlocksRecovered, 1)
    assert.strictEqual(metrics.counters.canonicalBlocksReceived, 2)

    sockets[0].emit('close')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.strictEqual(sockets.length, 2)
    assert.strictEqual(metrics.counters.canonicalReconnects, 1)
    feed.stop()

    const failedMetrics = {
        counters: {},
        increment(name, amount = 1) { this.counters[name] = (this.counters[name] || 0) + amount }
    }
    const failedFeed = new CanonicalBlockFeed({
        url: 'wss://canonical-base.example',
        WebSocket: FakeWebSocket,
        provider: { async getBlock() { throw new Error('RPC unavailable') } },
        metrics: failedMetrics,
        logger: { info() {}, warn() {}, error() {} },
        onBlock: async () => {}
    })
    failedFeed.start()
    const failedSocket = sockets[sockets.length - 1]
    failedSocket.emit('open')
    failedSocket.emit('message', notification('0x20', 'hash-32'))
    failedSocket.emit('message', notification('0x22', 'hash-34'))
    await waitForProcessing(failedFeed)
    assert.strictEqual(failedMetrics.counters.canonicalRpcFailures, 1)
    failedFeed.stop()

    console.log('provider-tests-ok')
}

main().catch(error => { console.error(error); process.exitCode = 1 })