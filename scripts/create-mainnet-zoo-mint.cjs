/**
 * Create a new SPL mint on Solana MAINNET and mint an initial supply to your wallet's ATA.
 *
 * Prerequisites:
 *   - A funded mainnet keypair JSON (real SOL for fees + rent).
 *   - Dependencies installed in this folder: npm install
 *
 * Usage (from woo-solana-payment-devnet/):
 *   KEYPAIR_PATH=/path/to/mainnet-authority.json \
 *   INITIAL_SUPPLY_UI=171000000 \
 *   node scripts/create-mainnet-zoo-mint.cjs
 *
 * Vanity mint (use pubkey from solana-keygen grind):
 *   solana-keygen grind --starts-with zoo:1 -o ~/zoo-vanity-mint.json
 *   KEYPAIR_PATH=.../mainnet.json MINT_KEYPAIR_PATH=~/zoo-vanity-mint.json INITIAL_SUPPLY_UI=171000000 npm run create-mainnet-mint
 *
 * Optional env:
 *   MINT_KEYPAIR_PATH  (if set, this keypair becomes the mint account; must be unused on-chain)
 *   MAINNET_RPC   (default https://api.mainnet-beta.solana.com)
 *   DECIMALS      (default 9)
 *   FREEZE_PUBKEY (optional base58; omit or empty for no freeze authority)
 *
 * After this: add Metaplex token metadata so Phantom shows name/symbol (separate step).
 */

const fs = require("fs");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const {
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");

async function main() {
  const keypairPath = process.env.KEYPAIR_PATH;
  if (!keypairPath || !fs.existsSync(keypairPath)) {
    console.error("Set KEYPAIR_PATH to an existing keypair JSON file (mainnet-funded).");
    process.exit(1);
  }

  const rpc =
    process.env.MAINNET_RPC || "https://api.mainnet-beta.solana.com";
  const decimals = Math.min(9, Math.max(0, parseInt(process.env.DECIMALS || "9", 10)));
  const initialUiStr = process.env.INITIAL_SUPPLY_UI || "0";
  if (!/^\d+$/.test(initialUiStr)) {
    console.error("INITIAL_SUPPLY_UI must be a non-negative integer string (whole tokens).");
    process.exit(1);
  }

  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new Connection(rpc, "confirmed");

  const balance = await connection.getBalance(payer.publicKey);
  console.log("Payer:", payer.publicKey.toBase58());
  console.log("SOL balance (lamports):", balance);
  if (balance < 50_000_000) {
    console.warn("Warning: low SOL; mint + ATA + mintTo typically need a few million lamports+.");
  }

  let freezeAuthority = null;
  if (process.env.FREEZE_PUBKEY && process.env.FREEZE_PUBKEY.trim()) {
    freezeAuthority = new PublicKey(process.env.FREEZE_PUBKEY.trim());
  }

  let mintKeypair = undefined;
  const mintKpPath = process.env.MINT_KEYPAIR_PATH
    ? process.env.MINT_KEYPAIR_PATH.replace(/^~/, process.env.HOME || "")
    : "";
  if (mintKpPath) {
    if (!fs.existsSync(mintKpPath)) {
      console.error("MINT_KEYPAIR_PATH file not found:", mintKpPath);
      process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(mintKpPath, "utf8"));
    mintKeypair = Keypair.fromSecretKey(Uint8Array.from(raw));
    console.log("\nUsing MINT_KEYPAIR_PATH (vanity) mint pubkey:", mintKeypair.publicKey.toBase58());
  }

  console.log("\nCreating mint on MAINNET (decimals=%s)...", decimals);
  const mintPubkey = await createMint(
    connection,
    payer,
    payer.publicKey,
    freezeAuthority,
    decimals,
    mintKeypair,
    undefined,
    TOKEN_PROGRAM_ID
  );

  console.log("MINT_ADDRESS:", mintPubkey.toBase58());

  const ata = getAssociatedTokenAddressSync(
    mintPubkey,
    payer.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  console.log("SHOP_TOKEN_ACCOUNT (ATA for payer):", ata.toBase58());

  const initialWhole = BigInt(initialUiStr);
  const raw = initialWhole * 10n ** BigInt(decimals);

  if (raw > 0n) {
    console.log("\nMinting INITIAL_SUPPLY_UI=%s (raw %s) to payer ATA...", initialUiStr, raw.toString());
    const ataInfo = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintPubkey,
      payer.publicKey
    );
    const sig = await mintTo(
      connection,
      payer,
      mintPubkey,
      ataInfo.address,
      payer.publicKey,
      raw
    );
    console.log("mintTo signature:", sig);
  } else {
    console.log("\nSkipping mintTo (INITIAL_SUPPLY_UI=0). Create ATA later when you first receive.");
  }

  console.log("\n--- Save for Woo + Render ---");
  console.log(JSON.stringify(
    {
      network: "mainnet-beta",
      mint: mintPubkey.toBase58(),
      mintAuthority: payer.publicKey.toBase58(),
      freezeAuthority: freezeAuthority ? freezeAuthority.toBase58() : null,
      decimals,
      shopWallet: payer.publicKey.toBase58(),
      shopTokenAccount: ata.toBase58(),
      initialSupplyUi: initialUiStr,
    },
    null,
    2
  ));
  console.log("\nNext: publish Metaplex metadata (name/symbol/image) so wallets show ZOO correctly.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
