require('dotenv').config()//for importing parameters
require('colors')//for console output
const Web3 = require('web3')
const { loadConfig } = require('./config')
const { calculateProfitability } = require('./arbitrage/profitability')

//ABIs
const IFactory = require('@uniswap/v2-core/build/IUniswapV2Factory.json')
const IPair = require('@uniswap/v2-core/build/IUniswapV2Pair.json')  
const IRouter = require('@uniswap/v2-periphery/build/IUniswapV2Router02.json')
const Utils = require('../build/contracts/Utils.json')
const IERC20 = require('@uniswap/v2-periphery/build/IERC20.json')

//importing parameters from .env (mostly given)
const addrArbitrager = process.env.ADDR_ARBITRAGE_CONTRACT
const addrDai = process.env.ADDR_DAI
const addrEth = process.env.ADDR_ETH//indeed its weth, henceforth simply eth
const addrSFactory = process.env.ADDR_SFACTORY
const addrSRouter = process.env.ADDR_SROUTER
let addrToken0 = process.env.ADDR_TOKEN0
let addrToken1 = process.env.ADDR_TOKEN1
const addrUFactory = process.env.ADDR_UFACTORY
const addrURouter = process.env.ADDR_UROUTER
const addrUtils = process.env.ADDR_UTILS
const runtimeConfig = loadConfig(process.env)
const localDeplyment = runtimeConfig.localDeployment
const priceToken0 = process.env.PRICE_TOKEN0
const priceToken1 = process.env.PRICE_TOKEN1
const privateKey = process.env.PRIVATE_KEY
const projectId = process.env.PROJECT_ID;
const validPeriod = process.env.VALID_PERIOD

if (addrToken0 > addrToken1) {aux=addrToken0; addrToken0=addrToken1; addrToken1=aux} //on uniswap pairs, tokens are sort by address, T0<T1

//setting up provider
const wsProviderOptions = {
    timeout: 30000,
    clientConfig: {
        keepalive: true,
        keepaliveInterval: 60000
    },
    reconnect: {
        auto: true,
        delay: 5000,
        maxAttempts: 10,
        onTimeout: false
    }
}

let web3
if (localDeplyment) {

    console.log('LOCAL_DEPLOYMENT detected: using HTTP polling for Ganache because websocket subscriptions are not available on this local node.')
    web3 = new Web3(new Web3.providers.HttpProvider('http://localhost:8545'))

} else {

    /* In this case we use an infura provider for mainnet, you could use whatever you want but 
    it cant be a http provider because it doesnt support web3 subscriptions (events).*/
    const infuraProvider = new Web3.providers.WebsocketProvider(`wss://mainnet.infura.io/ws/v3/${projectId}`, wsProviderOptions)
    infuraProvider.on('connect', () => console.log('WebSocket connected to Infura'))
    infuraProvider.on('error', (err) => console.error('Infura websocket error:', err && err.message ? err.message : err))
    infuraProvider.on('close', (event) => console.warn(`Infura websocket closed: ${event.code} ${event.reason || 'no reason'}`))
    web3 = new Web3(infuraProvider)
}

//contracts
const uFactory = new web3.eth.Contract(IFactory.abi,addrUFactory)
const uRouter = new web3.eth.Contract(IRouter.abi,addrURouter)
const sFactory = new web3.eth.Contract(IFactory.abi,addrSFactory)//sushiswap, same ABIs, sushiswap forked uniswap so, basically same contracts
const sRouter = new web3.eth.Contract(IRouter.abi,addrSRouter)
const token0 = new web3.eth.Contract(IERC20.abi,addrToken0)//henceforth T0
const token1 = new web3.eth.Contract(IERC20.abi,addrToken1)//and T1
const utils = new web3.eth.Contract(Utils.abi, addrUtils)//because includes an support math function that its required

//asyncs variables
let uPair0,uPair1,sPair,myAccount,token0Name,token1Name,token0Symbol,token1Symbol
async function asyncsVar() {
    //will be used to determine eth price later
    uPair0 = new web3.eth.Contract(IPair.abi, (await uFactory.methods.getPair(addrEth, addrDai).call()) )
    //token pairs
    uPair1 = new web3.eth.Contract(IPair.abi, (await uFactory.methods.getPair(token0.options.address, token1.options.address).call()) )
    sPair = new web3.eth.Contract(IPair.abi, (await sFactory.methods.getPair(token0.options.address, token1.options.address).call()) )

    //account with you will be using to sign the transactions
    const accountObj = await web3.eth.accounts.privateKeyToAccount(privateKey)
    myAccount = accountObj.address

    token0Name = await token0.methods.name().call()
    token0Symbol = await token0.methods.symbol().call()
    token1Name = await token1.methods.name().call()
    token1Symbol = await token1.methods.symbol().call()
}

const ui = {
    banner: (text) => console.log(`\n${text}`.cyan.bold),
    idle: (text) => console.log(`♢ ${text}`.gray),
    alert: (text) => console.log(`⚡ ${text}`.magenta.bold),
    profit: (text) => console.log(`💰 ${text}`.green.bold),
    tx: (text) => console.log(`⛓ ${text}`.yellow.bold),
    danger: (text) => console.log(`🚨 ${text}`.red.bold),
    success: (text) => console.log(`✅ ${text}`.green)
}

let lastBlockScanned = null

async function handleBlock(blockHeader) {
    try {

        let uReserves, uReserve0, uReserve1, sReserves, sReserve0, sReserve1

        //obtaining eth price from uniswap, pretty accurate
        uReserves = await uPair0.methods.getReserves().call()
        uReserve0 = uReserves[0] //dai
        uReserve1 = uReserves[1] //eth
        priceEth = (uReserve0/uReserve1) //dai per eth
            
        //token prices in eth, used bellow for determining if its possible to make a profit
        const priceToken0Eth = priceToken0*1/priceEth 
        const priceToken1Eth = priceToken1*1/priceEth 

        //tokens reserves on uniswap
        uReserves = await uPair1.methods.getReserves().call()
        uReserve0 = uReserves[0] //T0
        uReserve1 = uReserves[1] //T1
        
        //tokens reserves on sushiswap
        sReserves = await sPair.methods.getReserves().call()
        sReserve0 = sReserves[0] //T0
        sReserve1 = sReserves[1] //T1

        //compute amount that must be traded to maximize the profit and, trade direction; function provided by uniswap
        const result = await utils.methods.computeProfitMaximizingTrade(sReserve0,sReserve1,uReserve0,uReserve1).call()
        const aToB = result[0] //trade direction
        const amountIn = result[1]

        if (amountIn==0) {
            ui.idle(`No spread on block ${blockHeader.number} — waiting for the next move.`)
            return
        }
        
        if (aToB) { //T0->T1

            const amountOut = await uRouter.methods.getAmountOut(amountIn, uReserve0, uReserve1).call()
            const newUReserve0 = Number(uReserve0) + Number(amountIn)
            const newUReserve1 = Number(uReserve1) - Number(amountOut)
            const sAmountIn = await sRouter.methods.getAmountIn(amountIn, sReserve1, sReserve0).call()
            const sPrice = 1 / (sAmountIn / amountIn)
            const difference = amountOut / amountIn - 1 / sPrice

            if (difference <= 0) {
                console.log('No arbitrage opportunity on block ' + blockHeader.number + '\n')
                return
            }

            const totalDifference = difference * Math.round(amountIn / 10 ** 18)
            const deadline = Math.round(Date.now() / 1000) + validPeriod * 60
            const gasNeeded = (0.3 * 10 ** 6) * 2
            const gasPrice = await web3.eth.getGasPrice()
            const gasCost = Number(gasPrice) * gasNeeded / 10 ** 18
            const profitability = calculateProfitability({
                grossProfitUsd: totalDifference * priceToken1Eth * priceEth,
                gasCostUsd: gasCost * priceEth,
                safetyMarginUsd: runtimeConfig.safetyMarginUsd,
                minimumNetProfitUsd: runtimeConfig.minNetProfitUsd,
                minimumProfitMarginBps: runtimeConfig.minProfitMarginBps,
                maxSlippageBps: runtimeConfig.maxSlippageBps
            })
            const profit = profitability.expectedNetProfitUsd / priceEth
            const profitSummaryA = profit > 0
                ? ('Profit: ' + profit.toFixed(5) + ' ETH / ' + (profit * priceEth).toFixed(2) + ' DAI').green
                : 'No profit'.red

            const blockLabelA = 'BLOCK ' + blockHeader.number
            console.log('\n+------------------------------------------------------------+')
            console.log('| ' + blockLabelA.padEnd(48, ' ') + ' |')
            console.log('+------------------------------------------------------------+')
            console.log(
                token0Name + ' (' + token0Symbol + ') | ' + token1Name + ' (' + token1Symbol + ')\n' +
                'Uni: ' + Math.round(uReserve0 / 10 ** 18) + ' / ' + Math.round(uReserve1 / 10 ** 18) + '\n' +
                'Sushi: ' + Math.round(sReserve0 / 10 ** 18) + ' / ' + Math.round(sReserve1 / 10 ** 18) + '\n' +
                'Direction: ' + token0Symbol + ' -> ' + token1Symbol + '\n' +
                'Price gap: ' + difference.toFixed(2) + ' ' + token1Symbol + '/' + token0Symbol + '\n' +
                'Potential: ' + (totalDifference * priceToken1Eth).toFixed(5) + ' ETH / ' + totalDifference.toFixed(2) + ' ' + token1Symbol + '\n' +
                'Gas: ' + (gasNeeded / 10 ** 6) + 'M • ' + (gasPrice / 10 ** 9) + ' gwei • ' + gasCost.toFixed(5) + ' ETH\n' +
                profitSummaryA
            )

            if (!profitability.profitable) return
            if (runtimeConfig.dryRun) {
                ui.idle('DRY_RUN enabled - qualifying flashswap was not submitted')
                return
            }

            ui.profit('ARBITRAGE DETECTED - ' + token0Symbol + '/' + token1Symbol + ' spread is live on block ' + blockHeader.number)

            const abi = web3.eth.abi.encodeParameters(['uint256', 'uint256'], [sAmountIn, deadline])

            const tx = {
                from: myAccount,
                to: sPair.options.address,
                gas: gasNeeded,
                data: sPair.methods.swap(amountIn, 0, addrArbitrager, abi).encodeABI()
            }

            signedTx = await web3.eth.accounts.signTransaction(tx, privateKey)

            ui.tx('TX READY - sending arbitrage trade on ' + token0Symbol + '/' + token1Symbol)
            receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction)

            ui.success('TRADE EXECUTED - hash ' + receipt.transactionHash)

        } else {//T1->T0

            const amountOut = await uRouter.methods.getAmountOut(amountIn, uReserve1, uReserve0).call()
            const newUReverve0 = Number(uReserve0) - Number(amountOut)
            const newUReverve1 = Number(uReserve1) + Number(amountIn)
            const sAmountIn = await sRouter.methods.getAmountIn(amountIn, sReserve0, sReserve1).call()
            const sPrice = sAmountIn / amountIn
            const difference = amountOut / amountIn - sPrice

            if (difference <= 0) {
                console.log('No arbitrage opportunity on block ' + blockHeader.number + '\n')
                return
            }

            const totalDifference = difference * Math.round(amountIn / 10 ** 18)
            const deadline = Math.round(Date.now() / 1000) + validPeriod * 60
            const gasNeeded = (0.3 * 10 ** 6) * 2
            const gasPrice = await web3.eth.getGasPrice()
            const gasCost = Number(gasPrice) * gasNeeded / 10 ** 18
            const profitability = calculateProfitability({
                grossProfitUsd: totalDifference * priceToken0Eth * priceEth,
                gasCostUsd: gasCost * priceEth,
                safetyMarginUsd: runtimeConfig.safetyMarginUsd,
                minimumNetProfitUsd: runtimeConfig.minNetProfitUsd,
                minimumProfitMarginBps: runtimeConfig.minProfitMarginBps,
                maxSlippageBps: runtimeConfig.maxSlippageBps
            })
            const profit = profitability.expectedNetProfitUsd / priceEth
            const profitSummaryB = profit > 0
                ? ('Profit: ' + profit.toFixed(5) + ' ETH / ' + (profit * priceEth).toFixed(2) + ' DAI').green
                : 'No profit'.red

            const blockLabelB = 'BLOCK ' + blockHeader.number
            console.log('\n+------------------------------------------------------------+')
            console.log('| ' + blockLabelB.padEnd(48, ' ') + ' |')
            console.log('+------------------------------------------------------------+')
            console.log(
                token0Name + ' (' + token0Symbol + ') | ' + token1Name + ' (' + token1Symbol + ')\n' +
                'Uni: ' + Math.round(uReserve0 / 10 ** 18) + ' / ' + Math.round(uReserve1 / 10 ** 18) + '\n' +
                'Sushi: ' + Math.round(sReserve0 / 10 ** 18) + ' / ' + Math.round(sReserve1 / 10 ** 18) + '\n' +
                'Direction: ' + token1Symbol + ' -> ' + token0Symbol + '\n' +
                'Price gap: ' + difference.toFixed(2) + ' ' + token0Symbol + '/' + token1Symbol + '\n' +
                'Potential: ' + (totalDifference * priceToken0Eth).toFixed(5) + ' ETH / ' + totalDifference.toFixed(2) + ' ' + token0Symbol + '\n' +
                'Gas: ' + (gasNeeded / 10 ** 6) + 'M • ' + (gasPrice / 10 ** 9) + ' gwei • ' + gasCost.toFixed(5) + ' ETH\n' +
                profitSummaryB
            )

            if (!profitability.profitable) return
            if (runtimeConfig.dryRun) {
                ui.idle('DRY_RUN enabled - qualifying flashswap was not submitted')
                return
            }

            ui.profit('ARBITRAGE DETECTED - ' + token1Symbol + '/' + token0Symbol + ' spread is live on block ' + blockHeader.number)

            const abi = web3.eth.abi.encodeParameters(['uint256', 'uint256'], [sAmountIn, deadline])
            const tx = {
                from: myAccount,
                to: sPair.options.address,
                gas: gasNeeded,
                data: sPair.methods.swap(0, amountIn, addrArbitrager, abi).encodeABI()
            }
            signedTx = await web3.eth.accounts.signTransaction(tx, privateKey)
            ui.tx('TX READY - sending arbitrage trade on ' + token1Symbol + '/' + token0Symbol)
            receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction)
            ui.success('TRADE EXECUTED - hash ' + receipt.transactionHash)
        }

    } catch (error) {
        console.log(error)
    }
}

function subscribeToBlocks() {
    if (localDeplyment) {
        let lastLocalBlock = null
        ui.banner('ARBITRAGE ENGINE ONLINE — polling Ganache for new blocks')
        setInterval(async () => {
            try {
                const latestBlock = await web3.eth.getBlockNumber()
                if (lastLocalBlock === null) {
                    lastLocalBlock = latestBlock
                    return
                }
                if (latestBlock <= lastLocalBlock) return
                const blockHeader = await web3.eth.getBlock(latestBlock)
                lastLocalBlock = latestBlock
                await handleBlock(blockHeader)
            } catch (err) {
                console.error('Local polling error:', err && err.message ? err.message : err)
            }
        }, 2000)
        return
    }

    const newBlockEvent = web3.eth.subscribe('newBlockHeaders')
    newBlockEvent.on('connected', () => {
        ui.banner('ARBITRAGE ENGINE ONLINE — live spread monitor engaged')
    })
    newBlockEvent.on('data', handleBlock)
    newBlockEvent.on('error', (err) => {
        console.error('Block subscription error:', err && err.message ? err.message : err)
        setTimeout(subscribeToBlocks, 5000)
    })
}

asyncsVar().then(subscribeToBlocks).catch(error => {
    ui.danger('Initialization failed: ' + (error && error.message ? error.message : error))
})
