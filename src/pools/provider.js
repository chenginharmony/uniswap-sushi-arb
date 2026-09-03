'use strict'

class BaseRpcProvider {
    constructor(options = {}) {
        this.web3 = options.web3
        if (!this.web3) {
            const Web3 = options.Web3 || require('web3')
            if (!options.httpUrl) throw new Error('BASE_RPC_URL is required for canonical pool state')
            this.web3 = new Web3(new Web3.providers.HttpProvider(options.httpUrl))
        }
    }

    async call(address, abi, method, args = []) {
        const contract = new this.web3.eth.Contract(abi, address)
        if (!contract.methods[method]) throw new Error(`Contract method ${method} is not available`)
        return contract.methods[method](...args).call()
    }

    async getBlockNumber() {
        return this.web3.eth.getBlockNumber()
    }

    async getBlock(blockNumber) {
        return this.web3.eth.getBlock(blockNumber)
    }
}

function parseBlockNumber(value) {
    if (value === undefined || value === null) return null
    try {
        const parsed = typeof value === 'bigint'
            ? value
            : BigInt(typeof value === 'string' && /^0x/i.test(value) ? value : String(value))
        return parsed >= 0n ? parsed : null
    } catch (error) {
        return null
    }
}

function blockNumberValue(number) {
    return number <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(number) : number.toString()
}

class CanonicalBlockFeed {
    constructor(options = {}) {
        this.url = options.url
        this.provider = options.provider
        this.onBlock = options.onBlock || (async () => {})
        this.subscription = options.subscription || 'newHeads'
        this.reconnectDelay = Math.max(0, Number(options.reconnectDelay === undefined ? 1 : options.reconnectDelay)) * 1000
        this.maxReconnectDelay = Math.max(this.reconnectDelay, Number(options.maxReconnectDelay === undefined ? 30 : options.maxReconnectDelay) * 1000)
        this.logger = options.logger || console
        this.metrics = options.metrics
        this.WebSocket = options.WebSocket
        this.socket = null
        this.requestId = 1
        this.stopped = true
        this.currentDelay = this.reconnectDelay
        this.reconnectTimer = null
        this.processing = Promise.resolve()
        this.lastBlockNumber = null
        this.lastBlockHash = null
    }

    increment(name, amount = 1) {
        if (this.metrics && typeof this.metrics.increment === 'function') this.metrics.increment(name, amount)
    }

    log(level, ...args) {
        const logger = this.logger && typeof this.logger[level] === 'function' ? this.logger[level] : console[level]
        logger.apply(this.logger && typeof this.logger[level] === 'function' ? this.logger : console, args)
    }

    start(onBlock) {
        if (!this.url) throw new Error('BASE_WS_URL is required when the canonical Base feed is enabled')
        if (typeof onBlock === 'function') this.onBlock = onBlock
        if (!this.WebSocket) this.WebSocket = require('ws')
        this.stopped = false
        this.connect()
        return this
    }

    connect() {
        if (this.stopped) return
        this.increment('canonicalConnectionAttempts')
        try {
            this.socket = new this.WebSocket(this.url)
            this.socket.on('open', () => {
                this.currentDelay = this.reconnectDelay
                this.increment('canonicalConnections')
                this.log('info', '[CANONICAL] connected to Base block feed')
                this.socket.send(JSON.stringify({
                    jsonrpc: '2.0',
                    id: this.requestId++,
                    method: 'eth_subscribe',
                    params: [this.subscription]
                }))
            })
            this.socket.on('message', data => this.handleMessage(data))
            this.socket.on('error', error => {
                this.increment('canonicalConnectionErrors')
                this.log('warn', '[CANONICAL] connection error:', error.message)
            })
            this.socket.on('close', () => {
                this.increment('canonicalDisconnects')
                if (this.stopped) return
                this.scheduleReconnect()
            })
        } catch (error) {
            this.increment('canonicalConnectionErrors')
            this.log('warn', '[CANONICAL] connection failed:', error.message)
            this.scheduleReconnect()
        }
    }

    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return
        const delay = this.currentDelay
        this.currentDelay = Math.min(Math.max(this.currentDelay * 2, this.reconnectDelay), this.maxReconnectDelay)
        this.increment('canonicalReconnects')
        this.log('warn', `[CANONICAL] reconnecting in ${delay}ms`)
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this.connect()
        }, delay)
    }

    handleMessage(data) {
        let message
        try {
            message = JSON.parse(data.toString())
        } catch (error) {
            this.increment('canonicalMalformedMessages')
            this.log('warn', '[CANONICAL] malformed websocket message:', error.message)
            return
        }

        const header = message && message.params && message.params.result
        if (!header) return
        const number = parseBlockNumber(header.number || header.blockNumber)
        if (number === null) {
            this.increment('canonicalMalformedMessages')
            this.log('warn', '[CANONICAL] block notification is missing a valid number')
            return
        }
        this.processing = this.processing
            .then(() => this.processHeader(Object.assign({}, header, {
                number: blockNumberValue(number),
                blockNumber: blockNumberValue(number)
            }), number))
            .catch(error => {
                this.increment('canonicalProcessingErrors')
                this.log('error', '[CANONICAL] block processing failed:', error.message)
            })
    }

    async processHeader(header, number) {
        if (this.lastBlockNumber !== null) {
            if (number < this.lastBlockNumber) {
                this.increment('canonicalOutOfOrderBlocks')
                this.log('warn', `[CANONICAL] ignored out-of-order block ${number.toString()}`)
                return
            }
            if (number === this.lastBlockNumber && header.hash === this.lastBlockHash) {
                this.increment('canonicalDuplicateBlocks')
                return
            }
            if (number > this.lastBlockNumber + 1n) {
                const missed = number - this.lastBlockNumber - 1n
                this.increment('canonicalMissedBlocks', Number(missed))
                this.log('warn', `[CANONICAL] missed ${missed.toString()} block(s) between ${this.lastBlockNumber.toString()} and ${number.toString()}`)
                await this.recoverMissedBlocks(this.lastBlockNumber + 1n, number)
            }
        }

        await this.onBlock(header)
        this.increment('canonicalBlocksReceived')
        this.lastBlockNumber = number
        this.lastBlockHash = header.hash || null
    }

    async recoverMissedBlocks(first, exclusiveEnd) {
        for (let number = first; number < exclusiveEnd; number += 1n) {
            if (!this.provider || typeof this.provider.getBlock !== 'function') {
                this.increment('canonicalRpcFailures')
                this.log('error', `[CANONICAL] cannot recover block ${number.toString()}: no canonical RPC provider`)
                continue
            }
            try {
                const block = await this.provider.getBlock(blockNumberValue(number))
                if (!block) throw new Error('RPC returned no block')
                const recoveredNumber = parseBlockNumber(block.number || block.blockNumber)
                if (recoveredNumber === null) throw new Error('RPC returned a block without a valid number')
                if (recoveredNumber !== number) throw new Error(`RPC returned block ${recoveredNumber.toString()} instead of ${number.toString()}`)
                await this.onBlock(Object.assign({}, block, {
                    number: blockNumberValue(recoveredNumber),
                    blockNumber: blockNumberValue(recoveredNumber),
                    recovered: true
                }))
                this.increment('canonicalBlocksRecovered')
            } catch (error) {
                this.increment('canonicalRpcFailures')
                this.log('error', `[CANONICAL] failed to recover block ${number.toString()}:`, error.message)
            }
        }
    }

    stop() {
        this.stopped = true
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
        if (this.socket) {
            try { this.socket.close() } catch (error) {}
            this.socket = null
        }
    }
}

module.exports = { BaseRpcProvider, CanonicalBlockFeed, parseBlockNumber }