const express = require("express");
const bodyParser = require("body-parser");
const { Connection, PublicKey } = require("@solana/web3.js");
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require("@solana/spl-token");

const app = express();
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("Zoo Solana Checkout API running");
});

app.get("/health", (req, res) => {
  res.send("OK");
});

/** Devnet default; override on Render for mainnet (see SOLANA_RPC_URL / SOLANA_NETWORK). */
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  process.env.RPC_URL ||
  (String(process.env.SOLANA_NETWORK || "").toLowerCase() === "mainnet-beta"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com");

const connection = new Connection(RPC_URL, "confirmed");

// 🔑 Set via env on Render, or use these devnet defaults
const DEFAULT_ZOO_MINT =
  process.env.ZOO_MINT_ADDRESS || process.env.ZOO_MINT || "FKkgeZxYLxoZ1WciErXKbeNTf5CB296zv51euCR7MZN3";
const DEFAULT_SHOP_WALLET =
  process.env.SHOP_WALLET || process.env.ZOO_SHOP_WALLET || "6XPtpWPgFfoxRcLCwxTKXawrvzeYjviw4EYpSSLW42gc";

const ZOO_TOKEN_MINT = new PublicKey(DEFAULT_ZOO_MINT);
const RECEIVER_WALLET = new PublicKey(DEFAULT_SHOP_WALLET);

/** Receiving side of the SPL transfer is the shop's ATA for this mint — NOT the wallet pubkey. */
let RECEIVER_TOKEN_ACCOUNT_BASE58;
try {
  RECEIVER_TOKEN_ACCOUNT_BASE58 = getAssociatedTokenAddressSync(
    ZOO_TOKEN_MINT,
    RECEIVER_WALLET,
    false,
    TOKEN_PROGRAM_ID
  ).toBase58();
} catch (e) {
  console.error("[ZOO] Failed to derive receiver ATA:", e);
  RECEIVER_TOKEN_ACCOUNT_BASE58 = null;
}

/** Confirms this codebase is live (very old/stub deploys return 404 here). */
app.get("/api-meta", (req, res) => {
  res.json({
    ok: true,
    verifier: "woo-solana-payment-devnet",
    version: 2,
    rpcUrl: RPC_URL,
    mint: ZOO_TOKEN_MINT.toBase58(),
    shopWallet: RECEIVER_WALLET.toBase58(),
    shopTokenAccount: RECEIVER_TOKEN_ACCOUNT_BASE58 || null,
  });
});

const SPL_TOKEN_PROGRAM_ID_STR = TOKEN_PROGRAM_ID.toBase58();

// retry helper (finalized commitment inside getParsedTransaction)
async function getTxWithRetry(signature, retries = 8, delay = 1500) {
  for (let i = 0; i < retries; i++) {
    const tx = await connection
      .getParsedTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .catch(() => null);

    if (tx && !tx.meta?.err) return tx;

    console.log(`[ZOO] Waiting for tx... attempt ${i + 1}/${retries}`);
    await new Promise((res) => setTimeout(res, delay));
  }
  return null;
}

function isSplTokenTransferIx(ix) {
  const t = ix?.parsed?.type;
  if (t !== "transfer" && t !== "transferChecked") return false;
  if (ix.program === "spl-token") return true;
  const pid = ix.programId?.toBase58?.() || ix.programId;
  return pid === SPL_TOKEN_PROGRAM_ID_STR;
}

/** Outer + inner — many wallets put the token ix in inner instructions. */
function collectInstructions(tx) {
  const out = [];
  const msg = tx.transaction?.message;
  if (msg?.instructions?.length) {
    for (const ix of msg.instructions) out.push(ix);
  }
  const inner = tx.meta?.innerInstructions;
  if (Array.isArray(inner)) {
    for (const group of inner) {
      if (group?.instructions?.length) {
        for (const ix of group.instructions) out.push(ix);
      }
    }
  }
  return out;
}

function findSplTransfer(ixs) {
  return ixs.find((ix) => isSplTokenTransferIx(ix));
}

// Minimal replay protection (in-memory)
const usedSignatures = new Set();

function jsonFail(res, status, message, extra = {}) {
  return res.status(status).json({
    success: false,
    message,
    error: message,
    ...extra,
  });
}

function jsonOk(res, data) {
  return res.json({ success: true, ...data });
}

async function handleVerify(req, res) {
  try {
    const {
      signature,
      expectedAmount,
      walletAddress,
      shopWallet: requestShopWallet,
      mint: requestMint,
    } = req.body || {};

    const mintStr = typeof requestMint === "string" && requestMint ? requestMint : ZOO_TOKEN_MINT.toBase58();
    const shopStr =
      typeof requestShopWallet === "string" && requestShopWallet ? requestShopWallet : RECEIVER_WALLET.toBase58();

    let mintPk;
    let shopPk;
    try {
      mintPk = new PublicKey(mintStr);
      shopPk = new PublicKey(shopStr);
    } catch {
      return jsonFail(res, 400, "Invalid mint or shop wallet");
    }

    let receiverAtaBase58;
    try {
      receiverAtaBase58 = getAssociatedTokenAddressSync(mintPk, shopPk, false, TOKEN_PROGRAM_ID).toBase58();
    } catch {
      return jsonFail(res, 400, "Could not derive receiver token account");
    }

    console.log("[ZOO] Verifying:", signature, { expectedAmount, mint: mintStr, shop: shopStr });

    if (!signature || typeof signature !== "string") {
      return jsonFail(res, 400, "Missing signature");
    }

    if (usedSignatures.has(signature)) {
      return res.status(200).json({ success: false, message: "Signature already used", error: "Signature already used" });
    }

    if (expectedAmount === undefined || expectedAmount === null || Number.isNaN(Number(expectedAmount))) {
      return jsonFail(res, 400, "Missing expectedAmount");
    }

    const tx = await getTxWithRetry(signature);

    if (!tx) {
      return jsonFail(res, 400, "Transaction not found");
    }

    const instructions = collectInstructions(tx);
    const transferIx = findSplTransfer(instructions);

    if (!transferIx) {
      console.log("[ZOO] No SPL transfer instruction found");
      return jsonFail(res, 400, "No token transfer found");
    }

    const info = transferIx.parsed.info;
    console.log("[ZOO] Transfer info:", JSON.stringify(info, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

    // ✅ Validate mint when present (transferChecked). Legacy transfer may omit mint — then destination must be shop ATA.
    if (typeof info.mint === "string" && info.mint !== mintPk.toBase58()) {
      return jsonFail(res, 400, "Wrong token mint");
    }
    if (!info.mint && info.destination !== receiverAtaBase58) {
      return jsonFail(res, 400, "Wrong token mint or destination (legacy transfer)");
    }

    // ✅ Destination: token account for shop (ATA), not the wallet pubkey
    const destOk =
      info.destination === receiverAtaBase58 ||
      info.destination === shopPk.toBase58() ||
      info.destinationOwner === shopPk.toBase58();

    if (!destOk) {
      return jsonFail(res, 400, "Wrong destination wallet", {
        expectedDestinationAta: receiverAtaBase58,
        got: info.destination,
      });
    }

    const decimals =
      typeof info.tokenAmount?.decimals === "number"
        ? info.tokenAmount.decimals
        : typeof info.decimals === "number"
          ? info.decimals
          : 9;

    const rawStr =
      info.amount != null
        ? String(info.amount)
        : info.tokenAmount?.amount != null
          ? String(info.tokenAmount.amount)
          : null;

    if (rawStr == null) {
      return jsonFail(res, 400, "Could not read transfer amount");
    }

    const rawAmount = Number(rawStr);
    const adjustedAmount = rawAmount / Math.pow(10, decimals);

    console.log("[ZOO] Amount raw:", rawAmount);
    console.log("[ZOO] Amount adjusted:", adjustedAmount);
    console.log("[ZOO] Expected:", expectedAmount);

    const expectedNum = Number(expectedAmount);
    const tolerance = 0.000001;

    if (Math.abs(adjustedAmount - expectedNum) > tolerance) {
      return jsonFail(res, 400, "Incorrect amount", {
        received: adjustedAmount,
        expected: expectedNum,
      });
    }

    if (walletAddress && typeof walletAddress === "string" && info.authority && info.authority !== walletAddress) {
      return jsonFail(res, 400, "Sender mismatch");
    }

    usedSignatures.add(signature);

    console.log("[ZOO] ✅ Verification SUCCESS");

    return jsonOk(res, {
      signature,
      amount: adjustedAmount,
    });
  } catch (err) {
    console.error("[ZOO] Verification error:", err);
    return jsonFail(res, 500, "Verification failed");
  }
}

app.post("/verify-devnet-payment", handleVerify);
app.post("/verify-zoo-payment", handleVerify);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`[ZOO] RPC: ${RPC_URL}`);
  console.log(`[ZOO] Mint: ${ZOO_TOKEN_MINT.toBase58()}`);
  console.log(`[ZOO] Shop wallet: ${RECEIVER_WALLET.toBase58()}`);
  console.log(`[ZOO] Shop token account (destination): ${RECEIVER_TOKEN_ACCOUNT_BASE58 || "n/a"}`);
});
