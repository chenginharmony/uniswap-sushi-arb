'use strict'

const { BoundedEventQueue } = require('./queue')
const { parseFlashblockMessage } = require('./parser')

class FlashblocksClient {
    constructor(options) {
        this.url = options.url
        this.subscription = options.subscription || 'newFlashblockTransactions'
        this.queue = options.queue || new BoundedEventQueue(options.queueSize || 1000)
        this.reconnectDelay = (options.reconnectDelay || 1) * 1000
        this.maxReconnectDelay = (options.maxReconnectDelay || 30) * 1000
        this.logger = options.logger || console
        this.WebSocket = options.WebSocket || require('ws')
        this.socket = null
        this.requestId = 1
        this.stopped = false
        this.currentDelay = this.reconnectDelay
    }

    start() {
        if (!this.url) throw new Error('FLASHBLOCKS_WS_URL is required when Flashblocks is enabled')
        this.stopped = false
        this.connect()
        return this.queue
    }

    connect() {
        if (this.stopped) return
        try {
            this.socket = new this.WebSocket(this.url)
            this.socket.on('open', () => {
                this.currentDelay = this.reconnectDelay
                this.socket.send(JSON.stringify({ jsonrpc: '2.0', id: this.requestId++, method: 'eth_subscribe', params: [this.subscription] }))
            })
            this.socket.on('message', data => {
                try { this.queue.push(parseFlashblockMessage(data.toString())) }
                catch (error) { this.logger.warn('[FLASHBLOCKS] malformed payload:', error.message) }
            })
            this.socket.on('error', error => this.logger.warn('[FLASHBLOCKS] connection error:', error.message))
            this.socket.on('close', () => {
                if (this.stopped) return
                const delay = this.currentDelay
                this.currentDelay = Math.min(this.currentDelay * 2, this.maxReconnectDelay)
                setTimeout(() => this.connect(), delay)
            })
        } catch (error) {
            this.logger.warn('[FLASHBLOCKS] connection failed:', error.message)
            const delay = this.currentDelay
            this.currentDelay = Math.min(this.currentDelay * 2, this.maxReconnectDelay)
            setTimeout(() => this.connect(), delay)
        }
    }

    stop() {
        this.stopped = true
        if (this.socket) this.socket.close()
    }
}

module.exports = { FlashblocksClient }
