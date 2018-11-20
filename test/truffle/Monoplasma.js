const RootChainContract = artifacts.require("./Monoplasma.sol")
const ERC20Mintable = artifacts.require("openzeppelin-solidity/contracts/token/ERC20/ERC20Mintable.sol")

const { assertEqual, assertFails, increaseTime } = require("./testHelpers")

const Monoplasma = require("../../src/monoplasma")

contract("Monoplasma", accounts => {
    let token
    let rootchain
    const producer = accounts[1]
    const anotherProducer = accounts[2]
    const nonMember = accounts[5]
    const admin = accounts[9]
    const blockFreezePeriodSeconds = 1000
    const plasma = new Monoplasma()
    before(async () => {
        token = await ERC20Mintable.new({from: admin, gas: 4000000})
        rootchain = await RootChainContract.new(token.address, blockFreezePeriodSeconds, {from: admin, gas: 4000000})
        await rootchain.addRecipient(producer, {from: admin, gas: 4000000})
        await rootchain.addRecipient(anotherProducer, {from: admin, gas: 4000000})
        await token.mint(rootchain.address, 1000000, {from: admin})

        // these should be performed by the watcher
        plasma.addMember(producer)
        plasma.addMember(anotherProducer)
        plasma.addRevenue(1000)
    })

    // TODO: upgrade to latest truffle and hence web3 1.0, get rid of this kind of wrappers...
    async function getBlockNumber() {
        return new Promise(done => {
            web3.eth.getBlockNumber((err, blockNum) => {
                done(blockNum)
            })
        })
    }

    async function publishBlock(rootHash) {
        const root = rootHash || plasma.getRootHash()
        const rootChainBlockNumber = await getBlockNumber()
        const resp = await rootchain.recordBlock(rootChainBlockNumber, root, "ipfs lol", {from: admin})
        return resp.logs.find(L => L.event === "BlockCreated").args
    }

    describe("Admin", () => {
        it("can publish blocks", async () => {
            const block = await publishBlock()
            assertEqual(await rootchain.blockHash(block.rootChainBlockNumber), block.rootHash)
        })
    })

    describe("Member", () => {
        it("can withdraw earnings", async () => {
            plasma.addRevenue(1000)
            const block = await publishBlock()
            await increaseTime(blockFreezePeriodSeconds + 1)
            const proof = plasma.getProof(producer)
            const { earnings } = plasma.getMember(producer)
            assertEqual(await token.balanceOf(producer), 0)
            await rootchain.withdrawAll(block.rootChainBlockNumber, earnings, proof, {from: producer})
            assertEqual(await token.balanceOf(producer), earnings)
        })
        it("can not withdraw earnings before freeze period is over", async () => {
            plasma.addRevenue(1000)
            const block = await publishBlock()
            const proof = plasma.getProof(producer)
            await assertFails(rootchain.withdrawAll(block.rootChainBlockNumber, 500, proof, {from: producer}))
        })
        it("can not withdraw wrong amount", async () => {
            plasma.addRevenue(1000)
            const block = await publishBlock()
            await increaseTime(blockFreezePeriodSeconds + 1)
            const proof = plasma.getProof(producer)
            await assertFails(rootchain.withdrawAll(block.rootChainBlockNumber, 50000, proof))
        })
        it("can not withdraw with bad proof", async () => {
            plasma.addRevenue(1000)
            const block = await publishBlock()
            await increaseTime(blockFreezePeriodSeconds + 1)
            await assertFails(rootchain.withdrawAll(block.rootChainBlockNumber, 500, [
                "0x3e6ef21b9ffee12d86b9ac8713adaba889b551c5b1fbd3daf6c37f62d7f162bc",
                "0x3f2ed4f13f5c1f5274cf624eb1d079a15c3666c97c5403e6e8cf9cea146a8608",
            ], {from: producer}))
        })
    })
})