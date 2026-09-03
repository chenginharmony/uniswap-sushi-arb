'use strict'

const ERC20_ABI = [
    { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
    { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }
]

const V2_FACTORY_ABI = [
    { type: 'function', name: 'getPair', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'bool' }], outputs: [{ type: 'address' }] }
]

const V2_POOL_ABI = [
    { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }] }
]

const V3_FACTORY_ABI = [
    { type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], outputs: [{ type: 'address' }] }
]

const V3_POOL_ABI = [
    { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
    { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
    {
        type: 'function',
        name: 'slot0',
        stateMutability: 'view',
        inputs: [],
        outputs: [
            { type: 'uint160' },
            { type: 'int24' },
            { type: 'uint16' },
            { type: 'uint16' },
            { type: 'uint16' },
            { type: 'uint8' },
            { type: 'bool' }
        ]
    }
]

const V2_SWAP_SIGNATURE = 'Swap(address,uint256,uint256,uint256,uint256,address)'
const V3_SWAP_SIGNATURE = 'Swap(address,address,int256,int256,uint160,uint128,int24)'

function isAddress(value) {
    return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

function requireAddress(value, label) {
    if (!isAddress(value)) throw new Error(`${label} must be a full 20-byte address`)
    return value
}

async function read(provider, address, abi, method, args) {
    if (!provider || typeof provider.call !== 'function') throw new Error('A canonical RPC provider is required')
    return provider.call(address, abi, method, args)
}

async function readMetadata(provider, address) {
    const [decimals, symbol] = await Promise.all([
        read(provider, address, ERC20_ABI, 'decimals'),
        read(provider, address, ERC20_ABI, 'symbol')
    ])
    return { decimals: Number(decimals), symbol: String(symbol) }
}

function firstDefined(values) {
    return values.find(value => value !== undefined && value !== null)
}

class PoolAdapter {
    constructor(options = {}) {
        this.provider = options.provider
        this.factoryAddress = options.factoryAddress ? requireAddress(options.factoryAddress, 'factoryAddress') : null
        this.pools = options.pools || []
        this.swapTopic = null
    }

    setSwapSignature(signature, explicitTopic) {
        this.swapSignature = signature
        this.swapTopic = explicitTopic || this.provider && this.provider.web3 && this.provider.web3.utils &&
            this.provider.web3.utils.sha3(signature)
    }

    async discoverPools() {
        const discovered = []
        for (const descriptor of this.pools) {
            const address = descriptor.address || await this.discoverPool(descriptor)
            requireAddress(address, 'discovered pool address')
            discovered.push(Object.assign({}, descriptor, { address }))
        }
        return discovered
    }

    async discoverPool() {
        throw new Error(`${this.name} requires a pool discovery implementation`)
    }

    isSwapLog(log, address) {
        if (!log || !address || !log.address || String(log.address).toLowerCase() !== String(address).toLowerCase()) return false
        const eventName = log.event || log.name
        if (eventName === 'Swap') return true
        return Boolean(this.swapTopic && log.topics && log.topics[0] &&
            String(log.topics[0]).toLowerCase() === String(this.swapTopic).toLowerCase())
    }
}

class AerodromeAdapter extends PoolAdapter {
    constructor(options = {}) {
        super(options)
        this.name = 'aerodrome'
        this.setSwapSignature(V2_SWAP_SIGNATURE, options.swapTopic)
    }

    async discoverPool(descriptor) {
        if (!this.factoryAddress) throw new Error('Aerodrome factoryAddress is required for pool discovery')
        requireAddress(descriptor.token0, 'token0')
        requireAddress(descriptor.token1, 'token1')
        if (descriptor.stable === undefined) throw new Error('Aerodrome pool discovery requires stable')
        const methods = descriptor.factoryMethod ? [descriptor.factoryMethod] : ['getPool', 'getPair']
        for (const method of methods) {
            try {
                const args = method === 'getPool'
                    ? [descriptor.token0, descriptor.token1, Boolean(descriptor.stable)]
                    : [descriptor.token0, descriptor.token1]
                const address = await read(this.provider, this.factoryAddress, V2_FACTORY_ABI, method, args)
                if (isAddress(address) && !/^0x0{40}$/i.test(address)) return address
            } catch (error) {
                if (descriptor.factoryMethod) throw error
            }
        }
        throw new Error(`Aerodrome pool was not found for ${descriptor.token0}/${descriptor.token1}`)
    }

    async readPoolState(descriptor) {
        const address = requireAddress(descriptor.address, 'pool address')
        const [token0, token1, reserves] = await Promise.all([
            read(this.provider, address, V2_POOL_ABI, 'token0'),
            read(this.provider, address, V2_POOL_ABI, 'token1'),
            read(this.provider, address, V2_POOL_ABI, 'getReserves')
        ])
        const [token0Metadata, token1Metadata] = await Promise.all([
            readMetadata(this.provider, token0),
            readMetadata(this.provider, token1)
        ])
        const state = {
            address,
            adapter: this.name,
            quoteModel: 'constant-product',
            token0,
            token1,
            reserve0: reserves[0],
            reserve1: reserves[1],
            token0Decimals: token0Metadata.decimals,
            token1Decimals: token1Metadata.decimals,
            token0Symbol: token0Metadata.symbol,
            token1Symbol: token1Metadata.symbol,
            stable: descriptor.stable,
            source: descriptor.source || 'canonical'
        }
        if (descriptor.feeBps !== undefined) state.feeBps = Number(descriptor.feeBps)
        return state
    }
}

class V3Adapter extends PoolAdapter {
    constructor(options = {}) {
        super(options)
        this.name = options.name
        this.setSwapSignature(V3_SWAP_SIGNATURE, options.swapTopic)
    }

    async discoverPool(descriptor) {
        if (!this.factoryAddress) throw new Error(`${this.name} factoryAddress is required for pool discovery`)
        requireAddress(descriptor.token0, 'token0')
        requireAddress(descriptor.token1, 'token1')
        if (descriptor.fee === undefined) throw new Error(`${this.name} pool discovery requires fee`)
        const address = await read(this.provider, this.factoryAddress, V3_FACTORY_ABI, 'getPool', [
            descriptor.token0, descriptor.token1, descriptor.fee
        ])
        if (!isAddress(address) || /^0x0{40}$/i.test(address)) {
            throw new Error(`${this.name} pool was not found for ${descriptor.token0}/${descriptor.token1}/${descriptor.fee}`)
        }
        return address
    }

    async readPoolState(descriptor) {
        const address = requireAddress(descriptor.address, 'pool address')
        const [token0, token1, fee, liquidity, slot0] = await Promise.all([
            read(this.provider, address, V3_POOL_ABI, 'token0'),
            read(this.provider, address, V3_POOL_ABI, 'token1'),
            read(this.provider, address, V3_POOL_ABI, 'fee'),
            read(this.provider, address, V3_POOL_ABI, 'liquidity'),
            read(this.provider, address, V3_POOL_ABI, 'slot0')
        ])
        const [token0Metadata, token1Metadata] = await Promise.all([
            readMetadata(this.provider, token0),
            readMetadata(this.provider, token1)
        ])
        return {
            address,
            adapter: this.name,
            quoteModel: 'concentrated-liquidity',
            token0,
            token1,
            feeBps: descriptor.feeBps !== undefined ? Number(descriptor.feeBps) : Number(fee) / 100,
            liquidity,
            sqrtPriceX96: slot0[0],
            tick: Number(slot0[1]),
            token0Decimals: token0Metadata.decimals,
            token1Decimals: token1Metadata.decimals,
            token0Symbol: token0Metadata.symbol,
            token1Symbol: token1Metadata.symbol,
            source: descriptor.source || 'canonical'
        }
    }
}

class UniswapV3Adapter extends V3Adapter {
    constructor(options = {}) {
        super(Object.assign({}, options, { name: 'uniswap-v3' }))
    }
}

class PancakeSwapV3Adapter extends V3Adapter {
    constructor(options = {}) {
        super(Object.assign({}, options, { name: 'pancakeswap-v3' }))
    }
}

module.exports = {
    AerodromeAdapter,
    UniswapV3Adapter,
    PancakeSwapV3Adapter,
    isAddress,
    requireAddress
}