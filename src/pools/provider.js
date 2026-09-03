'use strict'

class BaseRpcProvider {
    constructor(options = {}) {
        this.web3 = options.web3
        if (!this.web3) {
            const Web3 = options.Web3 || require('web3')
            if (!options.httpUrl) throw new Error('BASE_RPC_URL is required for canonical pool state')
            this.web3 = new Web3(new Web3.providers.HttpProvider(options.httpUrl))
        }
    }

    async call(address, abi, method, args = []) {
        const contract = new this.web3.eth.Contract(abi, address)
        if (!contract.methods[method]) throw new Error(`Contract method ${method} is not available`)
        return contract.methods[method](...args).call()
    }

    async getBlockNumber() {
        return this.web3.eth.getBlockNumber()
    }
}

module.exports = { BaseRpcProvider }