(function () {
  'use strict';

  var connectBtn = document.getElementById('connect-wallet-btn');
  var msgSpan = document.getElementById('zoo-wallet-msg') || document.getElementById('zoo-header-wallet-msg');
  var publicKey = null;

  var SHOP_WALLET = 'AVJqhvECgwFkMQbmmTinbf4DxPco6fhzWEpzWyGi53xa';
  var ZOO_MINT = 'FKkgeZxYLxoZ1WciErXKbeNTf5CB296zv51euCR7MZN3';
  var VERIFY_URL = 'https://zoo-solana-checkout-api-1.onrender.com/verify-devnet-payment';

  function getZooAjax() {
    return window.zoo_ajax || {};
  }

  function showMsg(message, isError) {
    if (msgSpan) {
      msgSpan.textContent = message || '';
      msgSpan.style.color = isError ? 'red' : 'lime';
    }
  }

  function isPhantomInstalled() {
    return window.solana && window.solana.isPhantom;
  }

  function updateUIConnected() {
    if (publicKey) {
      showMsg('Wallet Connected', false);
      if (connectBtn) connectBtn.textContent = 'Connected';
    }
  }

  async function connectWallet() {
    if (!isPhantomInstalled()) {
      showMsg('Phantom Wallet not installed.', true);
      return;
    }
    try {
      var resp = await window.solana.connect();
      publicKey = resp.publicKey.toString();
      updateUIConnected();
    } catch (e) {
      showMsg('Wallet connection rejected.', true);
    }
  }

  async function autoConnectWallet() {
    if (!isPhantomInstalled()) return;
    try {
      var resp = await window.solana.connect({ onlyIfTrusted: true });
      if (resp && resp.publicKey) {
        publicKey = resp.publicKey.toString();
        updateUIConnected();
      } else {
        showMsg('Ready to connect.', false);
      }
    } catch (e) {
      showMsg('Ready to connect.', false);
    }
  }

  async function sendZooPayment(amount) {
    if (!window.solana) throw new Error('Phantom not found');
    var solanaWeb3 = window.solanaWeb3;
    if (!solanaWeb3) throw new Error('Solana Web3 not loaded');

    var connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl('devnet'), 'confirmed');
    var fromPubKey = new solanaWeb3.PublicKey(publicKey);
    var toPubKey = new solanaWeb3.PublicKey(SHOP_WALLET);
    var mintPubKey = new solanaWeb3.PublicKey(ZOO_MINT);
    var TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    var fromTokens = await connection.getTokenAccountsByOwner(fromPubKey, { mint: mintPubKey });
    if (!fromTokens.value.length) throw new Error('No ZOO token account in wallet');

    var toTokens = await connection.getTokenAccountsByOwner(toPubKey, { mint: mintPubKey });
    if (!toTokens.value.length) throw new Error('Recipient token account does not exist');

    var rawAmount = Math.floor(amount * Math.pow(10, 9));
    var data = new Uint8Array(9);
    data[0] = 3;
    new DataView(data.buffer).setBigUint64(1, BigInt(rawAmount), true);

    var transferIx = new solanaWeb3.TransactionInstruction({
      keys: [
        { pubkey: fromTokens.value[0].pubkey, isSigner: false, isWritable: true },
        { pubkey: toTokens.value[0].pubkey, isSigner: false, isWritable: true },
        { pubkey: fromPubKey, isSigner: true, isWritable: false }
      ],
      programId: TOKEN_PROGRAM_ID,
      data: data
    });

    var tx = new solanaWeb3.Transaction().add(transferIx);
    var signedTx = await window.solana.signAndSendTransaction(tx);
    await connection.confirmTransaction(signedTx.signature, 'confirmed');
    return signedTx.signature;
  }

  window.sendZooTokens = function (fromPubkeyStr, amount) {
    return sendZooPayment(amount);
  };

  async function checkoutWithZoo() {
    if (!publicKey) {
      showMsg('Connect your wallet first.', true);
      return false;
    }

    var $ = window.jQuery;
    if (!$) return false;

    var ajax = getZooAjax();
    var amount = parseFloat($('#order_review .order-total .amount').last().text().replace(/[^0-9.-]+/g, '')) || parseFloat(ajax.order_amount) || 0;

    if (!amount || amount <= 0) {
      showMsg('Invalid order amount.', true);
      return false;
    }

    showMsg('Processing TX...', false);
    if (connectBtn) {
      connectBtn.classList.add('pending');
      connectBtn.classList.remove('failed', 'success');
    }

    try {
      var txSignature = await sendZooPayment(amount);

      var verifyResp = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signature: txSignature,
          expectedAmount: amount,
          shopWallet: SHOP_WALLET,
          mint: ZOO_MINT
        })
      });

      var verifyData = await verifyResp.json();
      if (!verifyData.success) throw new Error('Verification failed');

      var ajaxUrl = ajax.ajax_url || '/wp-admin/admin-ajax.php';
      var orderResp = await fetch(ajaxUrl + '?action=create_zoo_order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: $('form.checkout').serialize()
      });

      var orderData = await orderResp.json();
      if (orderData.success && orderData.data && orderData.data.redirect) {
        window.location.href = orderData.data.redirect;
      } else if (orderData.redirect) {
        window.location.href = orderData.redirect;
      } else {
        throw new Error('Woo order creation failed');
      }
    } catch (err) {
      if (connectBtn) {
        connectBtn.classList.remove('pending');
        connectBtn.classList.add('failed');
        setTimeout(function () { connectBtn.classList.remove('failed'); }, 1000);
      }
      showMsg(err.message || 'TX failed', true);
      return false;
    }
    return true;
  }

  if (connectBtn) connectBtn.addEventListener('click', connectWallet);

  jQuery(function ($) {
    $('form.checkout').on('submit', function (e) {
      var selectedMethod = $('input[name="payment_method"]:checked').val();
      if (selectedMethod !== 'zoo_devnet') return true;

      e.preventDefault();
      checkoutWithZoo();
      return false;
    });
  });

  window.addEventListener('load', autoConnectWallet);
})();
