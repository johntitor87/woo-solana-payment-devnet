const express = require('express');
const bodyParser = require('body-parser');
const { Connection, PublicKey } = require('@solana/web3.js');

const app = express();
app.use(bodyParser.json());

// Root route (Render will show "Cannot GET /" without this)
app.get("/", (req, res) => {
  res.send("Zoo Solana Checkout API running");
});

// Health check (used by Render health checks)
app.get("/health", (req, res) => {
  res.send("OK");
});

// Devnet connection
const connection = new Connection("https://api.devnet.solana.com", "confirmed");

// Devnet defaults (used when the frontend doesn't send these fields).
const DEFAULT_ZOO_MINT = process.env.ZOO_MINT_ADDRESS || process.env.ZOO_MINT || 'FKkgeZxYLxoZ1WciErXKbeNTf5CB296zv51euCR7MZN3';
const DEFAULT_SHOP_WALLET = process.env.SHOP_WALLET || process.env.ZOO_SHOP_WALLET || '6XPtpWPgFfoxRcLCwxTKXawrvzeYjviw4EYpSSLW42gc';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Convert a decimal string/number like "1.23" into base-units raw integer (BigInt).
// Example: decimals=6 => "1.23" => 1230000n
function expectedAmountToRawBigInt(expectedAmount, decimals) {
  const dec = Number(decimals);
  if (!Number.isFinite(dec) || !Number.isInteger(dec) || dec < 0) return null;

  const str = String(expectedAmount).trim();
  // If it contains scientific notation, fall back (rare in browser checkout amounts).
  if (/e/i.test(str)) {
    const pow = Math.pow(10, dec);
    const num = Number(str);
    if (!Number.isFinite(num)) return null;
    return BigInt(Math.round(num * pow));
  }

  if (!/^\d+(\.\d+)?$/.test(str)) return null;

  const [wholePart, fracPartRaw = ""] = str.split(".");
  const whole = BigInt(wholePart);
  const pow10 = 10n ** BigInt(dec);

  if (fracPartRaw.length <= dec) {
    const fracPadded = fracPartRaw.padEnd(dec, "0");
    return whole * pow10 + BigInt(fracPadded || "0");
  }

  // Round half-up if there are more fractional digits than supported decimals.
  const fracTrunc = fracPartRaw.slice(0, dec);
  const nextDigit = fracPartRaw[dec] ?? "0";
  let raw = whole * pow10 + BigInt((fracTrunc || "0").padEnd(dec, "0"));
  if (nextDigit >= "5") raw += 1n;
  return raw;
}

async function getParsedTransactionWithRetry(signature, opts = {}) {
  const {
    maxAttempts = 3,
    attemptDelayMs = 1000,
    perAttemptTimeoutMs = 4000,
  } = opts;

  let tx = null;
  for (let i = 0; i < maxAttempts; i++) {
    tx = await Promise.race([
      connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 }).catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(null), perAttemptTimeoutMs)),
    ]);

    if (tx) break;
    await sleep(attemptDelayMs);
  }
  return tx;
}

// Minimal replay protection (in-memory).
// Note: resets on server restart; move to a DB/Redis for production.
const usedSignatures = new Set();
const inFlightSignatures = new Set();

async function handleVerify(req, res) {
  let addedToInFlight = false;
  try {
    const {
      signature,
      expectedAmount,
      shopWallet: requestShopWallet,
      mint: requestMint,
    } = req.body || {};

    if (!signature || typeof signature !== "string") {
      return res.status(400).json({ success: false, message: "Missing signature" });
    }

    if (usedSignatures.has(signature)) {
      return res.json({ success: false, message: "Signature already used" });
    }
    if (inFlightSignatures.has(signature)) {
      return res.json({ success: false, message: "Signature already being processed" });
    }
    inFlightSignatures.add(signature);
    addedToInFlight = true;

    if (expectedAmount === undefined || expectedAmount === null || Number.isNaN(Number(expectedAmount))) {
      return res.status(400).json({ success: false, message: "Missing expectedAmount" });
    }

    // Allow the frontend to omit these fields (Woo plugin often only sends signature + expectedAmount).
    const shopWallet = (typeof requestShopWallet === "string" && requestShopWallet)
      ? requestShopWallet
      : DEFAULT_SHOP_WALLET;
    const mint = (typeof requestMint === "string" && requestMint)
      ? requestMint
      : DEFAULT_ZOO_MINT;

    if (!shopWallet || typeof shopWallet !== "string") {
      return res.status(400).json({ success: false, message: "Missing shopWallet" });
    }
    if (!mint || typeof mint !== "string") {
      return res.status(400).json({ success: false, message: "Missing mint" });
    }

    // Basic pubkey validation (will throw on invalid base58)
    try {
      // shopWallet may be a wallet OR token account address; both are valid pubkeys.
      new PublicKey(shopWallet);
      new PublicKey(mint);
    } catch {
      return res.status(400).json({ success: false, message: "Invalid shopWallet or mint" });
    }

    // Require finalized before parsing/verifying.
    const status = await connection.getSignatureStatuses([signature]);
    const confirmation = status?.value?.[0];
    if (!confirmation || confirmation.confirmationStatus !== "finalized") {
      return res.json({ success: false, message: "Transaction not finalized" });
    }

    // Retry fetch to handle RPC lag / not-yet-indexed transactions.
    const tx = await getParsedTransactionWithRetry(signature);

    if (!tx || !tx.meta || tx.meta.err) {
      return res.json({ success: false, message: "Invalid transaction" });
    }

    let valid = false;

    for (const ix of tx.transaction.message.instructions) {
      const info = ix?.parsed?.info;
      if (!info) continue;

      // Only validate SPL-token parsed transfers that include a mint (so we can enforce `mint`).
      const instructionMint = typeof info.mint === "string" ? info.mint : null;
      if (!instructionMint || instructionMint !== mint) continue;

      const destinationMatches =
        info.destination === shopWallet || info.destinationOwner === shopWallet;
      if (!destinationMatches) continue;

      const decimals = info.tokenAmount?.decimals ?? info.decimals ?? null;
      if (typeof decimals !== "number") continue;

      // For SPL token transfers, `info.amount` is the raw integer amount in base units.
      if (info.amount === undefined || info.amount === null) continue;
      let rawAmountBigInt;
      try {
        rawAmountBigInt = BigInt(String(info.amount));
      } catch {
        continue;
      }

      const expectedRawBigInt = expectedAmountToRawBigInt(expectedAmount, decimals);
      if (expectedRawBigInt === null) continue;

      if (rawAmountBigInt === expectedRawBigInt) {
        valid = true;
        break;
      }
    }

    if (valid) {
      usedSignatures.add(signature);
    }
    res.json({ success: valid });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: "Error verifying transaction" });
  } finally {
    const signature = req?.body?.signature;
    if (addedToInFlight && typeof signature === "string") {
      inFlightSignatures.delete(signature);
    }
  }
}

// Keep both routes for compatibility with different frontend configs.
app.post("/verify-devnet-payment", handleVerify);
app.post("/verify-zoo-payment", handleVerify);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
