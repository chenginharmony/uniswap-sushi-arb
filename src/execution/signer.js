'use strict'

const rlp = require('rlp')
const { keccak256 } = require('ethereum-cryptography/keccak')
const secp = require('ethereum-cryptography/secp256k1')

function stripLeadingZeros(b) {
    let i = 0
    while (i < b.length && b[i] === 0) i++
    return b.slice(i)
}

function toBuf(v) {
    if (!v || v === '0x0' || v === 0 || v === 0n) return Buffer.alloc(0)
    if (typeof v === 'string') {
        const s = v.startsWith('0x') ? v.slice(2) : v
        const buf = Buffer.from(s.length % 2 === 1 ? '0' + s : s, 'hex')
        return stripLeadingZeros(buf)
    }
    if (typeof v === 'number' || typeof v === 'bigint') {
        const hex = BigInt(v).toString(16)
        return stripLeadingZeros(Buffer.from(hex.length % 2 === 1 ? '0' + hex : hex, 'hex'))
    }
    return Buffer.from(v)
}

function deriveAddressFromPrivateKey(privateKeyHex) {
    try {
        const clean = privateKeyHex.replace('0x', '')
        const pk = Buffer.from(clean, 'hex')
        const pub = secp.publicKeyCreate(pk, false).slice(1)
        return '0x' + Buffer.from(keccak256(Buffer.from(pub))).slice(-20).toString('hex')
    } catch (e) {
        return null
    }
}

/**
 * Signs an EIP-1559 type 2 transaction.
 */
function signEIP1559Transaction(tx, privateKeyHex) {
    const clean = privateKeyHex.replace('0x', '')
    const pk = Buffer.from(clean, 'hex')

    const raw = [
        toBuf(tx.chainId),
        toBuf(tx.nonce),
        toBuf(tx.maxPriorityFeePerGas),
        toBuf(tx.maxFeePerGas),
        toBuf(tx.gasLimit),
        toBuf(tx.to),
        toBuf(tx.value),
        toBuf(tx.data),
        [] // empty accessList
    ]

    const payload = Buffer.concat([Buffer.from([2]), rlp.encode(raw)])
    const msgHash = Buffer.from(keccak256(payload))
    const sigObj = secp.ecdsaSign(msgHash, pk)

    const r = Buffer.from(sigObj.signature.slice(0, 32))
    const s = Buffer.from(sigObj.signature.slice(32, 64))
    const v = Buffer.from(sigObj.recid === 0 ? [] : [sigObj.recid])

    const signedRaw = Buffer.concat([Buffer.from([2]), rlp.encode([...raw, v, r, s])])
    const txHash = '0x' + Buffer.from(keccak256(signedRaw)).toString('hex')

    return {
        rawTransaction: '0x' + signedRaw.toString('hex'),
        transactionHash: txHash
    }
}

/**
 * @title IsolatedSigner
 * @notice Isolated transaction signing engine for Base L2.
 * Securely signs EIP-1559 transactions for live execution or prepares dry-run payloads.
 */
class IsolatedSigner {
    constructor(options = {}) {
        this.chainId = options.chainId || 8453 // Base Mainnet
        this.dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : true
        this.executionEnabled = options.executionEnabled !== undefined ? Boolean(options.executionEnabled) : false
        
        // Private key is accessed solely inside this module, never exposed or logged
        const rawKey = options.privateKey || process.env.BASE_DEPLOYER_KEY || process.env.PRIVATE_KEY || null
        this.hasPrivateKey = Boolean(rawKey && rawKey.replace('0x', '').length === 64)
        this._privateKey = this.hasPrivateKey ? (rawKey.startsWith('0x') ? rawKey : '0x' + rawKey) : null

        // Derive address if private key is present
        this.address = null
        if (this.hasPrivateKey) {
            this.address = deriveAddressFromPrivateKey(this._privateKey)
        }
        if (!this.address) {
            this.address = options.walletAddress || process.env.PROFIT_WALLET || '0x0000000000000000000000000000000000000000'
        }
    }

    /**
     * Prepares and signs an EIP-1559 transaction.
     */
    async prepareTransaction(txData, nonce) {
        if (!txData || !txData.to || !txData.data) {
            throw new Error('INVALID_TRANSACTION_PAYLOAD')
        }

        const transaction = {
            to: txData.to,
            data: txData.data,
            value: txData.value || '0x0',
            nonce: Number(nonce),
            chainId: this.chainId,
            gasLimit: txData.gasLimit ? BigInt(txData.gasLimit) : 450000n,
            maxFeePerGas: txData.maxFeePerGas ? BigInt(txData.maxFeePerGas) : 100000000n, // ~0.1 gwei
            maxPriorityFeePerGas: txData.maxPriorityFeePerGas ? BigInt(txData.maxPriorityFeePerGas) : 10000000n // ~0.01 gwei
        }

        // DRY-RUN GATE
        if (this.dryRun || !this.executionEnabled) {
            return {
                isSigned: false,
                transaction,
                rawTransaction: null,
                broadcastAllowed: false,
                mode: 'DRY_RUN',
                reason: 'LIVE_EXECUTION_DISABLED'
            }
        }

        // LIVE EXECUTION SIGNING
        if (!this.hasPrivateKey) {
            throw new Error('MISSING_SIGNER_KEY: Cannot sign live transaction without PRIVATE_KEY')
        }

        try {
            const signed = signEIP1559Transaction(transaction, this._privateKey)

            return {
                isSigned: true,
                transaction,
                rawTransaction: signed.rawTransaction,
                transactionHash: signed.transactionHash,
                broadcastAllowed: true,
                mode: 'LIVE_SIGNED'
            }
        } catch (err) {
            throw new Error(`SIGNING_FAILED: ${err.message}`)
        }
    }

    getAddress() {
        return this.address
    }

    isReady() {
        return Boolean(this.hasPrivateKey && this.address)
    }

    isBroadcastAllowed() {
        return !this.dryRun && this.executionEnabled && this.hasPrivateKey
    }
}

module.exports = {
    IsolatedSigner,
    deriveAddressFromPrivateKey,
    signEIP1559Transaction
}
