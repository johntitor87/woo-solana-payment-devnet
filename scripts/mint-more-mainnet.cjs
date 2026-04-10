/**
 * Mint additional whole tokens to the payer's ATA for an existing SPL mint (MAINNET).
 *
 * Usage:
 *   KEYPAIR_PATH=~/.config/solana/mainnet.json \
 *   MINT=3mhZ3HZbCzJtRFfHguozaJPfD6rFqAwNxLgNGJkM7gF2 \
 *   ADDITIONAL_UI=170000000 \
 *   node scripts/mint-more-mainnet.cjs
 *
 * Optional: MAINNET_RPC (default https://api.mainnet-beta.solana.com)
 */

const fs = require("fs");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const {
  mintTo,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");

async function main() {
  const keypairPath = process.env.KEYPAIR_PATH;
  if (!keypairPath || !fs.existsSync(keypairPath)) {
    console.error("Set KEYPAIR_PATH to your mint authority keypair JSON.");
    process.exit(1);
  }
  const mintStr = process.env.MINT;
  if (!mintStr) {
    console.error("Set MINT to the token mint address.");
    process.exit(1);
  }
  const additionalUiStr = process.env.ADDITIONAL_UI;
  if (!additionalUiStr || !/^\d+$/.test(additionalUiStr)) {
    console.error("Set ADDITIONAL_UI to whole tokens to mint (non-negative integer string).");
    process.exit(1);
  }

  const rpc =
    process.env.MAINNET_RPC || "https://api.mainnet-beta.solana.com";
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  const mint = new PublicKey(mintStr);
  const connection = new Connection(rpc, "confirmed");

  const info = await connection.getParsedAccountInfo(mint);
  const parsed = info.value?.data?.parsed;
  const decimals =
    parsed?.info?.decimals != null ? parsed.info.decimals : 9;
  const mintAuthority = parsed?.info?.mintAuthority;
  if (!mintAuthority) {
    console.error("Could not read mint; is this a valid SPL mint?");
    process.exit(1);
  }
  if (mintAuthority !== payer.publicKey.toBase58()) {
    console.error(
      "This keypair is not the mint authority. Mint authority:",
      mintAuthority,
      "Payer:",
      payer.publicKey.toBase58()
    );
    process.exit(1);
  }

  const additionalWhole = BigInt(additionalUiStr);
  const raw = additionalWhole * 10n ** BigInt(decimals);

  console.log("Mint:", mintStr);
  console.log("Decimals:", decimals);
  console.log("Additional whole tokens:", additionalUiStr);
  console.log("Raw amount:", raw.toString());

  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey
  );

  const sig = await mintTo(
    connection,
    payer,
    mint,
    ata.address,
    payer.publicKey,
    raw
  );
  console.log("mintTo signature:", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
