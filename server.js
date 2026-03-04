const express = require('express');
const bodyParser = require('body-parser');
const { Connection, PublicKey } = require('@solana/web3.js');

const app = express();
app.use(bodyParser.json());

// Devnet connection
const connection = new Connection("https://api.devnet.solana.com", "confirmed");

app.post("/verify-devnet-payment", async (req, res) => {
  try {
    const { signature, expectedAmount, shopWallet, mint } = req.body;

    const tx = await connection.getParsedTransaction(signature);
    if (!tx || !tx.meta || tx.meta.err) {
      return res.json({ success: false, message: "Invalid transaction" });
    }

    let valid = false;

    for (const ix of tx.transaction.message.instructions) {
      if (ix.parsed?.info?.destination === shopWallet) {
        const transferAmount = ix.parsed.info.amount / Math.pow(10, 9); // Adjust for ZOO decimals
        if (transferAmount === expectedAmount) {
          valid = true;
          break;
        }
      }
    }

    res.json({ success: valid });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: "Error verifying transaction" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
