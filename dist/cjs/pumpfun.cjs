'use strict';

var web3_js = require('@solana/web3.js');
var anchor = require('@coral-xyz/anchor');
var globalAccount = require('./globalAccount.cjs');
var events = require('./events.cjs');
var splToken = require('@solana/spl-token');
var bondingCurveAccount = require('./bondingCurveAccount.cjs');
var bn = require('./_virtual/bn.cjs');
var util = require('./util.cjs');
var pumpFun = require('./IDL/pump-fun.json.cjs');

// SDK Constants
const MPL_TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const GLOBAL_ACCOUNT_SEED = "global";
const MINT_AUTHORITY_SEED = "mint-authority";
const BONDING_CURVE_SEED = "bonding-curve";
const METADATA_SEED = "metadata";
const EVENT_AUTHORITY_SEED = "__event_authority";
const DEFAULT_DECIMALS = 6;
class PumpFunSDK {
    program;
    connection;
    constructor(provider) {
        this.program = new anchor.Program(pumpFun.default, provider);
        this.connection = this.program.provider.connection;
    }
    async createAndBuy(creator, mint, createTokenMetadata, buyAmountSol, slippageBasisPoints = 500n, priorityFees, commitment = util.DEFAULT_COMMITMENT, finality = util.DEFAULT_FINALITY) {
        let tokenMetadata = await this.createTokenMetadata(createTokenMetadata);
        let createTx = await this.getCreateInstructions(creator.publicKey, createTokenMetadata.name, createTokenMetadata.symbol, tokenMetadata.metadataUri, mint);
        let newTx = new web3_js.Transaction().add(createTx);
        if (buyAmountSol > 0) {
            const globalAccount = await this.getGlobalAccount(commitment);
            const buyAmount = globalAccount.getInitialBuyPrice(buyAmountSol);
            const buyAmountWithSlippage = util.calculateWithSlippageBuy(buyAmountSol, slippageBasisPoints);
            // Instead of calling getBuyInstructions which requires an existing bonding curve,
            // we'll create the buy instruction manually since we know the token is being created
            const bondingCurvePDA = this.getBondingCurvePDA(mint.publicKey);
            const associatedBondingCurve = await splToken.getAssociatedTokenAddress(mint.publicKey, bondingCurvePDA, true);
            // Create associated token account for user if needed
            const associatedUser = await this.createAssociatedTokenAccountIfNeeded(creator.publicKey, creator.publicKey, mint.publicKey, newTx, commitment);
            // Get event authority PDA
            const eventAuthorityPda = this.getEventAuthorityPda();
            // Get global account PDA
            const globalAccountPDA = this.getGlobalAccountPda();
            // Derive creator_vault PDA using the creator's public key (for createAndBuy, bonding curve doesn't exist yet)
            const creatorVaultPda = this.getCreatorVaultPda(creator.publicKey);
            // Create buy instruction using Anchor coder
            const buyInstructionData = this.program.coder.instruction.encode("buy", {
                amount: new bn.bnExports.BN(buyAmount.toString()),
                maxSolCost: new bn.bnExports.BN(buyAmountWithSlippage.toString())
            });
            // Create accounts array in the exact order
            const accounts = [
                { pubkey: globalAccountPDA, isSigner: false, isWritable: false },
                { pubkey: globalAccount.feeRecipient, isSigner: false, isWritable: true },
                { pubkey: mint.publicKey, isSigner: false, isWritable: false },
                { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
                { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
                { pubkey: associatedUser, isSigner: false, isWritable: true },
                { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                { pubkey: new web3_js.PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
                { pubkey: new web3_js.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
                { pubkey: creatorVaultPda, isSigner: false, isWritable: true },
                { pubkey: eventAuthorityPda, isSigner: false, isWritable: false },
                { pubkey: this.program.programId, isSigner: false, isWritable: false }
            ];
            newTx.add(new web3_js.TransactionInstruction({
                keys: accounts,
                programId: this.program.programId,
                data: buyInstructionData
            }));
        }
        let createResults = await util.sendTx(this.connection, newTx, creator.publicKey, [creator, mint], priorityFees, commitment, finality);
        return createResults;
    }
    async buy(buyer, mint, buyAmountSol, slippageBasisPoints = 500n, priorityFees, commitment = util.DEFAULT_COMMITMENT, finality = util.DEFAULT_FINALITY) {
        // Get bonding curve account
        const bondingCurvePDA = this.getBondingCurvePDA(mint);
        const bondingAccount = await this.getBondingCurveAccount(mint, commitment);
        if (!bondingAccount) {
            throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
        }
        // Get global account
        const globalAccountPDA = this.getGlobalAccountPda();
        const globalAccount = await this.getGlobalAccount(commitment);
        // Calculate buy amount
        const buyAmount = bondingAccount.getBuyPrice(buyAmountSol);
        const buyAmountWithSlippage = util.calculateWithSlippageBuy(buyAmountSol, slippageBasisPoints);
        // Get the associated token accounts
        const associatedBondingCurve = await splToken.getAssociatedTokenAddress(mint, bondingCurvePDA, true);
        // Get bonding curve creator using helper function
        const bondingCurveCreator = await this.getBondingCurveCreator(bondingCurvePDA, commitment);
        // Derive creator_vault PDA using bonding curve creator (not user public key)
        const creatorVaultPda = this.getCreatorVaultPda(bondingCurveCreator);
        // Get event authority PDA
        const eventAuthorityPda = this.getEventAuthorityPda();
        // Create a new transaction
        let transaction = new web3_js.Transaction();
        // Add token account creation instruction if needed
        const associatedUser = await this.createAssociatedTokenAccountIfNeeded(buyer.publicKey, buyer.publicKey, mint, transaction, commitment);
        // Create buy instruction using Anchor coder
        const buyInstructionData = this.program.coder.instruction.encode("buy", {
            amount: new bn.bnExports.BN(buyAmount.toString()),
            maxSolCost: new bn.bnExports.BN(buyAmountWithSlippage.toString())
        });
        // Create accounts array in the exact order from buy_token_fixed.ts
        const accounts = [
            { pubkey: globalAccountPDA, isSigner: false, isWritable: false },
            { pubkey: globalAccount.feeRecipient, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedUser, isSigner: false, isWritable: true },
            { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
            { pubkey: new web3_js.PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false }, // SystemProgram
            { pubkey: new web3_js.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false }, // TokenProgram
            { pubkey: creatorVaultPda, isSigner: false, isWritable: true },
            { pubkey: eventAuthorityPda, isSigner: false, isWritable: false },
            { pubkey: this.program.programId, isSigner: false, isWritable: false }
        ];
        // Add the buy instruction (manually created to ensure correct account order)
        transaction.add(new web3_js.TransactionInstruction({
            keys: accounts,
            programId: this.program.programId,
            data: buyInstructionData
        }));
        // Send the transaction
        return await util.sendTx(this.connection, transaction, buyer.publicKey, [buyer], priorityFees, commitment, finality);
    }
    async sell(seller, mint, sellTokenAmount, slippageBasisPoints = 500n, priorityFees, commitment = util.DEFAULT_COMMITMENT, finality = util.DEFAULT_FINALITY) {
        // Get bonding curve account
        const bondingCurvePDA = this.getBondingCurvePDA(mint);
        const bondingAccount = await this.getBondingCurveAccount(mint, commitment);
        if (!bondingAccount) {
            throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
        }
        // Get global account
        const globalAccountPDA = this.getGlobalAccountPda();
        const globalAccount = await this.getGlobalAccount(commitment);
        // Calculate sell amount and slippage
        // Get exact price from bonding curve
        const minSolOutput = bondingAccount.getSellPrice(sellTokenAmount, globalAccount.feeBasisPoints);
        // Calculate with percentage-based slippage rather than a fixed value reduction
        let sellAmountWithSlippage = util.calculateWithSlippageSell(minSolOutput, slippageBasisPoints);
        // Make sure we don't go below 1 for very small amounts
        if (sellAmountWithSlippage < 1n) {
            sellAmountWithSlippage = 1n;
        }
        console.log(`Sell details: amount=${sellTokenAmount}, exactSolOutput=${minSolOutput}, withSlippage=${sellAmountWithSlippage}`);
        // Get the associated token accounts
        const associatedBondingCurve = await splToken.getAssociatedTokenAddress(mint, bondingCurvePDA, true);
        const sellerPublicKey = seller.publicKey;
        const associatedUser = await splToken.getAssociatedTokenAddress(mint, sellerPublicKey, false);
        // Get bonding curve creator using helper function
        const bondingCurveCreator = await this.getBondingCurveCreator(bondingCurvePDA, commitment);
        // Get the creator vault PDA
        const creatorVaultPda = this.getCreatorVaultPda(bondingCurveCreator);
        console.log("Creator vault PDA:", creatorVaultPda.toString());
        // Get event authority PDA
        const eventAuthorityPda = this.getEventAuthorityPda();
        // Create a new transaction
        let transaction = new web3_js.Transaction();
        const sellInstructionData = this.program.coder.instruction.encode("sell", {
            amount: new bn.bnExports.BN(sellTokenAmount.toString()),
            minSolOutput: new bn.bnExports.BN(sellAmountWithSlippage.toString())
        });
        const sellAccounts = [
            { pubkey: globalAccountPDA, isSigner: false, isWritable: false },
            { pubkey: globalAccount.feeRecipient, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedUser, isSigner: false, isWritable: true },
            { pubkey: sellerPublicKey, isSigner: true, isWritable: true },
            { pubkey: new web3_js.PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: creatorVaultPda, isSigner: false, isWritable: true },
            { pubkey: new web3_js.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: eventAuthorityPda, isSigner: false, isWritable: false },
            { pubkey: this.program.programId, isSigner: false, isWritable: false }
        ];
        let ix = new web3_js.TransactionInstruction({
            keys: sellAccounts,
            programId: this.program.programId,
            data: sellInstructionData
        });
        transaction.add(ix);
        // Send the transaction
        return await util.sendTx(this.connection, transaction, sellerPublicKey, [seller], priorityFees, commitment, finality);
    }
    //create token instructions
    async getCreateInstructions(creator, name, symbol, uri, mint) {
        const mplTokenMetadata = new web3_js.PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID);
        const [metadataPDA] = web3_js.PublicKey.findProgramAddressSync([
            Buffer.from(METADATA_SEED),
            mplTokenMetadata.toBuffer(),
            mint.publicKey.toBuffer(),
        ], mplTokenMetadata);
        const bondingCurvePDA = this.getBondingCurvePDA(mint.publicKey);
        const associatedBondingCurve = await splToken.getAssociatedTokenAddress(mint.publicKey, bondingCurvePDA, true);
        // Get mint authority PDA
        const [mintAuthorityPDA] = web3_js.PublicKey.findProgramAddressSync([Buffer.from(MINT_AUTHORITY_SEED)], this.program.programId);
        // Get global account PDA
        const globalAccountPDA = this.getGlobalAccountPda();
        // Get event authority PDA
        const eventAuthorityPda = this.getEventAuthorityPda();
        // Create instruction manually to avoid typing issues
        const createInstructionData = this.program.coder.instruction.encode("create", {
            name: name,
            symbol: symbol,
            uri: uri,
            creator: creator
        });
        const createAccounts = [
            { pubkey: mint.publicKey, isSigner: true, isWritable: true }, // mint
            { pubkey: mintAuthorityPDA, isSigner: false, isWritable: false }, // mint_authority
            { pubkey: bondingCurvePDA, isSigner: false, isWritable: true }, // bonding_curve
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true }, // associated_bonding_curve
            { pubkey: globalAccountPDA, isSigner: false, isWritable: false }, // global
            { pubkey: mplTokenMetadata, isSigner: false, isWritable: false }, // mpl_token_metadata
            { pubkey: metadataPDA, isSigner: false, isWritable: true }, // metadata
            { pubkey: creator, isSigner: true, isWritable: true }, // user
            { pubkey: new web3_js.PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false }, // system_program
            { pubkey: new web3_js.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false }, // token_program
            { pubkey: new web3_js.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID), isSigner: false, isWritable: false }, // associated_token_program
            { pubkey: new web3_js.PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false }, // rent
            { pubkey: eventAuthorityPda, isSigner: false, isWritable: false }, // event_authority
            { pubkey: this.program.programId, isSigner: false, isWritable: false } // program
        ];
        const createInstruction = new web3_js.TransactionInstruction({
            keys: createAccounts,
            programId: this.program.programId,
            data: createInstructionData
        });
        return new web3_js.Transaction().add(createInstruction);
    }
    async getBuyInstructionsBySolAmount(buyer, mint, buyAmountSol, slippageBasisPoints = 500n, commitment = util.DEFAULT_COMMITMENT) {
        let bondingCurveAccount = await this.getBondingCurveAccount(mint, commitment);
        if (!bondingCurveAccount) {
            throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
        }
        let buyAmount = bondingCurveAccount.getBuyPrice(buyAmountSol);
        let buyAmountWithSlippage = util.calculateWithSlippageBuy(buyAmountSol, slippageBasisPoints);
        let globalAccount = await this.getGlobalAccount(commitment);
        return await this.getBuyInstructions(buyer, mint, globalAccount.feeRecipient, buyAmount, buyAmountWithSlippage);
    }
    //buy
    async getBuyInstructions(buyer, mint, feeRecipient, amount, solAmount, commitment = util.DEFAULT_COMMITMENT) {
        const bondingCurvePDA = this.getBondingCurvePDA(mint);
        const associatedBondingCurve = await splToken.getAssociatedTokenAddress(mint, bondingCurvePDA, true);
        const associatedUser = await splToken.getAssociatedTokenAddress(mint, buyer, false);
        // Get bonding curve account to extract creator
        const bondingCurveAccountInfo2 = await this.connection.getAccountInfo(bondingCurvePDA);
        if (!bondingCurveAccountInfo2) {
            throw new Error("Bonding curve account not found");
        }
        // Get bonding curve creator using helper function
        const bondingCurveCreator = await this.getBondingCurveCreator(bondingCurvePDA, commitment);
        // Derive creator_vault PDA using bonding curve creator (not user public key)
        const creatorVaultPda = this.getCreatorVaultPda(bondingCurveCreator);
        // Get event authority PDA
        const eventAuthorityPda = this.getEventAuthorityPda();
        let transaction = new web3_js.Transaction();
        try {
            await splToken.getAccount(this.connection, associatedUser, commitment);
        }
        catch (e) {
            transaction.add(splToken.createAssociatedTokenAccountInstruction(buyer, associatedUser, buyer, mint));
        }
        // Get global account PDA
        const globalAccountPDA = this.getGlobalAccountPda();
        // Create buy instruction using Anchor coder
        const buyInstructionData = this.program.coder.instruction.encode("buy", {
            amount: new bn.bnExports.BN(amount.toString()),
            maxSolCost: new bn.bnExports.BN(solAmount.toString())
        });
        const buyAccounts = [
            { pubkey: globalAccountPDA, isSigner: false, isWritable: false },
            { pubkey: feeRecipient, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedUser, isSigner: false, isWritable: true },
            { pubkey: buyer, isSigner: true, isWritable: true },
            { pubkey: new web3_js.PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: new web3_js.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: creatorVaultPda, isSigner: false, isWritable: true },
            { pubkey: eventAuthorityPda, isSigner: false, isWritable: false },
            { pubkey: this.program.programId, isSigner: false, isWritable: false }
        ];
        transaction.add(new web3_js.TransactionInstruction({
            keys: buyAccounts,
            programId: this.program.programId,
            data: buyInstructionData
        }));
        return transaction;
    }
    //sell
    async getSellInstructionsByTokenAmount(seller, mint, sellTokenAmount, slippageBasisPoints = 500n, commitment = util.DEFAULT_COMMITMENT) {
        let bondingCurveAccount = await this.getBondingCurveAccount(mint, commitment);
        if (!bondingCurveAccount) {
            throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
        }
        let globalAccount = await this.getGlobalAccount(commitment);
        // Get exact price from bonding curve
        const minSolOutput = bondingCurveAccount.getSellPrice(sellTokenAmount, globalAccount.feeBasisPoints);
        // Calculate with percentage-based slippage rather than a fixed value reduction
        let sellAmountWithSlippage = util.calculateWithSlippageSell(minSolOutput, slippageBasisPoints);
        // Make sure we don't go below 1 for very small amounts
        if (sellAmountWithSlippage < 1n) {
            sellAmountWithSlippage = 1n;
        }
        console.log(`getSellInstructionsByTokenAmount - amount=${sellTokenAmount}, exactOutput=${minSolOutput}, withSlippage=${sellAmountWithSlippage}`);
        return await this.getSellInstructions(seller, mint, globalAccount.feeRecipient, sellTokenAmount, sellAmountWithSlippage);
    }
    async getSellInstructions(seller, mint, feeRecipient, amount, minSolOutput, commitment = util.DEFAULT_COMMITMENT) {
        const bondingCurvePDA = this.getBondingCurvePDA(mint);
        const associatedBondingCurve = await splToken.getAssociatedTokenAddress(mint, bondingCurvePDA, true);
        const associatedUser = await splToken.getAssociatedTokenAddress(mint, seller, false);
        let transaction = new web3_js.Transaction();
        // Get global account PDA
        const globalAccountPDA = this.getGlobalAccountPda();
        const bondingCurveCreator = await this.getBondingCurveCreator(bondingCurvePDA, commitment);
        // Derive creator_vault PDA using bonding curve creator
        const creatorVaultPda = this.getCreatorVaultPda(bondingCurveCreator);
        // Get event authority PDA
        const eventAuthorityPda = this.getEventAuthorityPda();
        // Check IDL for the correct order of accounts
        const accounts = [
            { pubkey: globalAccountPDA, isSigner: false, isWritable: false },
            { pubkey: feeRecipient, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedUser, isSigner: false, isWritable: true },
            { pubkey: seller, isSigner: true, isWritable: true },
            { pubkey: new web3_js.PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: new web3_js.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: new web3_js.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: creatorVaultPda, isSigner: false, isWritable: true },
            { pubkey: eventAuthorityPda, isSigner: false, isWritable: false },
            { pubkey: this.program.programId, isSigner: false, isWritable: false }
        ];
        // Create the sell instruction with BN values for amount and minSolOutput
        const instructionData = this.program.coder.instruction.encode("sell", {
            amount: new bn.bnExports.BN(amount.toString()),
            minSolOutput: new bn.bnExports.BN(minSolOutput.toString())
        });
        // Add the instruction to the transaction
        transaction.add(new web3_js.TransactionInstruction({
            keys: accounts,
            programId: this.program.programId,
            data: instructionData
        }));
        return transaction;
    }
    async getBondingCurveAccount(mint, commitment = util.DEFAULT_COMMITMENT) {
        const tokenAccount = await this.connection.getAccountInfo(this.getBondingCurvePDA(mint), commitment);
        if (!tokenAccount) {
            return null;
        }
        return bondingCurveAccount.BondingCurveAccount.fromBuffer(tokenAccount.data);
    }
    async getGlobalAccount(commitment = util.DEFAULT_COMMITMENT) {
        const globalAccountPDA = this.getGlobalAccountPda();
        const tokenAccount = await this.connection.getAccountInfo(globalAccountPDA, commitment);
        return globalAccount.GlobalAccount.fromBuffer(tokenAccount.data);
    }
    getBondingCurvePDA(mint) {
        return web3_js.PublicKey.findProgramAddressSync([Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()], this.program.programId)[0];
    }
    async getBondingCurveCreator(bondingCurvePDA, commitment = util.DEFAULT_COMMITMENT) {
        const bondingAccountInfo = await this.connection.getAccountInfo(bondingCurvePDA, commitment);
        if (!bondingAccountInfo) {
            throw new Error("Bonding curve account not found");
        }
        // Creator is at offset 49 (after 8 bytes discriminator, 5 u64 fields, and 1 byte boolean)
        const creatorBytes = bondingAccountInfo.data.subarray(49, 49 + 32);
        return new web3_js.PublicKey(creatorBytes);
    }
    async createTokenMetadata(create) {
        // Validate file
        if (!(create.file instanceof Blob)) {
            throw new Error('File must be a Blob or File object');
        }
        let formData = new FormData();
        formData.append("file", create.file, 'image.png'); // Add filename
        formData.append("name", create.name);
        formData.append("symbol", create.symbol);
        formData.append("description", create.description);
        formData.append("twitter", create.twitter || "");
        formData.append("telegram", create.telegram || "");
        formData.append("website", create.website || "");
        formData.append("showName", "true");
        try {
            const request = await fetch("https://pump.fun/api/ipfs", {
                method: "POST",
                headers: {
                    'Accept': 'application/json',
                },
                body: formData,
                credentials: 'same-origin'
            });
            if (request.status === 500) {
                // Try to get more error details
                const errorText = await request.text();
                throw new Error(`Server error (500): ${errorText || 'No error details available'}`);
            }
            if (!request.ok) {
                throw new Error(`HTTP error! status: ${request.status}`);
            }
            const responseText = await request.text();
            if (!responseText) {
                throw new Error('Empty response received from server');
            }
            try {
                return JSON.parse(responseText);
            }
            catch (e) {
                throw new Error(`Invalid JSON response: ${responseText}`);
            }
        }
        catch (error) {
            console.error('Error in createTokenMetadata:', error);
            throw error;
        }
    }
    getCreatorVaultPda(creator) {
        return web3_js.PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], this.program.programId)[0];
    }
    getGlobalAccountPda() {
        return web3_js.PublicKey.findProgramAddressSync([Buffer.from(GLOBAL_ACCOUNT_SEED)], this.program.programId)[0];
    }
    getEventAuthorityPda() {
        return web3_js.PublicKey.findProgramAddressSync([Buffer.from(EVENT_AUTHORITY_SEED)], this.program.programId)[0];
    }
    async createAssociatedTokenAccountIfNeeded(payer, owner, mint, transaction, commitment = util.DEFAULT_COMMITMENT) {
        const associatedTokenAccount = await splToken.getAssociatedTokenAddress(mint, owner, false);
        try {
            await splToken.getAccount(this.connection, associatedTokenAccount, commitment);
        }
        catch (e) {
            transaction.add(splToken.createAssociatedTokenAccountInstruction(payer, associatedTokenAccount, owner, mint));
        }
        return associatedTokenAccount;
    }
    //EVENTS
    addEventListener(eventType, callback) {
        return this.program.addEventListener(eventType, (event, slot, signature) => {
            let processedEvent;
            switch (eventType) {
                case "createEvent":
                    processedEvent = events.toCreateEvent(event);
                    callback(processedEvent, slot, signature);
                    break;
                case "tradeEvent":
                    processedEvent = events.toTradeEvent(event);
                    callback(processedEvent, slot, signature);
                    break;
                case "completeEvent":
                    processedEvent = events.toCompleteEvent(event);
                    callback(processedEvent, slot, signature);
                    break;
                case "setParamsEvent":
                    processedEvent = events.toSetParamsEvent(event);
                    callback(processedEvent, slot, signature);
                    break;
                default:
                    console.error("Unhandled event type:", eventType);
            }
        });
    }
    removeEventListener(eventId) {
        this.program.removeEventListener(eventId);
    }
}

exports.BONDING_CURVE_SEED = BONDING_CURVE_SEED;
exports.DEFAULT_DECIMALS = DEFAULT_DECIMALS;
exports.EVENT_AUTHORITY_SEED = EVENT_AUTHORITY_SEED;
exports.GLOBAL_ACCOUNT_SEED = GLOBAL_ACCOUNT_SEED;
exports.METADATA_SEED = METADATA_SEED;
exports.MINT_AUTHORITY_SEED = MINT_AUTHORITY_SEED;
exports.PumpFunSDK = PumpFunSDK;
//# sourceMappingURL=pumpfun.cjs.map
