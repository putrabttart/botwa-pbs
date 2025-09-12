// ========== WhatsApp Bot - PBS (Railway Full) ==========
import "dotenv/config";
import express from "express";
import qrcode from "qrcode-terminal";
import QR from "qrcode";
import { parse } from "csv-parse/sync";
import crypto from "crypto";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
// NOTE: Node 18+ punya fetch global. Jika env lama, bisa tambah: import fetch from "node-fetch";

/* ---------------- ENV ---------------- */
const SHEET_URL  = process.env.SHEET_URL || "";                   // CSV publik dari tab Produk
const ADMIN_JIDS = new Set((process.env.ADMINS || "").split(",").map(s=>s.trim()).filter(Boolean));
const ADMIN_CONTACT = process.env.ADMIN_CONTACT || "";
const CLIENT_ID = process.env.CLIENT_ID || "botwa-railway";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";        // ex: https://xxx.up.railway.app

// Apps Script (stok & order log)
const GAS_URL    = process.env.GAS_WEBHOOK_URL || "";
const GAS_SECRET = process.env.GAS_SECRET || "";

// Payment (Midtrans)
const PAY_PROV = (process.env.PAYMENT_PROVIDER || "midtrans").toLowerCase();
const MID_SKEY = process.env.MIDTRANS_SERVER_KEY || "";
const MID_PROD = (process.env.MIDTRANS_IS_PRODUCTION || "false") === "true";

// Chromium path (set via Dockerfile)
const EXEC_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

/* --------------- Server keepalive + Webhook --------------- */
const app = express();
app.use(express.json({ type: ['application/json','application/*+json'] }));
app.use(express.urlencoded({ extended: true }));
app.get("/", (_req,res)=>res.send("OK - PBS Bot is running"));
app.get("/status", (_req,res)=>res.json({ok:true}));

/* --------------- Utils --------------- */
const norm = (s="") => s.toString().toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
const toID = (s="") => s.replace(/\D/g, "");
const isHttp = (u="") => /^https?:\/\/?/i.test(u || "");
const IDR = (n) => new Intl.NumberFormat("id-ID", { style:"currency", currency:"IDR", maximumFractionDigits:0 }).format(Number(n||0));
const paginate = (arr, page=1, per=8) => {
  const total = Math.max(1, Math.ceil(arr.length/per));
  const p = Math.min(Math.max(1, page), total);
  const start = (p-1)*per;
  return { items: arr.slice(start, start+per), page: p, total };
};

// simple http json
async function postJSON(url, body) {
  const res = await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}`);
  return res.json();
}

/* --------------- Data (Sheet CSV: Produk) --------------- */
// Kolom: nama,harga,ikon,deskripsi,kategori,wa,harga_lama,stok,kode,(terjual,total)
let PRODUCTS = []; let LAST = 0; const TTL = 1000*60*5;

function rowToProduct(r) {
  const o = {}; for (const k of Object.keys(r)) o[k.trim().toLowerCase()] = (r[k] ?? "").toString().trim();
  return {
    nama:o.nama||"", harga:o.harga||"", ikon:o.ikon||"",
    deskripsi:o.deskripsi||"", kategori:o.kategori||"", wa:o.wa||"",
    harga_lama:o.harga_lama||"", stok:o.stok||"", kode:o.kode||"",
    terjual:o.terjual||"", total:o.total||""
  };
}
async function loadData(force=false) {
  if (!force && PRODUCTS.length && Date.now()-LAST < TTL) return;
  if (!SHEET_URL) { PRODUCTS=[{nama:"Contoh",harga:"10000",kode:"contoh",wa:ADMIN_CONTACT}]; LAST=Date.now(); return; }
  const r = await fetch(SHEET_URL);
  if (!r.ok) throw new Error("Fetch sheet failed: "+r.status);
  const csv = await r.text();
  const rows = parse(csv, { columns:true, skip_empty_lines:true });
  PRODUCTS = rows.map(rowToProduct).filter(p=>p.nama && p.kode);
  LAST = Date.now();
}
const categories = () => [...new Set(PRODUCTS.map(p=>p.kategori).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
const search = (q) => { const s=norm(q); return PRODUCTS.filter(p => [p.nama,p.deskripsi,p.kode,p.kategori].some(v=>norm(v).includes(s))); };
const byKode = (code) => PRODUCTS.find(p => norm(p.kode)===norm(code));

/* --------------- Cards --------------- */
const cardHeader = () => [
  `╭────〔 BOT AUTO ORDER 〕─`,
  `┊・Untuk membeli ketik perintah berikut`,
  `┊・#buynow Kode(spasi)JumlahAkun`,
  `┊・Ex: #buynow spo3b 1`,
  `┊・Contact Admin: ${ADMIN_CONTACT || "-"}`,
  `╰┈┈┈┈┈┈┈┈`
].join("\n");

function cardProduk(p){
  const hargaNow = IDR(p.harga);
  const hargaOld = p.harga_lama ? `~${IDR(p.harga_lama)}~ → *${hargaNow}*` : `*${hargaNow}*`;
  const stokTersedia = p.stok || "-";
  const stokTerjual = p.terjual || "-";
  const totalStok = p.total || (p.stok && p.terjual ? (Number(p.stok)+Number(p.terjual)) : "-");
  return [
    `*╭────〔 ${p.nama.toUpperCase()} 〕─*`,
    `┊・Harga: ${hargaOld}`,
    `┊・Stok Tersedia: ${stokTersedia}`,
    `┊・Stok Terjual: ${stokTerjual}`,
    `┊・Total Stok: ${totalStok}`,
    `┊・Kode: ${p.kode || "-"}`,
    `┊・Desk: ${p.deskripsi || "-"}`,
    `╰┈┈┈┈┈┈┈┈`
  ].join("\n");
}

/* --------------- Apps Script (stok & log) --------------- */
async function reserveStock({ kode, qty, order_id, buyer_jid }) {
  if (!GAS_URL) return { ok:false, msg:"GAS_URL missing" };
  return postJSON(GAS_URL, { secret:GAS_SECRET, action:"reserve", kode, qty, order_id, buyer_jid });
}
async function finalizeStock({ order_id, total }) {
  if (!GAS_URL) return { ok:false, msg:"GAS_URL missing" };
  return postJSON(GAS_URL, { secret:GAS_SECRET, action:"finalize", order_id, total });
}
async function releaseStock({ order_id }) {
  if (!GAS_URL) return { ok:false, msg:"GAS_URL missing" };
  return postJSON(GAS_URL, { secret:GAS_SECRET, action:"release", order_id });
}

/* --------------- Midtrans --------------- */
function midtransBase(){
  const host = MID_PROD ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com";
  const auth = Buffer.from(MID_SKEY + ":").toString("base64");
  return { host, auth };
}
async function createMidtransInvoice({ order_id, gross_amount, customer_phone, product_name }) {
  const { host, auth } = midtransBase();
  const payload = {
    transaction_details: { order_id, gross_amount },
    item_details: [{ id: order_id, price: gross_amount, quantity: 1, name: product_name }],
    customer_details: { phone: customer_phone },
    callbacks: { finish: PUBLIC_BASE_URL ? (PUBLIC_BASE_URL + "/pay/finish") : undefined },
    credit_card: { secure: true }
  };
  const res = await fetch(host + "/snap/v1/transactions", {
    method:"POST",
    headers:{ "content-type":"application/json", Authorization:`Basic ${auth}` },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("Midtrans create error: "+res.status+" "+await res.text());
  return res.json(); // { token, redirect_url }
}
function verifyMidtransSignature({ order_id, status_code, gross_amount, signature_key }) {
  const raw = order_id + status_code + gross_amount + MID_SKEY;
  const calc = crypto.createHash("sha512").update(raw).digest("hex");
  return calc === signature_key;
}
// Core API: QRIS charge (tanpa Snap)
async function createMidtransQRISCharge({ order_id, gross_amount }) {
  const { host, auth } = midtransBase();
  const payload = {
    payment_type: "qris",
    transaction_details: { order_id, gross_amount }
  };
  const res = await fetch(host + "/v2/charge", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("QRIS charge error: " + res.status + " " + await res.text());
  return res.json(); // actions (PNG url), qr_string, dll.
}

// map order -> { chatId, kode, qty, buyerPhone, total? }
const ORDERS = new Map();

/* --------------- WhatsApp Client --------------- */
const client = new Client({
  authStrategy: new LocalAuth({ clientId: CLIENT_ID }),
  puppeteer: {
    headless: true,
    executablePath: EXEC_PATH,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--disable-extensions"]
  }
});

/* ---- QR handling + /qr PNG ---- */
let lastQR = "";
client.on("qr", (qr)=>{ lastQR=qr; console.log("Scan QR berikut:"); qrcode.generate(qr, { small:true }); });
client.on("authenticated", ()=> lastQR = "");
client.on("ready", async ()=>{ lastQR=""; console.log("✅ Bot siap! (Railway)"); try{ await loadData(true); console.log("📦 Items:", PRODUCTS.length); }catch(e){ console.error(e); } });

app.get("/qr", async (_req,res)=>{
  if (!lastQR) return res.status(204).send("");
  try {
    const png = await QR.toBuffer(lastQR, { type:"png", width:320, margin:1 });
    res.set("Content-Type","image/png"); res.send(png);
  } catch { res.status(500).send("QR gen error"); }
});

app.get("/pay/finish", (_req,res)=> res.send("Terima kasih! Silakan cek WhatsApp Anda untuk konfirmasi & produk."));

/* ---- Midtrans Webhook ---- */
app.post("/webhook/midtrans", async (req,res)=>{
  try{
    const ev = req.body || {};
    if (!verifyMidtransSignature(ev)) return res.status(401).send("bad signature");

    const order_id = ev.order_id;
    const status   = ev.transaction_status; // settlement, capture, deny, cancel, expire, pending
    const grossStr = String(ev.gross_amount || "0");
    const gross    = Number(grossStr);

    if (status==="settlement" || status==="capture") {
      const fin = await finalizeStock({ order_id, total: gross });
      if (fin.ok) {
        const meta = ORDERS.get(order_id);
        if (meta?.chatId) {
          const items = fin.items || [];
    
          // 1) Kirim header transaksi
          await client.sendMessage(meta.chatId, [
            "✅ *Pembayaran Berhasil*",
            `Order ID: ${order_id}`,
            `Produk: ${meta.kode} x ${meta.qty}`,
            `Total: ${IDR(gross)}`,
            "",
            items.length ? "*Detail Produk / Akun:*" : "*Catatan:* stok akan dikirim manual oleh admin."
          ].join("\n"));
    
          // 2) Kirim akun satu per satu
          for (const it of items) {
            await client.sendMessage(meta.chatId, "• " + it.data);
          }
    
          // 3) Kirim template tambahan (after_msg) kalau ada
          if (fin.after_msg) {
            await client.sendMessage(meta.chatId, fin.after_msg);
          }
        }
      }
      return res.send("ok");
    }


    if (status==="expire" || status==="cancel" || status==="deny") {
      await releaseStock({ order_id });
      const meta = ORDERS.get(order_id);
      if (meta?.chatId) await client.sendMessage(meta.chatId, `❌ Pembayaran *${status}*. Order dibatalkan dan stok dikembalikan.`);
      return res.send("ok");
    }

    return res.send("ok");
  }catch(e){ console.error("webhook midtrans:", e); res.status(500).send("error"); }
});

/* --------------- Command Handler --------------- */
client.on("message", async (msg)=>{
  try{
    const text = (msg.body||"").trim();
    const from = msg.from;
    if (msg.isStatus) return;

    if (/^#menu$/i.test(text)) return msg.reply([
      "📜 *Menu Bot*",
      "• #ping",
      "• #kategori",
      "• #list [kategori] [hal]",
      "• #harga <keyword>",
      "• #detail <kode>",
      "• #beli <kode>",
      "• #buynow <kode> <jumlah>",
      ADMIN_JIDS.has(from) ? "• #refresh (admin)" : null
    ].filter(Boolean).join("\n"));

    if (/^#ping$/i.test(text)) return msg.reply("Pong ✅ Bot aktif.");

    if (/^#refresh$/i.test(text)) {
      if (!ADMIN_JIDS.has(from)) return msg.reply("❌ Hanya admin.");
      await loadData(true); return msg.reply(`✅ Reload sukses. Items: ${PRODUCTS.length}`);
    }

    if (/^#kategori$/i.test(text)) {
      await loadData(); const cats=categories();
      return msg.reply(cats.length ? `🗂️ *Kategori*\n• ${cats.join("\n• ")}` : "Belum ada kategori.");
    }

    if (/^#list\b/i.test(text)) {
      await loadData();
      const parts = text.split(/\s+/).slice(1);
      let cat=""; let page=1;
      if (parts.length===1 && /^\d+$/.test(parts[0])) page=Number(parts[0]);
      else if (parts.length>=1) { const last=parts[parts.length-1]; if (/^\d+$/.test(last)) { page=Number(last); cat=parts.slice(0,-1).join(" "); } else { cat=parts.join(" "); } }
      let data=PRODUCTS; if (cat) data=data.filter(p=>norm(p.kategori).includes(norm(cat)));
      const { items, page:p, total } = paginate(data, page, 8);
      if (!items.length) return msg.reply(cat ? `Tidak ada produk untuk kategori *${cat}*.` : "Belum ada produk.");
      const chunks=[cardHeader()]; for (const prod of items) chunks.push(cardProduk(prod));
      return msg.reply(chunks.join("\n\n") + `\n\nHalaman ${p}/${total} — *#list ${cat?cat+" ":""}${p+1}* untuk berikutnya.`);
    }

    if (/^#(harga|cari)\b/i.test(text)) {
      await loadData();
      const q = text.replace(/^#(harga|cari)\s*/i, "");
      if (!q) return msg.reply("Format: *#harga <kata kunci>*");
      const found = search(q).slice(0,6);
      if (!found.length) return msg.reply("❌ Tidak ditemukan.");
      const chunks=[cardHeader()]; for (const p of found) chunks.push(cardProduk(p));
      return msg.reply(chunks.join("\n\n"));
    }

    if (/^#detail\s+/i.test(text)) {
      await loadData();
      const code = text.split(/\s+/)[1] || "";
      const p = byKode(code); if (!p) return msg.reply("Kode tidak ditemukan.");
      const cap = [cardHeader(), cardProduk(p)].join("\n\n");
      if (isHttp(p.ikon)) { try{ const media=await MessageMedia.fromUrl(p.ikon); return client.sendMessage(from, media, { caption: cap }); }catch{} }
      return msg.reply(cap);
    }

    if (/^#beli\s+/i.test(text)) {
      await loadData();
      const code = text.split(/\s+/)[1] || "";
      const p = byKode(code); if (!p) return msg.reply("Kode tidak ditemukan.");
      const link = `https://wa.me/${toID(p.wa||ADMIN_CONTACT)}?text=${encodeURIComponent(`Halo admin, saya ingin beli ${p.nama} (kode: ${p.kode}).`)}`;
      return msg.reply(`Silakan order ke admin:\n${link}`);
    }

    if (/^#buynow\s+/i.test(text)) {
      await loadData();
      const m = text.match(/^#buynow\s+(\S+)(?:\s+(\d+))?/i);
      const code = m?.[1] || ""; const qty = Number(m?.[2] || "1") || 1;
      const p = byKode(code); if (!p) return msg.reply("Kode tidak ditemukan. Contoh: *#buynow spo3b 1*");

      const order_id = `PBS-${Date.now()}`;
      const total = Number(p.harga) * qty;

      // 1) Reserve stock
      const reserve = await reserveStock({ kode: code, qty, order_id, buyer_jid: from });
      if (!reserve.ok) return msg.reply("Maaf, stok tidak mencukupi. Coba kurangi jumlah / pilih produk lain.");

      // 2) Save mapping (untuk webhook)
      ORDERS.set(order_id, { chatId: from, kode: code, qty, buyerPhone: toID(from), total });

      // 3) MIDTRANS: Charge QRIS & kirim gambar QR
if (PAY_PROV === "midtrans") {
  try {
    const charge = await createMidtransQRISCharge({ order_id, gross_amount: total });

    // 1) Ambil URL link dari actions (kalau ada)
    let payLink = "";
    if (Array.isArray(charge?.actions)) {
      // urutan preferensi: desktop_web > mobile_web > deeplink > fallback pertama yang ada
      const prefer = (names) => charge.actions.find(a => names.some(n => (a?.name||"").toLowerCase().includes(n)));
      const a1 = prefer(["desktop", "web"]);
      const a2 = prefer(["mobile"]);
      const a3 = prefer(["deeplink"]);
      const aAny = charge.actions[0];
      payLink = (a1?.url || a2?.url || a3?.url || aAny?.url || "");
    }

    // 2) Render QR dari qr_string → PNG
    const qrString = charge?.qr_string || "";
    let media = null;
    if (qrString) {
      const buf = await QR.toBuffer(qrString, { type: "png", width: 512, margin: 1 });
      const b64 = buf.toString("base64");
      media = new MessageMedia("image/png", b64, `qris-${order_id}.png`);
    }

    // 3) Caption yang rapi + link (jika ada)
    const caption = [
      "🧾 *Order dibuat!*",
      `Order ID: ${order_id}`,
      `Produk: ${p.nama} x ${qty}`,
      `Total: ${IDR(total)}`,
      "",
      "Silakan scan QRIS berikut untuk membayar.",
      payLink ? `Link Checkout: ${payLink}` : "(Jika QR tidak muncul, balas: *#qris* untuk kirim ulang.)"
    ].join("\n");

    if (media) {
      await client.sendMessage(from, media, { caption });
    } else {
      // Jika gagal render PNG, tetap kirim caption + link
      await msg.reply(caption + (qrString ? `\n\nQR String:\n${qrString}` : ""));
    }
    return;
  } catch (e) {
    console.error("qris:", e);
    // Fallback ke Snap bila Core QRIS bermasalah → kirim link
    const inv = await createMidtransInvoice({
      order_id,
      gross_amount: total,
      customer_phone: toID(from),
      product_name: `${p.nama} x ${qty}`
    });
    return msg.reply([
      "⚠️ QRIS sedang bermasalah, fallback ke link:",
      inv.redirect_url
    ].join("\n"));
  }
}


      return msg.reply("Provider pembayaran belum dikonfigurasi.");
    }

  }catch(e){
    console.error("handler:", e);
    try{ await msg.reply("⚠️ Terjadi error. Coba lagi nanti."); }catch{}
  }
});

/* --------------- Lifecycle --------------- */
process.on("SIGINT", async ()=>{
  console.log("\n🛑 Shutting down...");
  try{ await client.destroy(); }catch{}
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("HTTP keepalive on :", PORT));

/* ==== Admin webhook secret ==== */
const ADMIN_SECRET = process.env.ADMIN_WEBHOOK_SECRET || "";

/* ==== Helper kirim pesan ke semua admin ==== */
async function notifyAdmins(text) {
  for (const jid of ADMIN_JIDS) {
    try { await client.sendMessage(jid, text); } catch {}
  }
}

/* ==== Endpoint: push-reload dari Sheets ==== */
// POST /admin/reload  {secret: "...", what:"produk|all", note?:string}
app.post("/admin/reload", async (req, res) => {
  try {
    if (!ADMIN_SECRET || req.body?.secret !== ADMIN_SECRET) return res.status(401).send("forbidden");
    const what = (req.body?.what || "all").toLowerCase();
    if (what === "produk" || what === "all") {
      LAST = 0;                      // paksa cache produk kadaluarsa
      await loadData(true);          // reload produk
    }
    if (req.body?.note) await notifyAdmins(`♻️ Reload diminta: ${req.body.note}`);
    return res.json({ ok:true });
  } catch (e) {
    console.error("admin/reload:", e);
    return res.status(200).json({ ok:false, error: String(e) }); // tidak memicu retrial storm
  }
});

/* ==== Endpoint: low-stock alert ==== */
// POST /admin/lowstock {secret:"...", items:[{kode, ready}]}
app.post("/admin/lowstock", async (req, res) => {
  try {
    if (!ADMIN_SECRET || req.body?.secret !== ADMIN_SECRET) return res.status(401).send("forbidden");
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.json({ ok:true });
    let msg = ["⚠️ *Low Stock Alert*"];
    for (const it of items) msg.push(`• ${it.kode}: ready ${it.ready}`);
    await notifyAdmins(msg.join("\n"));
    return res.json({ ok:true });
  } catch (e) {
    console.error("admin/lowstock:", e);
    return res.status(200).json({ ok:false, error: String(e) });
  }
});

client.initialize();

/* ==================== Helpers (format & mapping) ==================== */

// Nama bulan Indonesia + jam “pukul HH.MM”
function indoDateTime(iso) {
  try {
    const d = new Date(iso);
    const bln = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
    const tgl = d.getDate();
    const bulan = bln[d.getMonth()];
    const th = d.getFullYear();
    const hh = String(d.getHours()).padStart(2,"0");
    const mm = String(d.getMinutes()).padStart(2,"0");
    return `${tgl} ${bulan} ${th} pukul ${hh}.${mm}`;
  } catch { return iso; }
}

// Mapping tipe pembayaran Midtrans ke label ramah
function mapPaymentType(ev) {
  const t = (ev?.payment_type || "").toLowerCase();
  if (t==="qris") return "QRIS";
  if (t==="bank_transfer") {
    if (ev?.va_numbers?.[0]?.bank) return `Virtual Account ${ev.va_numbers[0].bank.toUpperCase()}`;
    if (ev?.permata_va_number) return "Virtual Account PERMATA";
    return "Virtual Account";
  }
  if (t==="echannel") return "Mandiri Bill";
  if (t==="gopay") return "GoPay";
  if (t==="credit_card") return "Kartu Kredit";
  if (t==="shopeepay") return "ShopeePay";
  if (t==="alfamart" || t==="indomaret") return t.charAt(0).toUpperCase()+t.slice(1);
  return t || "-";
}

// Buat ID buyer sederhana dari chatId (non-sensitif)
function simpleBuyerId(chatId) {
  if (!chatId) return "-";
  const only = toID(chatId);
  if (!only) return "-";
  return only.slice(-5);
}

// === Formatter ACCOUNT DETAIL: numbering global 1..N, satu baris per akun ===
// items = [{ data: "email: x || password: y || profile: z || pin: 1234" }, ...]
function formatAccountDetailsNumberedGlobal(items) {
  const out = ["( ACCOUNT DETAIL )"];
  const cap = (s="") => s.charAt(0).toUpperCase() + s.slice(1);
  let n = 1;

  for (const it of (items || [])) {
    const raw = String(it?.data || "").trim();
    if (!raw) continue;

    const parts = raw.split("||")
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => {
        const m = p.match(/^([^:=]+)\s*[:=]\s*(.+)$/);
        if (m) return `${cap(m[1].trim())}: ${m[2].trim()}`;
        return p;
      });

    out.push(`${n}. ${parts.join(" | ")}`);
    n++;
  }
  return out.join("\n");
}

// Ambil nama produk dari kode (untuk header)
async function namaProdukDariKode(kode) {
  try {
    await loadData();
    const p = byKode(kode);
    return p?.nama || null;
  } catch { return null; }
}
