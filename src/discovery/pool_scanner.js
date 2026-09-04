'use strict'

const { Broadcaster } = require('../execution/broadcaster')
const { keccak256 } = require('ethereum-cryptography/keccak')

const FACTORIES = {
    uniswap_v3: {
        name: 'uniswap',
        address: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
        type: 'v3',
        feeTiers: [100, 500, 3000, 10000]
    },
    pancakeswap_v3: {
        name: 'pancakeswap',
        address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
        type: 'v3',
        feeTiers: [100, 500, 2500, 10000]
    },
    aerodrome_slipstream: {
        name: 'aerodrome_slipstream',
        address: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
        type: 'slipstream',
        feeTiers: [1, 50, 100, 200, 2000] // Tick spacings: 1, 50, 100, 200
    },
    aerodrome_v1: {
        name: 'aerodrome-v1',
        address: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
        type: 'v1_amm',
        stableFlags: [false, true]
    },
    sushiswap_v3: {
        name: 'sushiswap',
        address: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
        type: 'v3',
        feeTiers: [100, 500, 3000, 10000]
    }
}

/**
 * @title PoolScanner
 * @notice Background engine for scanning and discovering candidate liquidity pools across Base DEXes.
 */
class PoolScanner {
    constructor(broadcaster = null) {
        this.broadcaster = broadcaster || new Broadcaster({ rpcUrl: 'https://base-rpc.publicnode.com' })
    }

    /**
     * Queries a V3-style factory for pool(tokenA, tokenB, fee).
     */
    async getV3Pool(factoryAddress, tokenA, tokenB, feeTier) {
        const tA = tokenA.toLowerCase().replace('0x', '').padStart(64, '0')
        const tB = tokenB.toLowerCase().replace('0x', '').padStart(64, '0')
        const feeHex = Number(feeTier).toString(16).padStart(64, '0')

        // getPool(address,address,uint24) -> 0x1698ee82
        const calldata = '0x1698ee82' + tA + tB + feeHex
        try {
            const res = await this.broadcaster.rpcCall('eth_call', [{ to: factoryAddress, data: calldata }, 'latest'])
            if (!res.result || res.result === '0x' || res.result.length < 66) return null
            const poolAddr = '0x' + res.result.slice(26)
            if (poolAddr === '0x0000000000000000000000000000000000000000') return null
            return poolAddr.toLowerCase()
        } catch (e) {
            return null
        }
    }

    /**
     * Queries Aerodrome V1 factory for getPool(tokenA, tokenB, stable).
     */
    async getAeroV1Pool(factoryAddress, tokenA, tokenB, stable = false) {
        const tA = tokenA.toLowerCase().replace('0x', '').padStart(64, '0')
        const tB = tokenB.toLowerCase().replace('0x', '').padStart(64, '0')
        const stableHex = stable ? '1'.padStart(64, '0') : '0'.repeat(64)

        // getPool(address,address,bool) -> 0x79bc57d5
        const calldata = '0x79bc57d5' + tA + tB + stableHex
        try {
            const res = await this.broadcaster.rpcCall('eth_call', [{ to: factoryAddress, data: calldata }, 'latest'])
            if (!res.result || res.result === '0x' || res.result.length < 66) return null
            const poolAddr = '0x' + res.result.slice(26)
            if (poolAddr === '0x0000000000000000000000000000000000000000') return null
            return poolAddr.toLowerCase()
        } catch (e) {
            return null
        }
    }

    /**
     * Scans all known factories for candidate pools between two tokens.
     */
    async scanTokenPair(tokenA, tokenB, meta = {}) {
        const results = []

        // 1. Scan Concentrated Liquidity Factories (Uniswap, Pancake, Sushi, Slipstream)
        for (const [key, fact] of Object.entries(FACTORIES)) {
            if (fact.type === 'v3' || fact.type === 'slipstream') {
                for (const fee of fact.feeTiers) {
                    const poolAddr = await this.getV3Pool(fact.address, tokenA.address, tokenB.address, fee)
                    if (poolAddr) {
                        results.push({
                            address: poolAddr,
                            dex: fact.name,
                            adapter: fact.type === 'slipstream' ? 'aerodrome_slipstream' : (fact.name + '-v3'),
                            token0: tokenA.address.toLowerCase(),
                            token1: tokenB.address.toLowerCase(),
                            token0Symbol: tokenA.symbol,
                            token1Symbol: tokenB.symbol,
                            token0Decimals: tokenA.decimals,
                            token1Decimals: tokenB.decimals,
                            feeTier: fee,
                            feeBps: fact.type === 'slipstream' ? fee : fee / 100
                        })
                    }
                }
            } else if (fact.type === 'v1_amm') {
                // 2. Scan Aerodrome V1 Volatile & Stable
                for (const stable of fact.stableFlags) {
                    const poolAddr = await this.getAeroV1Pool(fact.address, tokenA.address, tokenB.address, stable)
                    if (poolAddr) {
                        results.push({
                            address: poolAddr,
                            dex: fact.name,
                            adapter: 'aerodrome-v1',
                            token0: tokenA.address.toLowerCase(),
                            token1: tokenB.address.toLowerCase(),
                            token0Symbol: tokenA.symbol,
                            token1Symbol: tokenB.symbol,
                            token0Decimals: tokenA.decimals,
                            token1Decimals: tokenB.decimals,
                            stable,
                            feeBps: stable ? 5 : 30
                        })
                    }
                }
            }
        }

        return results
    }
}

module.exports = {
    PoolScanner,
    FACTORIES
}
