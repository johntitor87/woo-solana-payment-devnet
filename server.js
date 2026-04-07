// 1. Imports (TOP)
const express = require('express');
const bodyParser = require('body-parser');
const { Connection, PublicKey } = require('@solana/web3.js');

// 2. App setup
const app = express();
app.use(bodyParser.json());

// 3. Routes (simple ones first)
app.get("/", (req, res) => {
  res.send("Zoo Solana Checkout API running");
});

app.get("/health", (req, res) => {
  res.send("OK");
});

// 4. Connection (ONLY ONCE)
const connection = new Connection("https://api.devnet.solana.com", "confirmed");

// 5. Helper functions
async function waitForFinalizedTx(signature) {
  const maxRetries = 8;
  const delay = 1500;

  for (let i = 0; i < maxRetries; i++) {
    const tx = await connection.getParsedTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0
    });

    if (tx) {
      console.log(`[ZOO] TX found on attempt ${i + 1}`);
      return tx;
    }

    console.log(`[ZOO] Waiting for tx... attempt ${i + 1}`);
    await new Promise(res => setTimeout(res, delay));
  }

  return null;
}

function expectedAmountToRawBigInt(expectedAmount, decimals) {
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0) return null;

  const str = String(expectedAmount);
  if (!/^\d+(\.\d+)?$/.test(str)) return null;

  const [whole, frac = ""] = str.split(".");
  const wholeBig = BigInt(whole);
  const factor = 10n ** BigInt(dec);

  const fracPadded = frac.padEnd(dec, "0");
  return wholeBig * factor + BigInt(fracPadded || "0");
}

// 6. State
const usedSignatures = new Set();
const inFlightSignatures = new Set();

const DEFAULT_ZOO_MINT = process.env.ZOO_MINT_ADDRESS || process.env.ZOO_MINT || 'FKkgeZxYLxoZ1WciErXKbeNTf5CB296zv51euCR7MZN3';
const DEFAULT_SHOP_WALLET = process.env.SHOP_WALLET || process.env.ZOO_SHOP_WALLET || '6XPtpWPgFfoxRcLCwxTKXawrvzeYjviw4EYpSSLW42gc';

// 7. MAIN ROUTE (THIS is where verification logic lives)
app.post("/verify-devnet-payment", async (req, res) => {
  let addedToInFlight = false;
  
  try {
    const { signature, expectedAmount } = req.body || {};

    if (!signature) {
      return res.status(400).json({ success: false, message: "Missing signature" });
    }

    if (usedSignatures.has(signature)) {
      return res.json({ success: false, message: "Already used" });
    }

    if (inFlightSignatures.has(signature)) {
      return res.json({ success: false, message: "Processing" });
    }

    inFlightSignatures.add(signature);
    addedToInFlight = true;

    // Use waitForFinalizedTx to wait for the transaction
    const tx = await waitForFinalizedTx(signature);

    if (!tx || !tx.meta || tx.meta.err) {
      return res.json({ success: false, message: "Invalid transaction" });
    }

    let valid = false;

    for (const ix of tx.transaction.message.instructions) {
      const info = ix?.parsed?.info;
      if (!info) continue;

      if (info.mint !== DEFAULT_ZOO_MINT) continue;

      const destinationMatches =
        info.destination === DEFAULT_SHOP_WALLET ||
        info.destinationOwner === DEFAULT_SHOP_WALLET;

      if (!destinationMatches) continue;

      const decimals = info.tokenAmount?.decimals;
      if (typeof decimals !== "number") continue;

      const rawAmount = BigInt(info.amount);
      const expectedRaw = expectedAmountToRawBigInt(expectedAmount, decimals);

      if (rawAmount === expectedRaw) {
        valid = true;
        break;
      }
    }

    if (valid) {
      usedSignatures.add(signature);
    }

    res.json({ success: valid });

  } catch (err) {
    console.error(err);
    res.json({ success: false });
  } finally {
    const signature = req?.body?.signature;
    if (addedToInFlight && typeof signature === "string") {
      inFlightSignatures.delete(signature);
    }
  }
});

// 8. Start server (BOTTOM)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});