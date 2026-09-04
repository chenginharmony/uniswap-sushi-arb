'use strict'

const DEFAULT_RPC_URLS = [
    process.env.BASE_RPC_URL,
    'https://base-rpc.publicnode.com',
    'https://1rpc.io/base',
    'https://mainnet.base.org'
].filter(Boolean)

class Broadcaster {
    constructor(options = {}) {
        this.rpcUrls = options.rpcUrls || [
            process.env.BASE_RPC_URL,
            ...(options.rpcUrls || DEFAULT_RPC_URLS)
        ].filter(Boolean)
        this.timeoutMs = options.timeoutMs || 30000 // 30s timeout
        this.pollIntervalMs = options.pollIntervalMs || 1000
    }

    async rpcCall(method, params = []) {
        let lastError = null
        for (const url of this.rpcUrls) {
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: Date.now(),
                        method,
                        params
                    })
                })
                const json = await response.json()
                if (json.error) {
                    lastError = new Error(json.error.message || JSON.stringify(json.error))
                    continue
                }
                return { result: json.result, url }
            } catch (err) {
                lastError = err
            }
        }
        throw new Error(`Broadcast RPC error for ${method}: ${lastError ? lastError.message : 'All endpoints failed'}`)
    }

    /**
     * Checks if address has sufficient ETH balance to pay for transaction gas.
     */
    async checkBalance(address, minRequiredWei = 100000000000000n) { // default 0.0001 ETH
        const res = await this.rpcCall('eth_getBalance', [address, 'latest'])
        const balanceWei = BigInt(res.result || 0)
        return {
            sufficient: balanceWei >= minRequiredWei,
            balanceWei,
            balanceEth: Number(balanceWei) / 1e18
        }
    }

    /**
     * Retrieves dynamic EIP-1559 gas fee parameters on Base L2.
     */
    async getDynamicGasFees() {
        const blockRes = await this.rpcCall('eth_getBlockByNumber', ['latest', false])
        const block = blockRes.result
        const baseFeePerGas = block && block.baseFeePerGas ? BigInt(block.baseFeePerGas) : 10000000n // ~0.01 gwei default

        // On Base L2, priority fees are typically 0.001 - 0.01 gwei
        const maxPriorityFeePerGas = 10000000n // 0.01 gwei
        const maxFeePerGas = (baseFeePerGas * 125n) / 100n + maxPriorityFeePerGas

        return {
            baseFeePerGas,
            maxPriorityFeePerGas,
            maxFeePerGas
        }
    }

    /**
     * Broadcasts a signed raw transaction to Base Mainnet.
     */
    async broadcastRawTransaction(rawTransaction) {
        if (!rawTransaction || !rawTransaction.startsWith('0x')) {
            throw new Error('INVALID_RAW_TRANSACTION: Must be a hex string starting with 0x')
        }

        const res = await this.rpcCall('eth_sendRawTransaction', [rawTransaction])
        const txHash = res.result

        return {
            broadcast: true,
            transactionHash: txHash,
            submittedAt: Date.now(),
            rpcUrl: res.url
        }
    }

    /**
     * Waits for a broadcast transaction to be mined and returns receipt.
     */
    async waitForReceipt(txHash, timeoutMs = this.timeoutMs) {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            try {
                const res = await this.rpcCall('eth_getTransactionReceipt', [txHash])
                if (res.result) {
                    const receipt = res.result
                    const status = receipt.status === '0x1' ? 'SUCCESS' : 'REVERTED'
                    return {
                        confirmed: true,
                        status,
                        blockNumber: parseInt(receipt.blockNumber, 16),
                        gasUsed: parseInt(receipt.gasUsed, 16),
                        transactionHash: txHash,
                        receipt
                    }
                }
            } catch (e) {}

            await new Promise(r => setTimeout(r, this.pollIntervalMs))
        }

        return {
            confirmed: false,
            status: 'TIMEOUT',
            transactionHash: txHash,
            error: `Confirmation timeout after ${timeoutMs}ms`
        }
    }
}

module.exports = { Broadcaster, DEFAULT_RPC_URLS }
