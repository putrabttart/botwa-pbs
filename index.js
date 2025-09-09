// index.js
import 'dotenv/config';
import express from 'express';
import qrcodeTerm from 'qrcode-terminal';
import QRCode from 'qrcode';
import pkg from 'whatsapp-web.js';
import fetch from 'node-fetch';

const { Client, LocalAuth } = pkg;

const app = express();
app.use(express.json({ type: ['application/json','application/*+json'] }));
app.use(express.urlencoded({ extended: true }));

// ================== CONFIG ==================
const SHEET_API   = process.env.SHEET_API;                 // endpoint Apps Script
const SECRET      = process.env.SHEET_SECRET || 'rahasia-super-aman';
const MIDTRANS_KEY= process.env.MIDTRANS_KEY;              // Midtrans server key (sandbox/production)
const SESSION_DIR = process.env.SESSION_DIR || '/data/wwebjs'; // pakai Railway Volume

// ================== WHATSAPP INIT ==================
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'pbs-bot',
    dataPath: SESSION_DIR,       // <— simpan sesi di volume agar tidak scan ulang
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox']
  }
});

// simpan QR terakhir untuk /qr
let LAST_QR = null;
client.on('qr', qr => {
  LAST_QR = qr;
  qrcodeTerm.generate(qr, { small: true });
});
client.on('ready', () => console.log('✅ WhatsApp bot siap!'));

// ================== HELPER ==================
const IDR = n => new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR'}).format(Number(n||0));
const prefixOf = (kode = '') => (kode.match(/^[a-z]+/i)?.[0] || '').toLowerCase();

const APP_GUIDE = {
  ytb: [
    '🎬 *Panduan YouTube Premium*',
    '• Gunakan akun *baru/clean*, jangan login multi-device.',
    '• Jangan ubah password/email/2FA.',
    '• Klaim: redeem di https://www.youtube.com/redeem'
  ].join('\n'),
  netf: [
    '🎞️ *Panduan Netflix*',
    '• Akun sharing, 1 profil 1 user.',
    '• Jangan ubah profil lain.',
    '• Kendala login? logout device lain lalu coba lagi.'
  ].join('\n'),
  spo: [
    '🎵 *Panduan Spotify*',
    '• Akun dari seller, jangan ubah password.',
    '• Jangan ubah alamat keluarga.',
    '• Jika ter-kick, reply chat ini untuk re-invite.'
  ].join('\n'),
  default: [
    'ℹ️ *Panduan Umum*',
    '• Jangan ubah email/password kecuali diizinkan.',
    '• 1 akun untuk 1 pengguna.',
    '• Simpan data ini baik-baik.'
  ].join('\n')
};

function guideFor(kode){
  const p = prefixOf(kode);
  return APP_GUIDE[p] || APP_GUIDE.default;
}

function buildDeliveryMessages({ orderId, productName, qty, total, items, kode }) {
  const head = [
    '✅ *Pembayaran Berhasil*',
    `Order ID: *${orderId}*`,
    `Produk  : ${productName} x ${qty}`,
    `Total   : ${IDR(total)}`,
    '',
    '*Detail Produk / Akun:*'
  ].join('\n');

  const ITEMS_PER_CHUNK = 8;
  const chunks = [];
  for (let i = 0; i < items.length; i += ITEMS_PER_CHUNK) {
    const slice = items.slice(i, i + ITEMS_PER_CHUNK);
    chunks.push(slice.map(it => `• ${it.data}`).join('\n'));
  }

  const footer = [
    '',
    guideFor(kode),
    '',
    'Butuh bantuan? Balas pesan ini ya. 🙏'
  ].join('\n');

  const messages = [];
  chunks.forEach((c, i) => {
    if (i === 0) messages.push([head, c].join('\n'));
    else messages.push(c);
  });
  messages[messages.length - 1] = [messages[messages.length - 1], footer].join('\n');
  return messages;
}

// ================== ORDER STORAGE (in-memory) ==================
const ORDERS = new Map();

// ================== COMMAND HANDLER ==================
client.on('message', async msg => {
  try {
    const body = (msg.body || '').trim();
    if (!body.toLowerCase().startsWith('#buynow')) return;

    const [_, kode, qtyStr] = body.split(/\s+/);
    const qty = Math.max(1, parseInt(qtyStr, 10) || 1);

    // Ambil detail produk dari sheet
    const produk = await fetch(`${SHEET_API}?action=produk&kode=${encodeURIComponent(kode)}`).then(r => r.json());
    if (!produk?.nama) return msg.reply('❌ Produk tidak ditemukan.');

    // Buat orderId
    const orderId = 'PBS-' + Date.now();

    // Reserve stok
    const reserve = await fetch(SHEET_API, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        secret: SECRET,
        action: 'reserve',
        kode,
        qty,
        order_id: orderId,
        buyer_jid: msg.from
      })
    }).then(r => r.json());

    if (!reserve?.ok) return msg.reply('❌ Stok tidak cukup atau error.');

    // Buat invoice Midtrans (SNAP)
    const snap = await fetch('https://app.sandbox.midtrans.com/snap/v1/transactions', {
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        'Authorization':'Basic ' + Buffer.from(MIDTRANS_KEY + ':').toString('base64')
      },
      body: JSON.stringify({
        transaction_details: { order_id: orderId, gross_amount: Number(produk.harga) * qty },
        item_details: [{ id: kode, price: Number(produk.harga), quantity: qty, name: produk.nama }],
        customer_details: { first_name: msg.from }
      })
    }).then(r => r.json());

    // Simpan meta order
    ORDERS.set(orderId, { chatId: msg.from, kode, qty, produk });

    // Kirim invoice + panduan singkat
    await msg.reply([
      '📝 *Order dibuat!*',
      `Order ID: ${orderId}`,
      `Produk  : ${produk.nama} x ${qty}`,
      `Total   : ${IDR(Number(produk.harga) * qty)}`,
      '',
      `Silakan bayar di link berikut:\n${snap.redirect_url}`,
      '',
      'Setelah pembayaran berhasil, bot otomatis kirim produk.'
    ].join('\n'));

    await msg.reply('📌 Catatan:\n' + guideFor(kode));

  } catch (e) {
    console.error('Handler error:', e);
    try { await msg.reply('⚠️ Terjadi error, coba lagi nanti.'); } catch {}
  }
});

// ================== MIDTRANS WEBHOOK ==================
app.post('/webhook/midtrans', async (req, res) => {
  try {
    const ev = req.body || {};
    const orderId = ev.order_id;
    const status  = ev.transaction_status;

    if (!ORDERS.has(orderId)) return res.json({ ok:false, reason:'unknown order' });

    if (status === 'settlement' || status === 'capture') {
      const meta = ORDERS.get(orderId);

      // Finalize stok di Sheet -> dapat item/akun
      const fin = await fetch(SHEET_API, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({
          secret: SECRET,
          action: 'finalize',
          order_id: orderId,
          total: ev.gross_amount
        })
      }).then(r => r.json());

      if (fin?.ok) {
        const messages = buildDeliveryMessages({
          orderId,
          productName: meta.produk?.nama || meta.kode,
          qty: meta.qty,
          total: ev.gross_amount,
          items: fin.items || [],
          kode: meta.kode
        });
        for (const text of messages) {
          await client.sendMessage(meta.chatId, text);
        }
      }
    }

    res.json({ ok:true });
  } catch (e) {
    console.error('Webhook Midtrans error:', e);
    res.status(200).json({ ok:false, error: String(e) }); // 200 supaya Midtrans tidak retry brutal
  }
});

// ================== ROUTES: QR preview & health ==================
app.get('/qr', async (req, res) => {
  if (!LAST_QR) return res.status(404).send('QR belum tersedia. Tunggu event "qr" lalu refresh.');
  try {
    const dataUrl = await QRCode.toDataURL(LAST_QR);
    res.set('Content-Type','text/html')
       .send(`<img src="${dataUrl}" style="width:320px;image-rendering:pixelated" />`);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

app.get('/', (req, res) => res.send('PBS Bot aktif.'));

// ================== START ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('HTTP keepalive on :' + PORT));

client.initialize();
