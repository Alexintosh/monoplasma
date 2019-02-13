const Monoplasma = require("./monoplasma")
const { throwIfSetButNotContract, mergeEventLists } = require("./ethSync")

const TokenJson = require("../build/contracts/ERC20Mintable.json")
const MonoplasmaJson = require("../build/contracts/Monoplasma.json")

/**
 * MonoplasmaWatcher hooks to the root chain contract and keeps a local copy of the Monoplasma state up to date
 * Can be inherited to implement Operator and Validator functionality
 */
module.exports = class MonoplasmaWatcher {

    constructor(web3, joinPartChannel, startState, store, logFunc, errorFunc) {
        this.web3 = web3
        this.channel = joinPartChannel
        this.state = startState
        this.store = store
        this.log = logFunc || (() => {})
        this.error = errorFunc || console.error
        this.explorerUrl = this.state.explorerUrl
        this.filters = {}
    }

    async start() {
        await throwIfSetButNotContract(this.web3, this.state.contractAddress, "startState contractAddress")

        this.log("Initializing Monoplasma state...")
        // double-check state from contracts as a sanity check (TODO: alert if there were wrong in startState?)
        this.contract = new this.web3.eth.Contract(MonoplasmaJson.abi, this.state.contractAddress)
        this.state.tokenAddress = await this.contract.methods.token().call()
        this.token = new this.web3.eth.Contract(TokenJson.abi, this.state.tokenAddress)
        this.state.blockFreezeSeconds = await this.contract.methods.blockFreezeSeconds().call()

        const lastBlock = this.state.lastPublishedBlock && await this.store.loadBlock(this.state.lastPublishedBlock)
        const savedMembers = lastBlock ? lastBlock.members : []
        this.plasma = new Monoplasma(savedMembers, this.store, this.state.blockFreezeSeconds)

        // TODO: playback from joinPartChannel not implemented =>
        //   playback will actually fail if there are joins or parts from the channel in the middle (during downtime)
        //   the failing will probably be quite quickly noticed though, so at least validators would simply restart
        //   if the operator fails though...
        const latestBlock = await this.web3.eth.getBlockNumber()
        const playbackStartingBlock = this.state.lastBlockNumber + 1 || 0
        if (playbackStartingBlock <= latestBlock) {
            this.log("Playing back events from Ethereum and Channel...")
            await this.playback(playbackStartingBlock, latestBlock)
            this.state.lastBlockNumber = latestBlock
        }

        this.log("Listening to Ethereum events...")
        this.tokenFilter = this.token.events.Transfer({ filter: { to: this.state.contractAddress } })
        this.tokenFilter.on("data", event => {
            this.state.lastBlockNumber = event.blockNumber
            const income = event.returnValues.value
            this.log(`${income} tokens received`)
            this.plasma.addRevenue(income)
            this.store.saveState(this.state).catch(this.error)
        })
        this.tokenFilter.on("changed", event => { this.error("Event removed in re-org!", event) })
        this.tokenFilter.on("error", this.error)

        this.log("Listening to joins/parts from the Channel...")
        this.channel.listen()
        this.channel.on("join", addressList => {
            const bnum = this.state.lastBlockNumber
            const addedMembers = this.plasma.addMembers(addressList)
            this.log(`Added or activated ${addedMembers.length} new member(s) at block ${bnum}`)
            this.store.saveEvents(bnum, {
                event: "Join",
                addressList: addedMembers,
            })
        })
        this.channel.on("part", addressList => {
            const blockNumber = this.state.lastBlockNumber
            const removedMembers = this.plasma.removeMembers(addressList)
            this.log(`De-activated ${removedMembers.length} member(s) at block ${blockNumber}`)
            this.store.saveEvents(blockNumber, {
                blockNumber,
                event: "Part",
                addressList: removedMembers,
            })
        })

        await this.store.saveState(this.state)
    }

    async stop() {
        this.tokenFilter.unsubscribe()
        this.channel.close()
    }

    async playback(fromBlock, toBlock) {
        // TODO: include joinPartHistory in playback
        // TODO interim solution: take members from a recent block
        this.log(`Playing back blocks ${fromBlock}...${toBlock}`)
        const blockCreateEvents = await this.contract.getPastEvents("BlockCreated", { fromBlock, toBlock })
        const transferEvents = await this.token.getPastEvents("Transfer", { filter: { to: this.state.contractAddress }, fromBlock, toBlock })
        const joinPartEvents = await this.store.loadEvents(fromBlock, toBlock)
        const ethereumEvents = mergeEventLists(blockCreateEvents, transferEvents)
        const allEvents = mergeEventLists(ethereumEvents, joinPartEvents)
        for (const event of allEvents) {
            switch (event.event) {
                // event Transfer(address indexed from, address indexed to, uint256 value);
                case "Transfer": {
                    const { value } = event.returnValues
                    this.log(`Playback: ${value} tokens received @ block ${event.blockNumber}`)
                    this.plasma.addRevenue(value)
                } break
                // event BlockCreated(uint blockNumber, bytes32 rootHash, string ipfsHash);
                case "BlockCreated": {
                    const { blockNumber } = event.returnValues
                    await this.plasma.storeBlock(blockNumber)
                } break
                case "Join": {
                    const { addressList } = event
                    this.plasma.addMembers(addressList)
                } break
                case "Part": {
                    const { addressList } = event
                    this.plasma.removeMembers(addressList)
                } break
                default: {
                    this.error(`Unexpected event: ${JSON.stringify(event)}`)
                }
            }
        }
    }
}
