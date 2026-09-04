'use strict'

const { buildFlashArbitrageTransaction } = require('./builder')

const CUSTOM_ERRORS = {
    '30cd7471': 'NotOwner',
    'cdea77d3': 'CallbackCallerMismatch',
    '08eb3853': 'CallbackPoolMismatch',
    '1ab7da6b': 'DeadlineExpired',
    '958f9f0f': 'ZeroBorrowAmount',
    'e6c4247b': 'InvalidAddress',
    'dbd2ca52': 'InvalidBorrowToken',
    '52b4b915': 'InvalidIntermediateToken',
    '466d7fef': 'InvalidRouter',
    'cb293bb7': 'InvalidFlashPool',
    'd3d13c6d': 'FlashPoolNotCanonical',
    '1213a0ab': 'InvalidPoolFee',
    '683d8c04': 'InvalidRouteFee',
    '8164f842': 'ApprovalFailed',
    '90b8ec18': 'TransferFailed',
    '4e47f8ea': 'InsufficientProfit',
    'e616ca2c': 'InvalidCallbackState',
    '7d0163fd': 'Leg1Slippage',
    'be0a8522': 'Leg2Slippage',
    'ab143c06': 'Reentrancy',
    'e980d1fe': 'RescueDuringExecution'
}

/**
 * Decodes ABI-encoded revert error strings and custom errors.
 */
function decodeRevertReason(hexData) {
    if (!hexData || hexData === '0x') return 'Unknown error (empty revert data)'
    const clean = hexData.replace('0x', '')

    // Error(string) selector: 0x08c379a0
    if (clean.startsWith('08c379a0')) {
        try {
            // Offset is at 32 bytes (64 hex chars), length at next 32 bytes
            const lengthHex = clean.slice(72, 136)
            const length = parseInt(lengthHex, 16)
            const strHex = clean.slice(136, 136 + length * 2)
            return Buffer.from(strHex, 'hex').toString('utf8')
        } catch (e) {
            return `Revert decode failed: ${e.message}`
        }
    }

    // Panic(uint256) selector: 0x4e487b71
    if (clean.startsWith('4e487b71')) {
        const code = parseInt(clean.slice(8, 72), 16)
        return `EVM Panic(0x${code.toString(16)})`
    }

    const sel = clean.slice(0, 8).toLowerCase()
    if (CUSTOM_ERRORS[sel]) {
        return CUSTOM_ERRORS[sel]
    }

    return `Custom Error: 0x${sel}`
}

/**
 * Performs an eth_call preflight simulation against Base RPC without broadcasting.
 *
 * @param {Object} txPayload - Unsigned transaction payload { to, data, ... }
 * @param {string} rpcUrl - Base JSON-RPC URL
 * @param {Object} stateOverrides - Optional state overrides for the simulation
 * @returns {Promise<Object>} Preflight simulation outcome
 */
async function preflightSimulation(txPayload, rpcUrl, stateOverrides = null) {
    if (!txPayload || !txPayload.to || !txPayload.data) {
        throw new Error('INVALID_TRANSACTION_PAYLOAD')
    }

    const callObj = {
        to: txPayload.to,
        data: txPayload.data,
        value: txPayload.value || '0x0'
    }

    if (txPayload.from) {
        callObj.from = txPayload.from
    }

    if (txPayload.gasLimit) {
        const g = typeof txPayload.gasLimit === 'bigint' ? txPayload.gasLimit : BigInt(txPayload.gasLimit)
        callObj.gas = '0x' + g.toString(16)
    }

    const params = [callObj, 'latest']

    if (stateOverrides) {
        params.push(stateOverrides)
    }

    try {
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method: 'eth_call',
                params
            })
        })

        const result = await response.json()

        if (result.error) {
            const revertReason = decodeRevertReason(result.error.data)
            const fallbackReason = (result.error.message && result.error.message.includes('revert'))
                ? result.error.message
                : (revertReason || 'REVERTED_WITHOUT_REASON')
            return {
                simulated: true,
                success: false,
                reverted: true,
                revertReason: revertReason !== 'Unknown error (empty revert data)' ? revertReason : fallbackReason,
                rawError: result.error
            }
        }

        let estimatedGas = null
        try {
            const estRes = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: Date.now() + 1,
                    method: 'eth_estimateGas',
                    params: [callObj]
                })
            })
            const estJson = await estRes.json()
            if (estJson.result && estJson.result !== '0x') {
                estimatedGas = BigInt(estJson.result)
            }
        } catch (e) {}

        return {
            simulated: true,
            success: true,
            reverted: false,
            result: result.result,
            estimatedGas
        }
    } catch (err) {
        return {
            simulated: false,
            success: false,
            error: err.message
        }
    }
}

module.exports = {
    decodeRevertReason,
    preflightSimulation
}
