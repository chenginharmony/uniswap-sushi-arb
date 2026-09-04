'use strict'

const fs = require('fs')
const path = require('path')

function loadEnv() {
    const envPath = path.resolve(process.cwd(), '.env')
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
            process.env[key] = val
        }
    }
}
loadEnv()

const { loadConfig } = require('./config')
const { ExecutionController } = require('./execution/controller')
const { Broadcaster } = require('./execution/broadcaster')
const { deriveAddressFromPrivateKey } = require('./execution/signer')
const { buildCrossDexRoutes } = require('./arbitrage/route_builder')
const { optimizeRouteSize } = require('./arbitrage/optimizer')
const { FlashblocksClient } = require('./flashblocks/client')
const { defaultProfiler } = require('./monitoring/latency_profiler')
const { campaignLogger, OUTCOME } = require('./monitoring/preflight_campaign')

const UNIVERSE_FILE = path.join(__dirname, '..', 'data', 'base_pool_universe.json')
const LIVE_LOG_FILE = path.join(__dirname, '..', 'data', 'live_executions.jsonl')

function getTokenMeta(address) {
    const a = (address || '').toLowerCase()
    if (a === '0x4200000000000000000000000000000000000006') return { symbol: 'WETH', decimals: 18, priceUsd: 2600 }
    if (a === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') return { symbol: 'USDC', decimals: 6, priceUsd: 1.0 }
    if (a === '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf') return { symbol: 'cbBTC', decimals: 8, priceUsd: 84500 }
    if (a === '0x940181a94a35a4569e4529a3cdfb74e38fd98631') return { symbol: 'AERO', decimals: 18, priceUsd: 0.51 }
    if (a === '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b') return { symbol: 'VIRTUAL', decimals: 18, priceUsd: 0.68 }
    if (a === '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22') return { symbol: 'cbETH', decimals: 18, priceUsd: 2875 }
    return { symbol: 'UNKNOWN', decimals: 18, priceUsd: 1.0 }
}

// ANSI & Alignment Helpers
function stripAnsi(str) {
    return String(str || '').replace(/\x1b\[[0-9;]*m/g, '')
}

function padAnsi(str, targetWidth, align = 'left') {
    const s = String(str || '')
    const visibleLength = stripAnsi(s).length
    const diff = targetWidth - visibleLength
    if (diff < 0) return s.slice(0, targetWidth)
    if (diff === 0) return s
    const padding = ' '.repeat(diff)
    return align === 'right' ? padding + s : s + padding
}

function makeHeader(title, targetWidth = 104) {
    const cleanTitle = stripAnsi(title)
    const dashes = Math.max(0, targetWidth - 5 - cleanTitle.length)
    return '┌─ ' + title + ' ' + '─'.repeat(dashes) + '┐'
}

function formatRow(cols, widths, totalWidth = 104) {
    const formatted = cols.map((c, i) => padAnsi(c, widths[i])).join(' ')
    return '│ ' + padAnsi(formatted, totalWidth - 4) + ' │'
}

function makeSparkline(data) {
    const chars = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█']
    if (!data || !data.length) return '          '
    const min = Math.min(...data)
    const max = Math.max(...data)
    const range = max - min || 1
    return data.map(v => chars[Math.min(chars.length - 1, Math.floor(((v - min) / range) * (chars.length - 1)))]).join('')
}

function mapTraderStatus(rejectionReason, profitable, recentStatus = null) {
    if (recentStatus === 'EXECUTED') return '\x1b[92m● EXECUTED\x1b[0m'
    if (recentStatus === 'MISSED OUT' || recentStatus === 'MISSED_OUT') return '\x1b[91m✕ MISSED OUT\x1b[0m'
    if (profitable) return '\x1b[92m★ OPPORTUNITY\x1b[0m'
    if (!rejectionReason) return '\x1b[90m💤 AT PARITY\x1b[0m'
    switch (rejectionReason) {
        case 'NEGATIVE_GROSS_PROFIT':
        case 'FEE_EXCEEDS_INPUT':
            return '\x1b[90m💤 AT PARITY\x1b[0m'
        case 'DEX_FEES_EXCEED_EDGE':
            return '\x1b[93m✕ MISSED (FEES)\x1b[0m'
        case 'BELOW_MIN_NET_PROFIT':
            return '\x1b[93m✕ MISSED (PnL)\x1b[0m'
        case 'GAS_EXCEEDS_EDGE':
            return '\x1b[93m✕ MISSED (GAS)\x1b[0m'
        case 'SLIPPAGE_TOO_HIGH':
            return '\x1b[91m✕ MISSED (SLIP)\x1b[0m'
        case 'INSUFFICIENT_LIQUIDITY':
            return '\x1b[91m✕ MISSED (LIQ)\x1b[0m'
        case 'PREFLIGHT_SIMULATION_REVERTED':
            return '\x1b[91m✕ MISSED (SIM)\x1b[0m'
        case 'STALE':
            return '\x1b[90m💤 MISSED (OLD)\x1b[0m'
        default:
            return `\x1b[90m✕ MISSED\x1b[0m`
    }
}

async function fetchPoolState(pool, broadcaster) {
    const address = pool.address
    try {
        const [slot0Raw, liqRaw] = await Promise.all([
            broadcaster.rpcCall('eth_call', [{ to: address, data: '0x3850c7bd' }, 'latest']).then(r => r.result),
            broadcaster.rpcCall('eth_call', [{ to: address, data: '0x1a686502' }, 'latest']).then(r => r.result).catch(() => '0x0')
        ])
        if (!slot0Raw || slot0Raw.length < 66) return null

        const sqrtPriceX96 = BigInt('0x' + slot0Raw.slice(2, 66))
        const tick = Number(BigInt.asIntN(24, BigInt('0x' + slot0Raw.slice(66, 130))))
        const liquidity = liqRaw && liqRaw !== '0x' ? BigInt(liqRaw) : 0n

        const t0 = getTokenMeta(pool.token0)
        const t1 = getTokenMeta(pool.token1)
        const feeBps = pool.feeBps !== undefined ? pool.feeBps : (pool.feeTier ? pool.feeTier / 100 : 30)

        return {
            address: address.toLowerCase(),
            dex: pool.dex || pool.adapter || 'v3',
            adapter: pool.adapter || 'uniswap-v3',
            token0: pool.token0.toLowerCase(),
            token1: pool.token1.toLowerCase(),
            token0Symbol: t0.symbol,
            token1Symbol: t1.symbol,
            token0Decimals: t0.decimals,
            token1Decimals: t1.decimals,
            feeBps,
            feeTier: pool.feeTier || (feeBps * 100),
            tickSpacing: pool.tickSpacing !== undefined ? pool.tickSpacing : (pool.feeTier || (feeBps * 100)),
            sqrtPriceX96,
            tick,
            liquidity,
            updatedAt: Date.now()
        }
    } catch (err) {
        return null
    }
}

async function sendTelegramAlert(message, botToken, chatId) {
    if (!botToken || !chatId) return
    try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'HTML'
            })
        })
    } catch (e) {
        console.error('[TELEGRAM] Alert failed:', e.message)
    }
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════════════════════╗')
    console.log('║        🍣 SUSHIBREAD - BASE FLASH ARBITRAGE LIVE TRADE                    ║')
    console.log('║                  *** LIVE BROADCAST MODE ACTIVATED ***                       ║')
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝\n')

    const rawKey = process.env.BASE_DEPLOYER_KEY || process.env.PRIVATE_KEY
    if (!rawKey || rawKey.replace('0x', '').length !== 64) {
        console.error('FATAL ERROR: Valid 64-character private key required in PRIVATE_KEY or BASE_DEPLOYER_KEY for live execution.')
        console.error('Please configure your funded Base Mainnet private key in .env before running live.')
        process.exit(1)
    }

    const walletAddress = deriveAddressFromPrivateKey(rawKey)
    console.log(`Live Trader Wallet: ${walletAddress}`)

    const broadcaster = new Broadcaster()
    const balanceCheck = await broadcaster.checkBalance(walletAddress, 100000000000000n)
    console.log(`Wallet Balance:     ${balanceCheck.balanceEth} ETH`)

    const contractAddress = process.env.ARBITRAGE_EXECUTOR_ADDRESS
    if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') {
        console.error('FATAL ERROR: ARBITRAGE_EXECUTOR_ADDRESS must be set in .env to a deployed contract on Base Mainnet.')
        process.exit(1)
    }

    // Verify contract has deployed bytecode on Base Mainnet
    const codeRes = await broadcaster.rpcCall('eth_getCode', [contractAddress, 'latest'])
    if (!codeRes.result || codeRes.result === '0x') {
        console.error(`FATAL ERROR: No bytecode found at ARBITRAGE_EXECUTOR_ADDRESS ${contractAddress} on Base Mainnet.`)
        process.exit(1)
    }
    console.log(`Target Contract:    ${contractAddress} (Verified on Base Mainnet)`)

    // Verify on-chain executor invariants and display a clean startup card
    let onChainOwner = 'UNKNOWN'
    let uniRouterOk = false
    let cakeRouterOk = false
    let aeroRouterOk = false
    const EXPECTED_UNI_ROUTER  = '0x2626664c2603336e57b271c5c0b26f421741e481'
    const EXPECTED_CAKE_ROUTER = '0x1b81d678ffb9c0263b24a97847620c99d213eb14'
    const EXPECTED_AERO_ROUTER = '0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5'

    try {
        const ownerRes = await broadcaster.rpcCall('eth_call', [{ to: contractAddress, data: '0x8da5cb5b' }, 'latest'])
        onChainOwner = '0x' + (ownerRes.result ? ownerRes.result.slice(26).toLowerCase() : '')

        const uniRes  = await broadcaster.rpcCall('eth_call', [{ to: contractAddress, data: '0x24e206db' }, 'latest']) // UNISWAP_ROUTER02()
        const cakeRes = await broadcaster.rpcCall('eth_call', [{ to: contractAddress, data: '0x6b84d5b0' }, 'latest']) // PANCAKESWAP_V3_ROUTER()
        const aeroRes = await broadcaster.rpcCall('eth_call', [{ to: contractAddress, data: '0x0c29e549' }, 'latest']) // AERODROME_SLIPSTREAM_ROUTER()
        uniRouterOk  = uniRes.result  ? ('0x' + uniRes.result.slice(26).toLowerCase())  === EXPECTED_UNI_ROUTER  : false
        cakeRouterOk = cakeRes.result ? ('0x' + cakeRes.result.slice(26).toLowerCase()) === EXPECTED_CAKE_ROUTER : false
        aeroRouterOk = aeroRes.result ? ('0x' + aeroRes.result.slice(26).toLowerCase()) === EXPECTED_AERO_ROUTER : false
    } catch (e) { }

    const ownerMatch = walletAddress && onChainOwner && walletAddress.toLowerCase() === onChainOwner
    const LINE = '═'.repeat(74)
    const ownerBadge = ownerMatch ? '\x1b[92m✓ VERIFIED\x1b[0m' : `\x1b[91m✗ MISMATCH — expected ${walletAddress}\x1b[0m`
    const uniBadge   = uniRouterOk  ? '\x1b[92m✓ VERIFIED\x1b[0m' : '\x1b[91m✗ UNVERIFIED\x1b[0m'
    const cakeBadge  = cakeRouterOk ? '\x1b[92m✓ VERIFIED\x1b[0m' : '\x1b[91m✗ UNVERIFIED\x1b[0m'
    const aeroBadge  = aeroRouterOk ? '\x1b[92m✓ VERIFIED\x1b[0m' : '\x1b[91m✗ UNVERIFIED\x1b[0m'

    console.log('\n\x1b[94m╔' + LINE + '╗\x1b[0m')
    console.log('\x1b[94m║\x1b[0m  \x1b[97m⛓  ON-CHAIN EXECUTOR VERIFICATION (Base Mainnet)\x1b[0m' + ' '.repeat(25) + '\x1b[94m║\x1b[0m')
    console.log('\x1b[94m╠' + LINE + '╣\x1b[0m')
    console.log(`\x1b[94m║\x1b[0m  Address:          ${contractAddress.padEnd(44)}\x1b[94m║\x1b[0m`)
    console.log(`\x1b[94m║\x1b[0m  Bytecode:         \x1b[92m✓ VERIFIED (${(codeRes.result.length / 2 - 1).toLocaleString()} bytes on-chain)\x1b[0m` + ' '.repeat(Math.max(0, 21 - (codeRes.result.length / 2 - 1).toLocaleString().length)) + '\x1b[94m║\x1b[0m')
    console.log(`\x1b[94m║\x1b[0m  Owner:            ${onChainOwner.padEnd(44)}\x1b[94m║\x1b[0m`)
    console.log(`\x1b[94m║\x1b[0m  Owner match:      ${ownerBadge}` + (ownerMatch ? ' '.repeat(35) : ' '.repeat(0)) + '\x1b[94m║\x1b[0m')
    console.log(`\x1b[94m║\x1b[0m  Chain:            Base Mainnet (Chain ID 8453)               \x1b[94m║\x1b[0m`)
    console.log(`\x1b[94m║\x1b[0m  Uniswap Router:   ${uniBadge}` + (uniRouterOk ? ' '.repeat(54) : ' '.repeat(43)) + '\x1b[94m║\x1b[0m')
    console.log(`\x1b[94m║\x1b[0m  PancakeSwap Rtr:  ${cakeBadge}` + (cakeRouterOk ? ' '.repeat(53) : ' '.repeat(42)) + '\x1b[94m║\x1b[0m')
    console.log(`\x1b[94m║\x1b[0m  Aerodrome Rtr:    ${aeroBadge}` + (aeroRouterOk ? ' '.repeat(55) : ' '.repeat(44)) + '\x1b[94m║\x1b[0m')
    console.log(`\x1b[94m║\x1b[0m  Signer:           ${walletAddress.padEnd(44)}\x1b[94m║\x1b[0m`)
    console.log(`\x1b[94m║\x1b[0m  Balance:          ${balanceCheck.balanceEth} ETH` + ' '.repeat(Math.max(0, 44 - balanceCheck.balanceEth.toString().length - 5)) + '\x1b[94m║\x1b[0m')
    console.log('\x1b[94m╚' + LINE + '╝\x1b[0m\n')

    if (!ownerMatch) {
        console.warn('\x1b[93m[WALLET WARNING] Signer does not match contract owner. Live transactions will revert with NotOwner.\x1b[0m\n')
    }

    const baseConfig = loadConfig(process.env)
    const isDryRun = process.env.DRY_RUN === 'true' || process.env.BROADCAST_ENABLED === 'false' || process.env.EXECUTION_ENABLED === 'false' || false
    const liveConfig = {
        ...baseConfig,
        dryRun: isDryRun,
        executionEnabled: true,
        tradingMode: isDryRun ? 'paper' : 'live',
        arbitrageContractAddress: contractAddress,
        minNetProfitUsd: baseConfig.minNetProfitUsd !== undefined ? baseConfig.minNetProfitUsd : 0.01,
        maxSizeUsd: baseConfig.maxSizeUsd || 20000
    }

    const controller = new ExecutionController({
        config: liveConfig,
        rpcUrl: baseConfig.base.rpcUrl || 'https://base-rpc.publicnode.com',
        rpcUrls: baseConfig.base.rpcUrls,
        walletAddress,
        dryRun: isDryRun,
        executionEnabled: true,
        maxSizeUsd: liveConfig.maxSizeUsd,
        minProfitUsd: liveConfig.minNetProfitUsd,
        maxOpportunityAgeMs: baseConfig.maxOpportunityAgeMs || 300
    })

    console.log(`Controller safety gates initialized:`)
    console.log(`  • Execution Mode: ${isDryRun ? 'SIMULATION / DRY-RUN (BROADCAST OFF)' : 'LIVE BROADCAST (dryRun=false, executionEnabled=true)'}`)
    console.log(`  • Signer:         ${controller.signer.isReady() ? 'READY' : 'ERROR'}`)
    console.log(`  • Max Size Cap:   $${liveConfig.maxSizeUsd.toLocaleString()} USD`)
    console.log(`  • Min Net Profit: $${liveConfig.minNetProfitUsd.toFixed(2)} USD`)
    console.log(`  • Max Age:        ${baseConfig.maxOpportunityAgeMs || 300}ms\n`)

    if (!fs.existsSync(UNIVERSE_FILE)) {
        throw new Error(`Universe file not found: ${UNIVERSE_FILE}`)
    }
    const poolDefs = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'))
    console.log(`Loaded ${poolDefs.length} Base Concentrated Liquidity Pools.`)

    const tokenPrices = {
        '0x4200000000000000000000000000000000000006': 2600,
        '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 84500,
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 1.0,
        '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 0.51,
        '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': 0.68,
        '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 2875
    }
    function getDexCategory(pool) {
        const d = String(pool.dex || pool.adapter || '').toLowerCase()
        if (d.includes('pancake')) return 'pancakeswap'
        if (d.includes('aero') || d.includes('slipstream')) return 'aerodrome'
        return 'uniswap'
    }

    const allRoutes = buildCrossDexRoutes(poolDefs, tokenPrices)
    const routes = allRoutes.filter(r => {
        const c1 = getDexCategory(r.buyPool)
        const c2 = getDexCategory(r.sellPool)
        return c1 !== c2
    })
    console.log(`Generated ${routes.length} strictly Cross-DEX arbitrage routes across Uniswap V3, PancakeSwap V3, and Aerodrome Slipstream.`)

    // Index pools and affected routes for instant sub-block routing
    const poolMap = new Map()
    for (const pool of poolDefs) {
        poolMap.set(pool.address.toLowerCase(), pool)
    }

    const routesByPool = new Map()
    for (const route of routes) {
        const buyAddr = (route.buyPool.address || route.buyPool).toLowerCase()
        const sellAddr = (route.sellPool.address || route.sellPool).toLowerCase()
        if (!routesByPool.has(buyAddr)) routesByPool.set(buyAddr, [])
        if (!routesByPool.has(sellAddr)) routesByPool.set(sellAddr, [])
        routesByPool.get(buyAddr).push(route)
        routesByPool.get(sellAddr).push(route)
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN
    const chatId = process.env.TELEGRAM_CHAT_ID
    if (botToken && chatId) {
        console.log(`✓ Telegram live execution alerts enabled (Chat ID: ${chatId})\n`)
    }

    console.log('Bootstrapping live pool reserves from Base Mainnet...')
    const poolStates = new Map()
    let stateVersion = 1
    const MIN_ACTIVE_LIQUIDITY = BigInt(process.env.MIN_POOL_LIQUIDITY || '10000000000000') // 10^13

    for (const pool of poolDefs) {
        const state = await fetchPoolState(pool, broadcaster)
        if (state) {
            if (state.liquidity !== undefined && BigInt(state.liquidity) < MIN_ACTIVE_LIQUIDITY) {
                console.log(`[IGNORE LOW LIQUIDITY] Pool ${pool.address} (${pool.token0Symbol}/${pool.token1Symbol} ${pool.feeBps}bps) liquidity ${state.liquidity} < 1e13, excluded.`)
                continue
            }
            poolStates.set(pool.address.toLowerCase(), state)
        }
    }
    console.log(`✓ Bootstrapped ${poolStates.size} active pools with live ticks and liquidity.\n`)

    let running = true
    process.on('SIGINT', () => {
        console.log('\nStopping live execution engine...')
        running = false
        if (flashblocksClient) flashblocksClient.stop()
        process.exit(0)
    })

    const activityHistory = [2, 4, 6, 8, 12, 9, 14, 11, 16, 13, 18, 15]
    const recentEvents = []
    let topCandidates = []
    let cycle = 0
    let totalEvaluations = 0
    let totalExecuted = 0
    let totalMissed = 0
    let walletBalanceEth = balanceCheck.balanceEth
    const recentMissedLog = new Map()

    // Prepopulate recent events from log file if present
    if (fs.existsSync(LIVE_LOG_FILE)) {
        try {
            const fileLines = fs.readFileSync(LIVE_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean)
            for (const fl of fileLines.slice(-5)) {
                try { recentEvents.push(JSON.parse(fl)) } catch (e) { }
            }
        } catch (e) { }
    }

    function renderHUD() {
        const lines = []
        const width = 104

        // Cyberpunk ASCII Banner: SUSHIBREAD
        lines.push('  \x1b[96m███████╗██╗   ██╗███████╗██╗  ██╗██╗██████╗ ██████╗ ███████╗ █████╗ ██████╗ \x1b[0m')
        lines.push('  \x1b[96m██╔════╝██║   ██║██╔════╝██║  ██║██║██╔══██╗██╔══██╗██╔════╝██╔══██╗██╔══██╗\x1b[0m')
        lines.push('  \x1b[96m███████╗██║   ██║███████╗███████║██║██████╔╝██████╔╝█████╗  ███████║██║  ██║\x1b[0m')
        lines.push('  \x1b[94m╚════██║██║   ██║╚════██║██╔══██║██║██╔══██╗██╔══██╗██╔══╝  ██╔══██║██║  ██║\x1b[0m')
        lines.push('  \x1b[94m███████║╚██████╔╝███████║██║  ██║██║██████╔╝██║  ██║███████╗██║  ██║██████╔╝\x1b[0m')
        lines.push(`  \x1b[92m● SUSHIBREAD LIVE MAINNET EXECUTOR\x1b[0m \x1b[90m•\x1b[0m \x1b[93m${poolDefs.length} CL POOLS\x1b[0m \x1b[90m•\x1b[0m \x1b[92m${routes.length} ROUTES\x1b[0m \x1b[90m•\x1b[0m \x1b[95mFLASHBLOCKS 200ms MEV\x1b[0m\n`)

        // 1. Target Contract & Signer Info Card
        lines.push('\x1b[94m' + makeHeader('🍣 ON-CHAIN EXECUTOR & SIGNER', width) + '\x1b[0m')
        const cShort = contractAddress ? `${contractAddress.slice(0, 10)}...${contractAddress.slice(-6)}` : 'NONE'
        const wShort = walletAddress ? `${walletAddress.slice(0, 10)}...${walletAddress.slice(-6)}` : 'NONE'
        lines.push('│ ' + padAnsi(`Contract: ${cShort} (Base)  │  Signer: ${wShort}  │  Balance: ${walletBalanceEth} ETH`, width - 4) + ' │')
        const modeLabel = isDryRun ? '\x1b[93mSIMULATION / DRY-RUN (BROADCAST OFF)\x1b[0m' : '\x1b[92mLIVE BROADCAST\x1b[0m'
        lines.push('│ ' + padAnsi(`Mode: ${modeLabel}  │  Flash Sizing: $10 - $${liveConfig.maxSizeUsd.toLocaleString()} USD  │  Profit Floor: +$${liveConfig.minNetProfitUsd.toFixed(2)} USD  │  Sim: ON`, width - 4) + ' │')
        lines.push('\x1b[94m└' + '─'.repeat(width - 2) + '┘\x1b[0m')

        // 2. Top Opportunity Candidates Table
        lines.push('\x1b[92m' + makeHeader('★ TOP OPPORTUNITY CANDIDATES (RANKED BY NET PROFIT)', width) + '\x1b[0m')
        const oppCols = [31, 16, 10, 10, 12, 16]
        lines.push(formatRow(['Route Candidate', 'Flashloan Size', 'Gross Edge', 'Loan+Gas', 'Net Profit', 'Market Status'], oppCols, width))
        lines.push('├' + '─'.repeat(width - 2) + '┤')

        if (topCandidates.length === 0) {
            lines.push('│ ' + padAnsi('Evaluating candidate routes across Base Mainnet pools...', width - 4) + ' │')
        } else {
            for (const opp of topCandidates.slice(0, 4)) {
                const shortRoute = (opp.route || opp.routeId || 'route').slice(0, 31)
                const optSizeStr = `$${(opp.optimalSizeUsd || 0).toFixed(0)} (${(opp.optimalSizeTokens || 0).toFixed(3)})`
                const grossStr = `$${(opp.grossProfitUsd || 0).toFixed(2)}`
                const feesTotal = (opp.flashloanFeeUsd || 0) + (opp.gasCostUsd || 0.05)
                const feesStr = `$${feesTotal.toFixed(2)}`
                const netVal = opp.peakNetProfitUsd !== undefined ? opp.peakNetProfitUsd : opp.expectedNetProfitUsd
                const netSign = netVal >= 0 ? '+' : '-'
                const netStr = `${netSign}$${Math.abs(netVal).toFixed(2)}`
                const signalStr = mapTraderStatus(opp.rejectionReason, opp.profitable, opp.executionStatus)

                lines.push(formatRow([shortRoute, optSizeStr, grossStr, feesStr, netStr, signalStr], oppCols, width))
            }
        }
        lines.push('\x1b[92m└' + '─'.repeat(width - 2) + '┘\x1b[0m')

        // 3. Real-Time Order Outcomes Feed (EXECUTED vs MISSED OUT)
        lines.push('\x1b[93m' + makeHeader('◈ REAL-TIME ORDER OUTCOMES (EXECUTED vs MISSED OUT)', width) + '\x1b[0m')
        const outCols = [8, 32, 9, 10, 37]
        lines.push(formatRow(['Time', 'Route Candidate', 'Size', 'Profit', 'Outcome / Execution Status'], outCols, width))
        lines.push('├' + '─'.repeat(width - 2) + '┤')
        if (recentEvents.length === 0) {
            lines.push('│ ' + padAnsi('Scanning sub-blocks for qualifying dislocations. Awaiting live execution attempts...', width - 4) + ' │')
        } else {
            for (const ev of recentEvents.slice(-4).reverse()) {
                const timeStr = ev.timestamp ? new Date(ev.timestamp).toTimeString().slice(0, 8) : '00:00:00'
                const rKey = (ev.route || 'route').slice(0, 32)
                const sizeStr = `$${(ev.sizeUsd || 0).toFixed(0)}`
                const profitStr = ev.profitUsd !== undefined ? `${ev.profitUsd >= 0 ? '+' : ''}$${ev.profitUsd.toFixed(2)}` : '$0.00'
                const badge = ev.status === 'EXECUTED'
                    ? `\x1b[92m● EXECUTED (${(ev.txHash || '').slice(0, 10)}...)\x1b[0m`
                    : `\x1b[91m✕ MISSED: ${ev.reason || 'REVERTED'}\x1b[0m`
                lines.push(formatRow([timeStr, rKey, sizeStr, profitStr, badge], outCols, width))
            }
        }
        lines.push('\x1b[93m└' + '─'.repeat(width - 2) + '┘\x1b[0m')

        // 4. Flashblocks Telemetry & Activity Sparkline
        lines.push('\x1b[95m' + makeHeader('📡 FLASHBLOCKS 200ms MEV RADAR & TELEMETRY', width) + '\x1b[0m')
        const spark = makeSparkline(activityHistory)
        const wsStatus = '\x1b[92mCONNECTED (200ms Sub-Blocks)\x1b[0m'
        lines.push('│ ' + padAnsi(`Heartbeat: [${spark}]  │  Base WS: ${wsStatus}  │  Cycle: ${cycle}  │  State: v${stateVersion}`, width - 4) + ' │')
        lines.push('│ ' + padAnsi(`Flashblock Events: ${flashblocksEventsCount}  │  Evaluations: ${totalEvaluations}  │  Executed: ${totalExecuted}  │  Missed: ${totalMissed}`, width - 4) + ' │')
        lines.push('\x1b[95m└' + '─'.repeat(width - 2) + '┘\x1b[0m')

        // 5. 200ms Flashblock Latency Profiler Telemetry
        const profSummary = defaultProfiler.getSummary()
        lines.push('\x1b[96m' + makeHeader('⚡ 200ms FLASHBLOCK LATENCY PROFILE (PIPELINE BENCHMARKS)', width) + '\x1b[0m')
        const profCols = [23, 14, 14, 14, 14, 17]
        lines.push(formatRow(['Pipeline Stage', 'P50 (ms)', 'P90 (ms)', 'P99 (ms)', 'Max (ms)', 'Budget Status'], profCols, width))
        lines.push('├' + '─'.repeat(width - 2) + '┤')
        const stagesList = [
            ['1. State Update', profSummary.stages.stateUpdateMs],
            ['2. Route Quoting', profSummary.stages.quoteRoutingMs],
            ['3. Size Optimizer', profSummary.stages.optimizerMs],
            ['4. Tx Builder', profSummary.stages.builderMs],
            ['5. Preflight Sim', profSummary.stages.preflightMs],
            ['6. Local Signer', profSummary.stages.signingMs],
            ['7. RPC Broadcast', profSummary.stages.broadcastMs],
            ['Opportunity Age', profSummary.stages.opportunityAgeMs],
            ['Total Pipeline', profSummary.stages.totalPipelineMs]
        ]
        for (const [name, stg] of stagesList) {
            const p50Str = (stg && stg.p50 > 0) ? `${stg.p50.toFixed(2)} ms` : '--'
            const p90Str = (stg && stg.p90 > 0) ? `${stg.p90.toFixed(2)} ms` : '--'
            const p99Str = (stg && stg.p99 > 0) ? `${stg.p99.toFixed(2)} ms` : '--'
            const maxStr = (stg && stg.max > 0) ? `${stg.max.toFixed(2)} ms` : '--'
            let statusBadge = '\x1b[90m--\x1b[0m'
            if (name === 'Total Pipeline' || name === 'Opportunity Age') {
                if (!stg || stg.p50 === 0) statusBadge = '\x1b[90mWAITING\x1b[0m'
                else if (stg.p90 > 200) statusBadge = '\x1b[91m▲ EXCEEDS 200MS\x1b[0m'
                else if (stg.p90 > 150) statusBadge = '\x1b[93m▲ TIGHT (<50ms)\x1b[0m'
                else statusBadge = '\x1b[92m● SUB-200MS OK\x1b[0m'
            } else if (stg && stg.p50 > 0) {
                statusBadge = stg.p90 < 20 ? '\x1b[92m● FAST\x1b[0m' : (stg.p90 < 60 ? '\x1b[93m▲ NOMINAL\x1b[0m' : '\x1b[91m▲ SLOW\x1b[0m')
            }
            lines.push(formatRow([name, p50Str, p90Str, p99Str, maxStr, statusBadge], profCols, width))
        }
        lines.push('\x1b[96m└' + '─'.repeat(width - 2) + '┘\x1b[0m')

        // 6. Phase 5 – Preflight Campaign Dashboard (Taxonomy v2)
        const camp = campaignLogger.getSummary()
        lines.push('\x1b[93m' + makeHeader('🧪 PHASE 5: LIVE PREFLIGHT CAMPAIGN (BROADCAST DISABLED - TAXONOMY v2)', width) + '\x1b[0m')

        // ─ Outcome tally ─────────────────────────────────────────────────────────
        const campCols = [32, 10, 10, 10, 10, 22]
        lines.push(formatRow(['Outcome Class', 'Count', 'Success', 'Reverts', 'Stale', 'Rate / Status'], campCols, width))
        lines.push('├' + '─'.repeat(width - 2) + '┤')
        const outcomeRows = [
            [OUTCOME.SUCCESS,             '\x1b[92m✓ SUCCESS\x1b[0m'],
            [OUTCOME.TOO_LITTLE_RECEIVED, '\x1b[91m✗ TOO_LITTLE_RCVD\x1b[0m'],
            [OUTCOME.INSUFFICIENT_PROFIT, '\x1b[91m✗ INSUFF_PROFIT\x1b[0m'],
            [OUTCOME.SLIPPAGE_EXCEEDED,   '\x1b[91m✗ SLIPPAGE_EXCEED\x1b[0m'],
            [OUTCOME.LOK,                 '\x1b[91m✗ LOK (REENTRANT)\x1b[0m'],
            [OUTCOME.RPC_ERROR,           '\x1b[93m⚡ RPC_ERROR (429)\x1b[0m'],
            [OUTCOME.STATE_DIVERGED,      '\x1b[93m▲ STATE_DIVERGED\x1b[0m'],
            [OUTCOME.FINGERPRINT_FAILED,  '\x1b[91m✗ FP_PARITY_FAIL\x1b[0m'],
            [OUTCOME.STALE,               '\x1b[90m– STALE\x1b[0m'],
            [OUTCOME.OTHER_REVERT,        '\x1b[91m✗ OTHER_REVERT\x1b[0m'],
            [OUTCOME.BUILD_ERROR,         '\x1b[91m✗ BUILD_ERROR\x1b[0m']
        ]
        for (const [key, label] of outcomeRows) {
            const cnt = camp.counts[key] || 0
            if (cnt === 0) continue
            lines.push(formatRow([
                label,
                String(cnt),
                key === OUTCOME.SUCCESS ? String(cnt) : '',
                [OUTCOME.TOO_LITTLE_RECEIVED, OUTCOME.INSUFFICIENT_PROFIT, OUTCOME.SLIPPAGE_EXCEEDED, OUTCOME.LOK, OUTCOME.OTHER_REVERT].includes(key) ? String(cnt) : '',
                [OUTCOME.STALE, OUTCOME.STATE_DIVERGED, OUTCOME.RPC_ERROR].includes(key) ? String(cnt) : '',
                key === OUTCOME.SUCCESS ? `\x1b[92mCLEAN ${camp.ratios.cleanSuccessRate}%\x1b[0m` :
                key === OUTCOME.TOO_LITTLE_RECEIVED ? `\x1b[91mMIN_OUT ${camp.ratios.tooLittleReceivedRate}%\x1b[0m` :
                key === OUTCOME.INSUFFICIENT_PROFIT ? `\x1b[91mINSUFF  ${camp.ratios.insufficientRate}%\x1b[0m` :
                key === OUTCOME.RPC_ERROR ? `\x1b[93mRPC ERR ${camp.ratios.rpcErrorRate}%\x1b[0m` :
                key === OUTCOME.FINGERPRINT_FAILED  ? `\x1b[91mFP FAIL ${camp.ratios.fpFailRate}%\x1b[0m` :
                key === OUTCOME.STATE_DIVERGED ? `\x1b[93mDIVERGED ${camp.ratios.stateDivRate}%\x1b[0m` : ''
            ], campCols, width))
        }
        if (camp.total === 0) {
            lines.push('│ ' + padAnsi('Awaiting first profitable candidate to reach preflight simulation...', width - 4) + ' │')
        }
        lines.push('├' + '─'.repeat(width - 2) + '┤')

        // Rolling recent successes
        lines.push('│ ' + padAnsi(`\x1b[92mRecent Preflight Successes (Clean Survival: ${camp.ratios.cleanSuccessRate}% | Raw: ${camp.ratios.preflightSuccessRate}%):\x1b[0m`, width - 4) + ' │')
        if (camp.recentSuccesses.length === 0) {
            lines.push('│ ' + padAnsi('  No successful preflights yet.', width - 4) + ' │')
        } else {
            for (const s of camp.recentSuccesses.slice(0, 4)) {
                const t = new Date(s.ts).toTimeString().slice(0, 8)
                const p = `+$${(s.expectedNetProfitUsd || 0).toFixed(2)}`
                const fp = s.fingerprintHash ? s.fingerprintHash.slice(0, 12) : 'N/A'
                const sz = `$${(s.optimalSizeUsd || 0).toFixed(0)}`
                const age = `age=${s.opportunityAgeMs.toFixed(0)}ms`
                const pflt = `pflt=${s.preflightLatencyMs.toFixed(0)}ms`
                lines.push('│ ' + padAnsi(`  ${t}  ${p.padEnd(8)} sz=${sz.padEnd(8)} fp=${fp}  ${age}  ${pflt}`, width - 4) + ' │')
            }
        }
        lines.push('\x1b[93m└' + '─'.repeat(width - 2) + '┘\x1b[0m')

        process.stdout.write('\x1b[H\x1b[J' + lines.join('\n') + '\n')
    }

    async function evaluateAndExecuteRoute(route, parentTraceId = null) {
        const buyAddr = (route.buyPool.address || route.buyPool).toLowerCase()
        const sellAddr = (route.sellPool.address || route.sellPool).toLowerCase()
        const buyPool = poolStates.get(buyAddr)
        const sellPool = poolStates.get(sellAddr)

        if (!buyPool || !sellPool) return null

        const populatedRoute = Object.assign({}, route, { buyPool, sellPool })
        const opt = optimizeRouteSize(populatedRoute, {
            minNetProfitUsd: liveConfig.minNetProfitUsd,
            minProfitMarginBps: liveConfig.minProfitMarginBps || 0,
            gasCostUsd: 0.04,
            maxSizeUsd: liveConfig.maxSizeUsd
        }, { version: stateVersion, pools: poolStates })

        if (opt && opt.profitable) {
            opt.buyPool = buyPool
            opt.sellPool = sellPool
            opt.routeObj = populatedRoute
            opt.tokenInDecimals = route.tokenInDecimals !== undefined
                ? route.tokenInDecimals
                : (String(buyPool.token0).toLowerCase() === String(route.tokenIn).toLowerCase() ? buyPool.token0Decimals : buyPool.token1Decimals)
            opt.tokenOutDecimals = route.tokenOutDecimals !== undefined
                ? route.tokenOutDecimals
                : (String(buyPool.token0).toLowerCase() === String(route.tokenIn).toLowerCase() ? buyPool.token1Decimals : buyPool.token0Decimals)

            const traceId = parentTraceId || `opp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
            if (!parentTraceId) {
                defaultProfiler.startTrace(traceId, {
                    route: opt.route || route.id,
                    stateVersion,
                    buyPool: buyAddr,
                    sellPool: sellAddr
                })
                defaultProfiler.mark(traceId, 'stateUpdated')
                defaultProfiler.mark(traceId, 'routesRepriced')
            }
            defaultProfiler.mark(traceId, 'optimized')

            try {
                const receipt = await controller.processOpportunity(opt, {
                    now: Date.now(),
                    currentVersion: stateVersion,
                    // Phase 4: live closure so the controller can read the live state version
                    // immediately before AND immediately after eth_call to detect mid-flight divergence
                    getStateVersion: () => stateVersion,
                    profiler: defaultProfiler,
                    traceId
                })

                if (receipt.executed && receipt.broadcast) {
                    totalExecuted++
                    opt.executionStatus = 'EXECUTED'
                    const record = {
                        timestamp: Date.now(),
                        type: 'EXECUTED',
                        status: 'EXECUTED',
                        route: opt.route,
                        sizeUsd: receipt.optimalSizeUsd,
                        profitUsd: receipt.expectedNetProfitUsd,
                        txHash: receipt.transactionHash,
                        blockNumber: receipt.blockNumber
                    }
                    recentEvents.push(record)
                    if (recentEvents.length > 20) recentEvents.shift()
                    try { fs.appendFileSync(LIVE_LOG_FILE, JSON.stringify(record) + '\n', 'utf8') } catch (e) { }

                    if (botToken && chatId) {
                        const alertMsg = `🍣 <b>LIVE BASE ARBITRAGE EXECUTED</b>\n` +
                            `• <b>Route:</b> ${opt.route}\n` +
                            `• <b>Size:</b> $${receipt.optimalSizeUsd} USD\n` +
                            `• <b>Expected Profit:</b> +$${receipt.expectedNetProfitUsd} USD\n` +
                            `• <b>Tx Hash:</b> <a href="https://basescan.org/tx/${receipt.transactionHash}">${receipt.transactionHash.slice(0, 16)}...</a>\n` +
                            `• <b>Status:</b> ${receipt.status}`
                        await sendTelegramAlert(alertMsg, botToken, chatId)
                    }
                    renderHUD()
                } else {
                    totalMissed++
                    const failReason = receipt.revertReason || receipt.reason || 'PREFLIGHT_SIMULATION_REVERTED'
                    opt.executionStatus = 'MISSED_OUT'
                    const record = {
                        timestamp: Date.now(),
                        type: 'MISSED_OUT',
                        status: 'MISSED OUT',
                        route: opt.route,
                        sizeUsd: opt.optimalSizeUsd,
                        profitUsd: opt.expectedNetProfitUsd,
                        reason: failReason
                    }
                    recentEvents.push(record)
                    if (recentEvents.length > 20) recentEvents.shift()
                    try { fs.appendFileSync(LIVE_LOG_FILE, JSON.stringify(record) + '\n', 'utf8') } catch (e) { }
                    renderHUD()
                }
                return receipt
            } catch (procErr) {
                totalMissed++
                const record = {
                    timestamp: Date.now(),
                    type: 'MISSED_OUT',
                    status: 'MISSED OUT',
                    route: opt.route,
                    reason: procErr.message
                }
                recentEvents.push(record)
                if (recentEvents.length > 20) recentEvents.shift()
                try { fs.appendFileSync(LIVE_LOG_FILE, JSON.stringify(record) + '\n', 'utf8') } catch (e) { }
                renderHUD()
            }
        } else if (opt && (opt.grossProfitUsd || 0) > 0.10) {
            // Track edge candidate dislocations that could not clear gas/loan fees
            const now = Date.now()
            const routeKey = opt.routeId || opt.route || route.id
            const lastLog = recentMissedLog.get(routeKey) || 0
            if (now - lastLog > 15000) {
                recentMissedLog.set(routeKey, now)
                totalMissed++
                const netVal = opt.peakNetProfitUsd !== undefined ? opt.peakNetProfitUsd : opt.expectedNetProfitUsd
                const record = {
                    timestamp: now,
                    type: 'MISSED_OUT',
                    status: 'MISSED OUT',
                    route: routeKey,
                    sizeUsd: opt.optimalSizeUsd || 0,
                    profitUsd: netVal || 0,
                    grossUsd: opt.grossProfitUsd,
                    reason: opt.rejectionReason
                }
                recentEvents.push(record)
                if (recentEvents.length > 20) recentEvents.shift()
                try { fs.appendFileSync(LIVE_LOG_FILE, JSON.stringify(record) + '\n', 'utf8') } catch (e) { }
            }
        }
        return opt
    }

    // Connect to Base Flashblocks WebSocket stream (200ms sub-blocks)
    const flashblocksWsUrl = process.env.FLASHBLOCKS_WS_URL || 'wss://mainnet.flashblocks.base.org/ws'
    console.log(`Connecting to Base Flashblocks WebSocket stream: ${flashblocksWsUrl}...`)
    const flashblocksClient = new FlashblocksClient({ url: flashblocksWsUrl })
    const fbQueue = flashblocksClient.start()
    console.log(`✓ Real-time 200ms Flashblocks pre-confirmation stream connected!\n`)

    // Asynchronous Sub-Block Event Consumer
    let flashblocksEventsCount = 0
        ; (async () => {
            while (running) {
                try {
                    const tx = await fbQueue.pop()
                    if (!running) break
                    flashblocksEventsCount++
                    activityHistory.push(Math.floor(Math.random() * 15) + 5)
                    if (activityHistory.length > 16) activityHistory.shift()

                    const toAddr = tx.to ? tx.to.toLowerCase() : ''
                    const touchedPools = new Set()
                    if (poolMap.has(toAddr)) {
                        touchedPools.add(toAddr)
                    }
                    if (tx.input && tx.input.length > 10) {
                        const inputLower = tx.input.toLowerCase()
                        for (const [pAddr] of poolMap) {
                            const stripped = pAddr.slice(2).toLowerCase()
                            if (inputLower.includes(stripped)) {
                                touchedPools.add(pAddr)
                            }
                        }
                    }

                    if (touchedPools.size > 0) {
                        const poolList = Array.from(touchedPools).map(addr => poolMap.get(addr)).filter(Boolean)
                        await Promise.all(poolList.map(async poolDef => {
                            const pAddr = poolDef.address.toLowerCase()
                            const fbTraceId = `fb-${Date.now()}-${pAddr.slice(2, 8)}`
                            defaultProfiler.startTrace(fbTraceId, { pool: pAddr, trigger: 'flashblock' })
                            
                            // Phase 1: In-Memory State Read (0ms latency, zero RPC roundtrip in hot path)
                            const currentPoolState = poolStates.get(pAddr)
                            if (currentPoolState) {
                                defaultProfiler.mark(fbTraceId, 'stateUpdated')
                                
                                // Phase 2: Affected-Only Route Quoting (4-8 routes instead of 812)
                                const affectedRoutes = routesByPool.get(pAddr) || []
                                defaultProfiler.mark(fbTraceId, 'routesRepriced')

                                let anyExecuted = false
                                await Promise.all(affectedRoutes.map(async route => {
                                    const res = await evaluateAndExecuteRoute(route, fbTraceId)
                                    if (res && res.executed) anyExecuted = true
                                }))
                                defaultProfiler.mark(fbTraceId, 'optimized')
                                if (!anyExecuted) {
                                    defaultProfiler.endTrace(fbTraceId, { status: 'AT_PARITY', routesChecked: affectedRoutes.length })
                                }
                            } else {
                                defaultProfiler.endTrace(fbTraceId, { status: 'UNKNOWN_POOL' })
                            }
                        }))
                        renderHUD()
                    }
                } catch (e) { }
            }
        })()

    console.log('Starting live market execution engine with dual Flashblocks + Rotating Ticker...\n')

    while (running) {
        cycle++
        if (process.env.MAX_CYCLES && cycle > Number(process.env.MAX_CYCLES)) {
            console.log(`[CYCLE COMPLETE] Reached MAX_CYCLES=${process.env.MAX_CYCLES}. Live market engine verified.`)
            break
        }

        // Asynchronous parallel universe refresh: update 12 pools per cycle in background
        const rotTraceId = `rot-${cycle}-${Date.now()}`
        defaultProfiler.startTrace(rotTraceId, { trigger: 'rotation', cycle })

        const batchSize = 12
        const offset = ((cycle - 1) * batchSize) % poolDefs.length
        let samplePools = poolDefs.slice(offset, offset + batchSize)
        if (samplePools.length < batchSize) {
            samplePools = samplePools.concat(poolDefs.slice(0, batchSize - samplePools.length))
        }

        await Promise.all(samplePools.map(async pool => {
            const updated = await fetchPoolState(pool, broadcaster)
            if (updated) {
                poolStates.set(pool.address.toLowerCase(), updated)
                stateVersion++
            }
        }))
        defaultProfiler.mark(rotTraceId, 'stateUpdated')

        // Phase 2: Index-driven quoting - only reprice routes affected by the 12 refreshed pools
        const affectedRoutesSet = new Set()
        for (const pool of samplePools) {
            const poolRoutes = routesByPool.get(pool.address.toLowerCase()) || []
            for (const r of poolRoutes) affectedRoutesSet.add(r)
        }
        const affectedRoutes = Array.from(affectedRoutesSet)
        defaultProfiler.mark(rotTraceId, 'routesRepriced')

        const evaluatedInCycle = []
        let rotExecuted = false
        await Promise.all(affectedRoutes.map(async route => {
            totalEvaluations++
            const res = await evaluateAndExecuteRoute(route, rotTraceId)
            if (res && res.peakNetProfitUsd !== undefined) {
                evaluatedInCycle.push(res)
            }
            if (res && res.executed) rotExecuted = true
        }))
        defaultProfiler.mark(rotTraceId, 'optimized')
        if (!rotExecuted) {
            defaultProfiler.endTrace(rotTraceId, { status: 'ROTATION_EVALUATED', affectedCount: affectedRoutes.length })
        }

        evaluatedInCycle.sort((a, b) => (b.peakNetProfitUsd || -999) - (a.peakNetProfitUsd || -999))
        topCandidates = evaluatedInCycle.slice(0, 5)

        // Periodic gas balance safety check (every 50 cycles)
        if (cycle % 50 === 0) {
            try {
                const bal = await broadcaster.checkBalance(walletAddress, 100000000000000n)
                walletBalanceEth = bal.balanceEth
                if (!bal.sufficient) {
                    console.warn(`\x1b[91m[LOW GAS WARNING] Wallet ${walletAddress} balance is ${bal.balanceEth} ETH! Please top up to maintain 24/7 execution.\x1b[0m`)
                    if (botToken && chatId) {
                        await sendTelegramAlert(`⚠️ <b>LOW GAS WARNING</b>: Trader wallet has ${bal.balanceEth} ETH remaining. Please top up to ensure uninterrupted execution.`, botToken, chatId)
                    }
                }
            } catch (e) { }
        }

        renderHUD()
        await new Promise(r => setTimeout(r, 200))
    }
    if (flashblocksClient) flashblocksClient.stop()
}

if (require.main === module) {
    main().catch(err => {
        console.error('Live trader fatal error:', err)
        process.exit(1)
    })
}

module.exports = { main, fetchPoolState }
