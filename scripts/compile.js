'use strict'

const fs = require('fs')
const path = require('path')
const solc = require('solc')

const CONTRACT_NAME = 'UniswapV3FlashArbitrager'
const SOURCE_FILE = path.join(__dirname, '..', 'src', 'contracts', `${CONTRACT_NAME}.sol`)
const OUTPUT_DIR = path.join(__dirname, '..', 'build', 'contracts')
const OUTPUT_FILE = path.join(OUTPUT_DIR, `${CONTRACT_NAME}.json`)

function compileContract() {
    if (!fs.existsSync(SOURCE_FILE)) {
        throw new Error(`Source file not found: ${SOURCE_FILE}`)
    }

    const sourceContent = fs.readFileSync(SOURCE_FILE, 'utf8')

    const input = {
        language: 'Solidity',
        sources: {
            [`${CONTRACT_NAME}.sol`]: {
                content: sourceContent
            }
        },
        settings: {
            viaIR: true,
            outputSelection: {
                '*': {
                    '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'evm.methodIdentifiers']
                }
            },
            optimizer: {
                enabled: true,
                runs: 200
            }
        }
    }

    const output = JSON.parse(solc.compile(JSON.stringify(input)))

    if (output.errors) {
        const errors = output.errors.filter(e => e.severity === 'error')
        const warnings = output.errors.filter(e => e.severity === 'warning')

        if (warnings.length > 0) {
            console.warn('[COMPILER] Warnings:')
            warnings.forEach(w => console.warn(w.formattedMessage))
        }

        if (errors.length > 0) {
            console.error('[COMPILER] Errors:')
            errors.forEach(e => console.error(e.formattedMessage))
            throw new Error(`Compilation failed with ${errors.length} error(s)`)
        }
    }

    const contract = output.contracts[`${CONTRACT_NAME}.sol`][CONTRACT_NAME]
    if (!contract) {
        throw new Error(`Contract ${CONTRACT_NAME} not found in compilation output`)
    }

    const artifact = {
        contractName: CONTRACT_NAME,
        abi: contract.abi,
        bytecode: '0x' + contract.evm.bytecode.object,
        deployedBytecode: '0x' + contract.evm.deployedBytecode.object,
        methodIdentifiers: contract.evm.methodIdentifiers,
        compiler: {
            name: 'solc',
            version: solc.version()
        },
        updatedAt: new Date().toISOString()
    }

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true })
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(artifact, null, 2), 'utf8')
    console.log(`[COMPILER] Successfully compiled ${CONTRACT_NAME} (solc ${solc.version()})`)
    console.log(`[COMPILER] Artifact saved to: ${OUTPUT_FILE}`)
    console.log(`[COMPILER] Bytecode length: ${artifact.bytecode.length} chars | Deployed: ${artifact.deployedBytecode.length} chars`)

    return artifact
}

if (require.main === module) {
    try {
        compileContract()
    } catch (err) {
        console.error(err)
        process.exit(1)
    }
}

module.exports = { compileContract, CONTRACT_NAME, OUTPUT_FILE }
