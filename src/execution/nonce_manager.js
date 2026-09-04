'use strict'

/**
 * @title NonceManager
 * @notice High-performance atomic nonce manager for Base L2 MEV transactions.
 * Prevents nonce collisions, manages in-flight transactions, and handles resyncing.
 */
class NonceManager {
    constructor(options = {}) {
        this.rpcUrl = options.rpcUrl || 'https://mainnet.base.org'
        this.walletAddress = (options.walletAddress || '').toLowerCase()
        this.currentNonce = null
        this.nextNonce = null
        this.pendingNonces = new Map() // nonce -> { timestamp, txHash, data }
        this.locked = false
        this.syncInProgress = false
        this.rpcCaller = options.rpcCaller || this.defaultRpcCall.bind(this)
    }

    async defaultRpcCall(method, params = []) {
        const res = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
        })
        const json = await res.json()
        if (json.error) throw new Error(`RPC error: ${json.error.message}`)
        return json.result
    }

    /**
     * Synchronizes nonce counter against on-chain state.
     * Uses 'pending' block tag to account for mempool transactions.
     */
    async sync(tag = 'pending') {
        if (!this.walletAddress || this.walletAddress === '0x0000000000000000000000000000000000000000') {
            this.currentNonce = 0
            this.nextNonce = 0
            return 0
        }

        try {
            this.syncInProgress = true
            const hexNonce = await this.rpcCaller('eth_getTransactionCount', [this.walletAddress, tag])
            const onChainNonce = parseInt(hexNonce, 16)

            if (this.currentNonce === null || onChainNonce > this.currentNonce) {
                this.currentNonce = onChainNonce
                this.nextNonce = Math.max(this.nextNonce || 0, onChainNonce)
            }

            // Prune confirmed pending nonces lower than on-chain nonce
            for (const [nonce] of this.pendingNonces.entries()) {
                if (nonce < onChainNonce) {
                    this.pendingNonces.delete(nonce)
                }
            }

            return this.nextNonce
        } finally {
            this.syncInProgress = false
        }
    }

    /**
     * Atomically acquires the next available nonce for a new transaction.
     */
    async acquire(metadata = {}) {
        if (this.nextNonce === null) {
            await this.sync()
        }

        const acquired = this.nextNonce
        this.nextNonce++
        this.pendingNonces.set(acquired, {
            timestamp: Date.now(),
            metadata,
            status: 'in-flight'
        })

        return acquired
    }

    /**
     * Confirms that a transaction with this nonce was included in a block.
     */
    confirm(nonce) {
        if (this.pendingNonces.has(nonce)) {
            this.pendingNonces.delete(nonce)
        }
        if (this.currentNonce === null || nonce >= this.currentNonce) {
            this.currentNonce = nonce + 1
        }
    }

    /**
     * Releases an unbroadcasted or preflight-failed nonce so it can be reused without creating gaps.
     */
    release(nonce) {
        if (this.pendingNonces.has(nonce)) {
            this.pendingNonces.delete(nonce)
        }
        // If this was the most recently acquired nonce and no newer ones exist, decrement
        if (this.nextNonce === nonce + 1 && this.pendingNonces.size === 0) {
            this.nextNonce = nonce
        }
    }

    /**
     * Checks if any in-flight transaction has been stuck for longer than thresholdMs.
     */
    getStuckNonces(thresholdMs = 5000) {
        const now = Date.now()
        const stuck = []
        for (const [nonce, item] of this.pendingNonces.entries()) {
            if (now - item.timestamp > thresholdMs) {
                stuck.push({ nonce, ageMs: now - item.timestamp, metadata: item.metadata })
            }
        }
        return stuck
    }

    /**
     * Resets internal pending queue after connection drops or reorgs.
     */
    async reset() {
        this.pendingNonces.clear()
        this.currentNonce = null
        this.nextNonce = null
        return this.sync()
    }

    getPendingCount() {
        return this.pendingNonces.size
    }
}

module.exports = { NonceManager }
