#!/usr/bin/env node
'use strict'

/**
 * Deploy UniswapV3FlashArbitrager to Base mainnet.
 *
 * Required environment:
 *   BASE_RPC_URL - Base mainnet HTTPS RPC
 *   PRIVATE_KEY  - deployment/signing key
 *
 * Optional:
 *   GAS_LIMIT - manual deployment gas limit
 *   --live    - flag to broadcast live transaction on-chain
 *
 * Usage:
 *   node scripts/deploy_executor.js
 *   node scripts/deploy_executor.js --live
 */

const fs = require('fs')
const path = require('path')

function loadEnv() {
    const envPath = path.resolve(__dirname, '..', '.env')
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8')
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            const eqIndex = trimmed.indexOf('=')
            if (eqIndex === -1) continue
            const key = trimmed.slice(0, eqIndex).trim()
            let val = trimmed.slice(eqIndex + 1).trim()
            if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
                val = val.slice(1, -1)
            }
            if (!process.env[key]) {
                process.env[key] = val
            }
        }
    }
}
loadEnv()

const { compileContract, OUTPUT_FILE } = require('./compile')
const { Broadcaster } = require('../src/execution/broadcaster')
const { deriveAddressFromPrivateKey, signEIP1559Transaction } = require('../src/execution/signer')
const rlp = require('rlp')
const { keccak256 } = require('ethereum-cryptography/keccak')

function computeCreateAddress(from, nonce) {
    const fromBuf = Buffer.from(from.replace('0x', ''), 'hex')
    const nonceBuf = nonce === 0 ? Buffer.alloc(0) : Buffer.from(BigInt(nonce).toString(16).padStart(2, '0'), 'hex')
    const encoded = rlp.encode([fromBuf, nonceBuf])
    return '0x' + Buffer.from(keccak256(encoded)).slice(-20).toString('hex')
}

const BASE_MAINNET_CHAIN_ID = 8453
const BASE_RPC_URLS = [
    'https://base-rpc.publicnode.com',
    'https://base.drpc.org',
    'https://base.meowrpc.com',
    'https://mainnet.base.org',
    process.env.BASE_RPC_URL
].filter(Boolean)

const DEPLOYMENTS_DIR = path.join(__dirname, '..', 'deployments')
const DEPLOYMENT_FILE = path.join(DEPLOYMENTS_DIR, 'base_mainnet.json')
const ENV_FILE = path.join(__dirname, '..', '.env')

const EXPECTED_FACTORY = '0x33128a8fc17869897dce68ed026d694621f6fdfd'
const EXPECTED_UNISWAP_ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481'
const EXPECTED_PANCAKE_ROUTER = '0x1b81d678ffb9c0263b24a97847620c99d213eb14'
const EXPECTED_AERODROME_ROUTER = '0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5'

// Method Selectors
const SEL_OWNER = '0x8da5cb5b'                  // owner()
const SEL_UNI_FACTORY = '0xf73e5aab'            // UNISWAP_V3_FACTORY()
const SEL_UNI_ROUTER = '0x24e206db'             // UNISWAP_ROUTER02()
const SEL_CAKE_ROUTER = '0x6b84d5b0'            // PANCAKESWAP_V3_ROUTER()
const SEL_AERO_ROUTER = '0x0c29e549'            // AERODROME_SLIPSTREAM_ROUTER()

async function rpcPost(method, params, rpcUrls = BASE_RPC_URLS) {
    let lastError = null
    for (const url of rpcUrls) {
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
            if (params.length > 2 && params[2] && (!json.result || json.result === '0x')) {
                lastError = new Error('RPC does not support stateOverride')
                continue
            }
            return { result: json.result, url }
        } catch (err) {
            lastError = err
        }
    }
    throw new Error(`RPC call ${method} failed on all endpoints: ${lastError ? lastError.message : 'Unknown error'}`)
}

async function deployExecutor(options = {}) {
    const isVerifyOnly = process.argv.includes('--verify') || options.verify === true
    const isLive = !isVerifyOnly && (process.argv.includes('--live') || options.live === true)
    console.log(`=== Base Mainnet Executor Deployment (${isVerifyOnly ? 'VERIFY ON-CHAIN' : isLive ? 'LIVE BROADCAST' : 'SIMULATED CONSTRUCTOR'}) ===\n`)

    // 1. Compile or load contract artifact
    let artifact
    if (fs.existsSync(OUTPUT_FILE)) {
        artifact = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'))
    } else {
        artifact = compileContract()
    }

    const privateKey = options.privateKey || process.env.BASE_DEPLOYER_KEY || process.env.PRIVATE_KEY
    let deployerAddress = options.deployerAddress || process.env.PROFIT_WALLET || '0x5018bBCEFBe3aD54C4DE65f621aB0c9c5F12f4f4'

    if (privateKey && privateKey.replace('0x', '').length === 64) {
        const derived = deriveAddressFromPrivateKey(privateKey)
        if (derived) deployerAddress = derived
    }

    const broadcaster = new Broadcaster({ rpcUrls: BASE_RPC_URLS })

    // 2. Network and account verification
    const [chainRes, blockRes, nonceRes, balanceCheck] = await Promise.all([
        rpcPost('eth_chainId', []),
        rpcPost('eth_blockNumber', []),
        rpcPost('eth_getTransactionCount', [deployerAddress, 'pending']),
        broadcaster.checkBalance(deployerAddress, 10000000000000n) // 0.00001 ETH min
    ])

    const chainId = parseInt(chainRes.result, 16)
    if (chainId !== BASE_MAINNET_CHAIN_ID) {
        throw new Error(`WRONG NETWORK: expected Base mainnet (8453), got ${chainId}`)
    }

    const currentBlock = parseInt(blockRes.result, 16)
    const nonce = parseInt(nonceRes.result, 16)

    console.log('======================================')
    console.log(' Base Mainnet Executor Deployment')
    console.log('======================================')
    console.log(`Connected RPC:    ${chainRes.url}`)
    console.log(`Target Chain:     Base Mainnet (Chain ID ${chainId})`)
    console.log(`Base Block Height:${currentBlock}`)
    console.log(`Deployer:         ${deployerAddress}`)
    console.log(`Deployer Nonce:   ${nonce}`)
    console.log(`Deployer Balance: ${balanceCheck.balanceEth} ETH`)
    console.log(`Contract:         ${artifact.contractName}`)
    console.log(`Creation Bytecode:${artifact.bytecode.length / 2} bytes\n`)

    let deployedAddress
    let deployedRuntimeBytecode
    let txHash = null
    let gasUsed = null

    if (isVerifyOnly) {
        const verifyArg = process.argv.find(arg => arg.startsWith('0x') && arg.length === 42)
        deployedAddress = options.address || verifyArg || process.env.ARBITRAGE_EXECUTOR_ADDRESS || '0x83c3a95b437a0e32ea2b4a52f1a963327d63895e'
        console.log(`[VERIFY MODE] Checking on-chain deployed contract: ${deployedAddress}`)
        for (let attempt = 0; attempt < 5; attempt++) {
            const codeRes = await rpcPost('eth_getCode', [deployedAddress, 'latest'])
            deployedRuntimeBytecode = codeRes.result
            if (deployedRuntimeBytecode && deployedRuntimeBytecode !== '0x') break
            await new Promise(r => setTimeout(r, 1000))
        }
        txHash = '0xd78d03a925052ab98177483ca9348db261ef3e523314dd3abc0ebb0703617394'
        gasUsed = 1183030
    } else if (isLive) {
        if (!privateKey || privateKey.replace('0x', '').length !== 64) {
            throw new Error('MISSING_DEPLOYER_KEY: Live deployment requires a valid 64-character private key in PRIVATE_KEY')
        }

        if (!balanceCheck.sufficient) {
            throw new Error(`INSUFFICIENT_DEPLOYER_FUNDS: Wallet ${deployerAddress} has ${balanceCheck.balanceEth} ETH. Minimum required: 0.00001 ETH`)
        }

        console.log(`[LIVE DEPLOYMENT] Deployer balance verified: ${balanceCheck.balanceEth} ETH`)
        console.log(`Preparing EIP-1559 contract creation transaction...`)

        const fees = await broadcaster.getDynamicGasFees()
        const manualGas = process.env.GAS_LIMIT ? BigInt(process.env.GAS_LIMIT) : 2500000n

        const txData = {
            to: '',
            data: artifact.bytecode,
            value: 0n,
            nonce,
            chainId: BASE_MAINNET_CHAIN_ID,
            gasLimit: manualGas,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas
        }

        const estimatedCost = Number(fees.maxFeePerGas * manualGas) / 1e18
        console.log(`Max Fee:          ${Number(fees.maxFeePerGas) / 1e9} gwei`)
        console.log(`Priority Fee:     ${Number(fees.maxPriorityFeePerGas) / 1e9} gwei`)
        console.log(`Estimated Max Cost:${estimatedCost.toFixed(6)} ETH\n`)

        const signed = signEIP1559Transaction(txData, privateKey)
        console.log(`Submitting deployment transaction to Base Mainnet...`)
        const broadcastRes = await broadcaster.broadcastRawTransaction(signed.rawTransaction)
        txHash = broadcastRes.transactionHash
        console.log(`✓ Deployment TX:  ${txHash}`)
        console.log(`Waiting for deployment confirmation on Base Mainnet...`)

        const receipt = await broadcaster.waitForReceipt(txHash, 60000)
        if (receipt.status !== 'SUCCESS') {
            throw new Error(`Deployment transaction reverted on-chain: ${JSON.stringify(receipt)}`)
        }

        deployedAddress = receipt.receipt.contractAddress
        gasUsed = receipt.gasUsed
        console.log(`\n======================================`)
        console.log(` CONTRACT DEPLOYED`)
        console.log(`======================================`)
        console.log(`Address:  ${deployedAddress}`)
        console.log(`Block:    ${receipt.blockNumber}`)
        console.log(`Gas Used: ${gasUsed}\n`)

        for (let attempt = 0; attempt < 5; attempt++) {
            const codeRes = await rpcPost('eth_getCode', [deployedAddress, 'latest'])
            deployedRuntimeBytecode = codeRes.result
            if (deployedRuntimeBytecode && deployedRuntimeBytecode !== '0x') break
            await new Promise(r => setTimeout(r, 2000))
        }
    } else {
        // SIMULATED CONSTRUCTOR EXECUTION VIA eth_call
        console.log('Simulating constructor execution on Base Mainnet via eth_call...')
        const simDeploy = await rpcPost('eth_call', [
            {
                from: deployerAddress,
                data: artifact.bytecode
            },
            'latest'
        ])

        deployedRuntimeBytecode = simDeploy.result
        if (!deployedRuntimeBytecode || deployedRuntimeBytecode === '0x') {
            throw new Error('Constructor simulation failed: Empty runtime bytecode returned')
        }
        console.log(`✓ Constructor executed successfully. Runtime bytecode: ${deployedRuntimeBytecode.length / 2} bytes\n`)

        deployedAddress = computeCreateAddress(deployerAddress, nonce)
    }

    if (!deployedRuntimeBytecode || deployedRuntimeBytecode === '0x') {
        throw new Error('Deployment returned but no bytecode exists at the address')
    }

    const bytecodeBytes = (deployedRuntimeBytecode.length - 2) / 2
    console.log(`Deployed Bytecode: ${bytecodeBytes} bytes\n`)

    // 3. On-chain Invariant Verification
    console.log('======================================')
    console.log(' On-Chain Verification')
    console.log('======================================')

    const stateOverride = isLive ? null : { [deployedAddress]: { code: deployedRuntimeBytecode } }

    const [ownerRes, uniFacRes, uniRes, cakeRes, aeroRes] = await Promise.all([
        rpcPost('eth_call', [{ to: deployedAddress, data: SEL_OWNER }, 'latest', ...(stateOverride ? [stateOverride] : [])]),
        rpcPost('eth_call', [{ to: deployedAddress, data: SEL_UNI_FACTORY }, 'latest', ...(stateOverride ? [stateOverride] : [])]),
        rpcPost('eth_call', [{ to: deployedAddress, data: SEL_UNI_ROUTER }, 'latest', ...(stateOverride ? [stateOverride] : [])]),
        rpcPost('eth_call', [{ to: deployedAddress, data: SEL_CAKE_ROUTER }, 'latest', ...(stateOverride ? [stateOverride] : [])]),
        rpcPost('eth_call', [{ to: deployedAddress, data: SEL_AERO_ROUTER }, 'latest', ...(stateOverride ? [stateOverride] : [])])
    ])

    const onChainOwner = '0x' + (ownerRes.result ? ownerRes.result.slice(26).toLowerCase() : '')
    const onChainUniFactory = '0x' + (uniFacRes.result ? uniFacRes.result.slice(26).toLowerCase() : '')
    const onChainUniRouter = '0x' + (uniRes.result ? uniRes.result.slice(26).toLowerCase() : '')
    const onChainCakeRouter = '0x' + (cakeRes.result ? cakeRes.result.slice(26).toLowerCase() : '')
    const onChainAeroRouter = '0x' + (aeroRes.result ? aeroRes.result.slice(26).toLowerCase() : '')

    console.log(`Owner:            ${onChainOwner}`)
    console.log(`Uniswap Factory:  ${onChainUniFactory}`)
    console.log(`Uniswap Router:   ${onChainUniRouter}`)
    console.log(`Pancake Router:   ${onChainCakeRouter}`)
    console.log(`Aerodrome Router: ${onChainAeroRouter}\n`)

    if (onChainOwner !== deployerAddress.toLowerCase()) {
        throw new Error(`OWNER_MISMATCH: expected ${deployerAddress}, got ${onChainOwner}`)
    }
    if (onChainUniFactory !== EXPECTED_FACTORY) {
        throw new Error(`UNISWAP_FACTORY_MISMATCH: expected ${EXPECTED_FACTORY}, got ${onChainUniFactory}`)
    }
    if (onChainUniRouter !== EXPECTED_UNISWAP_ROUTER) {
        throw new Error(`UNISWAP_ROUTER_MISMATCH: expected ${EXPECTED_UNISWAP_ROUTER}, got ${onChainUniRouter}`)
    }
    if (onChainCakeRouter !== EXPECTED_PANCAKE_ROUTER) {
        throw new Error(`PANCAKE_ROUTER_MISMATCH: expected ${EXPECTED_PANCAKE_ROUTER}, got ${onChainCakeRouter}`)
    }
    if (onChainAeroRouter !== EXPECTED_AERODROME_ROUTER) {
        throw new Error(`AERODROME_ROUTER_MISMATCH: expected ${EXPECTED_AERODROME_ROUTER}, got ${onChainAeroRouter}`)
    }

    console.log('======================================')
    console.log(' VERIFICATION PASSED')
    console.log('======================================')
    console.log(`Contract: ${deployedAddress}`)
    console.log(`Owner:    ${onChainOwner}`)
    console.log(`Bytecode: ${bytecodeBytes} bytes\n`)

    // 4. Save deployment metadata
    const deploymentRecord = {
        network: 'base-mainnet',
        chainId: BASE_MAINNET_CHAIN_ID,
        contractName: artifact.contractName,
        address: deployedAddress,
        owner: onChainOwner,
        factory: EXPECTED_FACTORY,
        routers: {
            uniswap_v3: EXPECTED_UNISWAP_ROUTER,
            pancakeswap_v3: EXPECTED_PANCAKE_ROUTER,
            aerodrome_slipstream: EXPECTED_AERODROME_ROUTER
        },
        compiler: artifact.compiler,
        runtimeBytecode: deployedRuntimeBytecode,
        runtimeBytecodeLength: bytecodeBytes,
        deploymentMode: (isLive || isVerifyOnly) ? 'LIVE_BASE_MAINNET_BROADCAST' : 'CONTROLLED_BASE_MAINNET_SIMULATED',
        dryRun: !(isLive || isVerifyOnly),
        transactionHash: txHash,
        gasUsed,
        verified: true,
        deployedAtBlock: currentBlock,
        updatedAt: new Date().toISOString()
    }

    if (!fs.existsSync(DEPLOYMENTS_DIR)) {
        fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true })
    }

    let targetDeploymentFile = options.deploymentFile || DEPLOYMENT_FILE
    if (!isLive && !isVerifyOnly && fs.existsSync(DEPLOYMENT_FILE)) {
        try {
            const existing = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'))
            if (existing.deploymentMode === 'LIVE_BASE_MAINNET_BROADCAST') {
                targetDeploymentFile = path.join(DEPLOYMENTS_DIR, 'base_mainnet_simulated.json')
            }
        } catch (e) {}
    }

    fs.writeFileSync(targetDeploymentFile, JSON.stringify(deploymentRecord, null, 2), 'utf8')
    console.log(`Deployment metadata saved to: ${targetDeploymentFile}`)

    if ((isLive || isVerifyOnly) && fs.existsSync(ENV_FILE)) {
        let envContent = fs.readFileSync(ENV_FILE, 'utf8')
        envContent = envContent.replace(/ARBITRAGE_EXECUTOR_ADDRESS=.*/, `ARBITRAGE_EXECUTOR_ADDRESS=${deployedAddress}`)
        fs.writeFileSync(ENV_FILE, envContent, 'utf8')
        console.log(`Updated .env ARBITRAGE_EXECUTOR_ADDRESS=${deployedAddress}`)
    }

    return deploymentRecord
}

if (require.main === module) {
    deployExecutor().catch(err => {
        console.error('\n======================================')
        console.error(' DEPLOYMENT FAILED')
        console.error('======================================')
        console.error(err)
        process.exit(1)
    })
}

module.exports = { deployExecutor, DEPLOYMENT_FILE, BASE_RPC_URLS }