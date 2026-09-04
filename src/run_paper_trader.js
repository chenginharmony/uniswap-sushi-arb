'use strict'

const { loadConfig } = require('./config')
const { PaperTrader } = require('./monitoring/paper_trader')
const { buildCrossDexRoutes } = require('./arbitrage/route_builder')
const { optimizeRouteSize } = require('./arbitrage/optimizer')
const { FlashblocksClient } = require('./flashblocks/client')
const { printReport, generateTelemetryReport } = require('../scripts/paper_trading_report')
const fs = require('fs')
const path = require('path')

const config = loadConfig(process.env)
const UNIVERSE_FILE = path.join(__dirname, '..', 'data', 'base_pool_universe.json')

const RPC_URLS = config.base.rpcUrls || [
    'https://base-rpc.publicnode.com',
    'https://1rpc.io/base',
    'https://mainnet.base.org'
]

async function rpcCall(method, params = []) {
    for (const url of RPC_URLS) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
            })
            const data = await res.json()
            if (data && data.result !== undefined) return data.result
        } catch (e) {}
    }
    return null
}

function getTokenMeta(address) {
    const a = (address || '').toLowerCase()
    if (a === '0x4200000000000000000000000000000000000006') return { symbol: 'WETH', decimals: 18, priceUsd: 2600 }
    if (a === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') return { symbol: 'USDC', decimals: 6, priceUsd: 1.0 }
    if (a === '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf') return { symbol: 'cbBTC', decimals: 8, priceUsd: 84500 }
    return { symbol: 'UNKNOWN', decimals: 18, priceUsd: 1.0 }
}

async function fetchPoolState(pool) {
    const address = pool.address
    try {
        const [slot0Raw, liqRaw] = await Promise.all([
            rpcCall('eth_call', [{ to: address, data: '0x3850c7bd' }, 'latest']),
            rpcCall('eth_call', [{ to: address, data: '0x1a686502' }, 'latest']).catch(() => '0x0')
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
            sqrtPriceX96,
            tick,
            liquidity,
            updatedAt: Date.now()
        }
    } catch (err) {
        return null
    }
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════════════════════╗')
    console.log('║       ⚡ BASE MAINNET UNISWAP V3 FLASH ARBITRAGE PAPER TRADING RUNNER        ║')
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝\n')
    console.log('Mode: STRICT DRY-RUN (Zero fund risk, live on-chain eth_call preflight)')
    console.log('Telemetry destination: data/paper_trades.jsonl\n')

    // 1. Load Pool Universe
    if (!fs.existsSync(UNIVERSE_FILE)) {
        throw new Error(`Universe file not found: ${UNIVERSE_FILE}`)
    }
    const poolDefs = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'))
    console.log(`Loaded ${poolDefs.length} Base Concentrated Liquidity Pools.`)

    const tokenPrices = {
        '0x4200000000000000000000000000000000000006': 2600,
        '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 84500,
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 1.0
    }

    const routes = buildCrossDexRoutes(poolDefs, tokenPrices)
    console.log(`Generated ${routes.length} Cross-DEX arbitrage routes across Uniswap V3 and PancakeSwap V3.\n`)

    const paperTrader = new PaperTrader({
        config,
        rpcUrls: RPC_URLS
    })

    console.log(`Connected ExecutionController to Deployed Contract: ${paperTrader.contractAddress}`)
    console.log('Bootstrapping live pool reserves from Base Mainnet...\n')

    const poolStates = new Map()
    let stateVersion = 1

    for (const def of poolDefs) {
        const state = await fetchPoolState(def)
        if (state) {
            poolStates.set(def.address.toLowerCase(), state)
        }
    }
    console.log(`✓ Bootstrapped ${poolStates.size} active pools with live ticks and liquidity.\n`)

    let running = true
    process.on('SIGINT', () => {
        console.log('\nStopping paper trading session...')
        running = false
        const report = generateTelemetryReport(paperTrader.logFile)
        printReport(report)
        process.exit(0)
    })

    console.log('Starting live paper trading evaluation loop (Press Ctrl+C to stop)...\n')

    let cycle = 0
    while (running) {
        cycle++
        const cycleStarted = process.hrtime.bigint()

        // Periodically refresh states of top volume pools
        const samplePools = poolDefs.slice(0, 6)
        for (const pool of samplePools) {
            const updated = await fetchPoolState(pool)
            if (updated) {
                poolStates.set(pool.address.toLowerCase(), updated)
                stateVersion++
            }
        }

        // Evaluate routes
        for (const route of routes) {
            const buyAddr = (route.buyPool.address || route.buyPool).toLowerCase()
            const sellAddr = (route.sellPool.address || route.sellPool).toLowerCase()
            const buyPool = poolStates.get(buyAddr)
            const sellPool = poolStates.get(sellAddr)

            if (!buyPool || !sellPool) continue

            const populatedRoute = Object.assign({}, route, { buyPool, sellPool })
            const opt = optimizeRouteSize(populatedRoute, {
                minNetProfitUsd: config.minNetProfitUsd || 0.10,
                minProfitMarginBps: config.minProfitMarginBps || 0,
                gasCostUsd: config.gasCostUsd || 0.04
            }, { version: stateVersion, pools: poolStates })

            if (opt.profitable) {
                const initialSpreadBps = opt.expectedPriceSpreadBps || 15
                const receipt = await paperTrader.processPaperTrade(opt, {
                    detectedAtNs: cycleStarted,
                    initialSpreadBps,
                    currentVersion: stateVersion
                })

                console.log(`[★ OPPORTUNITY] Route: ${receipt.route} | Size: $${receipt.optimalSizeUsd} | Net Edge: +$${receipt.netEdgeUsd} | Preflight: ${receipt.preflight.passed ? 'PASSED' : receipt.preflight.reason} | Latency: ${receipt.latencies.totalLatencyMs}ms`)
            }
        }

        if (cycle % 10 === 0) {
            const m = paperTrader.getMetrics()
            console.log(`[HEARTBEAT] Cycle ${cycle} | Evaluated: ${m.totalEvaluated} | Preflights Passed: ${m.preflightPassed} (${m.preflightPassRatePct}%) | Captured Profit: $${m.hypotheticalProfitUsd.toFixed(2)} USD`)
        }

        await new Promise(r => setTimeout(r, 1000))
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Paper trader error:', err)
        process.exit(1)
    })
}

module.exports = { main }
