// server.js - Woo ZOO Token Verification (Free RPC + Auto-Poll)
const express = require('express');
const cors = require('cors');
const { Connection, clusterApiUrl, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

// ------------------ CONFIG ------------------
const PORT = process.env.PORT || 3000;
const ZOO_MINT = process.env.ZOO_MINT || process.env.ZOO_MINT_ADDRESS || 'FKkgeZxYLxoZ1WciErXKbeNTf5CB296zv51euCR7MZN3';
const MERCHANT_WALLET = process.env.MERCHANT_WALLET || process.env.SHOP_WALLET || process.env.ZOO_SHOP_WALLET || 'YOUR_RECEIVING_WALLET_HERE';
const SIGNATURE_EXPIRATION_SEC = parseInt(process.env.SIGNATURE_EXPIRATION_SEC || '600', 10); // 10 min
const WOO_AJAX_URL = process.env.WOO_AJAX_URL || process.env.WORDPRESS_AJAX_URL || 'https://your-wordpress-site.com/wp-admin/admin-ajax.php';

// In-memory store for demo (replace with DB / pending_zoo_payments for production)
const pendingTransactions = new Map();

// ------------------ LOGGING ------------------
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'zoo-payments.log' })
  ]
});

// ------------------ EXPRESS SETUP ------------------
const app = express();
app.use(cors());
app.use(express.json());

// ------------------ RATE LIMITER ------------------
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/verify-zoo-payment', limiter);

// ------------------ RPC CONNECTIONS ------------------
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'finalized');
const devnetConnection = new Connection('https://api.devnet.solana.com', 'confirmed');

app.use('/verify-devnet-payment', limiter);

// ------------------ VERIFY DEVNET PAYMENT ------------------
app.post('/verify-devnet-payment', async (req, res) => {
  try {
    const { signature, expectedAmount, shopWallet, mint } = req.body;

    if (!signature || expectedAmount == null || !shopWallet || !mint) {
      return res.status(400).json({ success: false, error: 'Missing data' });
    }

    const tx = await devnetConnection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0
    });

    if (!tx || !tx.meta || tx.meta.err) {
      return res.json({ success: false });
    }

    let valid = false;
    const instructions = tx.transaction?.message?.instructions || [];

    for (const ix of instructions) {
      if (ix.program !== 'spl-token') continue;
      const info = ix.parsed?.info;
      if (!info || ix.parsed?.type !== 'transferChecked') continue;

      const amountMatch = parseFloat(info.tokenAmount?.uiAmount) === parseFloat(expectedAmount);
      const mintMatch = info.mint === mint;

      let destinationMatch = false;
      try {
        const expectedAta = getAssociatedTokenAddressSync(
          new PublicKey(mint),
          new PublicKey(shopWallet)
        );
        destinationMatch = info.destination === expectedAta.toBase58();
      } catch (_) {
        destinationMatch = false;
      }

      if (amountMatch && mintMatch && destinationMatch) {
        valid = true;
        break;
      }
    }

    return res.json({ success: valid });
  } catch (err) {
    logger.error({ event: 'verify_devnet_error', error: err.message });
    return res.status(500).json({ success: false });
  }
});

// ------------------ HEALTH CHECK ------------------
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.json({ status: 'ok', service: 'ZOO verification' }));

// ------------------ VERIFY PAYMENT (store pending, return immediately) ------------------
app.post('/verify-zoo-payment', async (req, res) => {
  try {
    const { signature, order_id, expectedAmount } = req.body;
    if (!signature || !expectedAmount || !order_id) {
      return res.status(400).json({ error: 'Missing data' });
    }

    // Basic signature format check
    if (!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(signature)) {
      return res.status(400).json({ error: 'Invalid signature format' });
    }

    // Anti-replay
    if (pendingTransactions.has(signature)) {
      return res.status(400).json({ error: 'Signature already pending' });
    }

    logger.info({ event: 'verification_attempt', signature, order_id, expectedAmount });

    // Save as pending (cron will verify on-chain and call WordPress)
    pendingTransactions.set(signature, { order_id, expectedAmount, status: 'pending', createdAt: Date.now() });

    return res.json({ success: true, message: 'Transaction pending confirmation' });
  } catch (err) {
    logger.error({ event: 'verify_error', error: err.message });
    return res.status(500).json({ error: 'Server error' });
  }
});

// ------------------ AUTO-POLL FOR FINALIZED ------------------
cron.schedule('*/10 * * * * *', async () => {
  for (const [signature, tx] of pendingTransactions.entries()) {
    if (tx.status !== 'pending') continue;

    try {
      const solTx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (!solTx || !solTx.meta || solTx.meta.err) continue; // not finalized

      // Check transaction age
      const txTime = solTx.blockTime;
      if (!txTime || (Date.now() / 1000 - txTime) > SIGNATURE_EXPIRATION_SEC) {
        pendingTransactions.set(signature, { ...tx, status: 'failed' });
        continue;
      }

      // Validate SPL token transfer
      const instructions = solTx.transaction?.message?.instructions || [];
      let valid = false;
      for (const instr of instructions) {
        if (instr.program !== 'spl-token') continue;
        const info = instr.parsed?.info;
        if (
          instr.parsed?.type === 'transferChecked' &&
          info?.mint === ZOO_MINT &&
          info?.destination === MERCHANT_WALLET &&
          parseFloat(info?.tokenAmount?.uiAmount) === parseFloat(tx.expectedAmount)
        ) {
          valid = true;
          break;
        }
      }

      if (!valid) continue;

      // Mark verified
      pendingTransactions.set(signature, { ...tx, status: 'verified' });
      logger.info({ event: 'transaction_verified', signature, order_id: tx.order_id });

      // Call WooCommerce AJAX
      if (WOO_AJAX_URL) {
        await fetch(WOO_AJAX_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            action: 'wcs_confirm_zoo_payment',
            order_id: String(tx.order_id),
            tx_signature: signature
          })
        });
      }
    } catch (err) {
      logger.error({ event: 'poll_error', signature, error: err.message });
    }
  }
});

// ------------------ START SERVER ------------------
app.listen(PORT, () => {
  console.log(`ZOO verification server running on port ${PORT}`);
});
