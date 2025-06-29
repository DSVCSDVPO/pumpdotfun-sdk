import { Transaction, ComputeBudgetProgram, SendTransactionError, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const DEFAULT_COMMITMENT = "finalized";
const DEFAULT_FINALITY = "finalized";
const calculateWithSlippageBuy = (amount, basisPoints) => {
    return amount + (amount * basisPoints) / 10000n;
};
function calculateWithSlippageSell(amount, slippageBasisPoints = 500n) {
    // Actually use the slippage basis points for calculation
    const reduction = Math.max(1, Number((amount * slippageBasisPoints) / 10000n));
    return amount - BigInt(reduction);
}
async function sendTx(connection, tx, payer, signers, priorityFees, commitment = DEFAULT_COMMITMENT, finality = DEFAULT_FINALITY) {
    let newTx = new Transaction();
    if (priorityFees) {
        const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
            units: priorityFees.unitLimit,
        });
        const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFees.unitPrice,
        });
        newTx.add(modifyComputeUnits);
        newTx.add(addPriorityFee);
    }
    newTx.add(tx);
    let versionedTx = await buildVersionedTx(connection, payer, newTx, commitment);
    versionedTx.sign(signers);
    try {
        const sig = await connection.sendTransaction(versionedTx, {
            skipPreflight: false,
        });
        console.log("sig:", `https://solscan.io/tx/${sig}`);
        let txResult = await getTxDetails(connection, sig, commitment, finality);
        if (!txResult) {
            return {
                success: false,
                error: "Transaction failed",
            };
        }
        return {
            success: true,
            signature: sig,
            results: txResult,
        };
    }
    catch (e) {
        if (e instanceof SendTransactionError) {
            let ste = e;
            console.log("SendTransactionError" + await ste.getLogs(connection));
        }
        else {
            console.error(e);
        }
        return {
            error: e,
            success: false,
        };
    }
}
const buildVersionedTx = async (connection, payer, tx, commitment = DEFAULT_COMMITMENT) => {
    const blockHash = (await connection.getLatestBlockhash(commitment))
        .blockhash;
    let messageV0 = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockHash,
        instructions: tx.instructions,
    }).compileToV0Message();
    return new VersionedTransaction(messageV0);
};
const getTxDetails = async (connection, sig, commitment = DEFAULT_COMMITMENT, finality = DEFAULT_FINALITY) => {
    const latestBlockHash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: sig,
    }, commitment);
    return connection.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: finality,
    });
};

export { DEFAULT_COMMITMENT, DEFAULT_FINALITY, buildVersionedTx, calculateWithSlippageBuy, calculateWithSlippageSell, getTxDetails, sendTx };
//# sourceMappingURL=util.mjs.map
