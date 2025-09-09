import "dotenv/config";
import qrcode from "qrcode-terminal";
import express from "express";
import { parse } from "csv-parse/sync";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;

// ===== ENV =====
const SHEET_URL = process.env.SHEET_URL || "";
const ADMIN_JIDS = new Set((process.env.ADMINS || "").split(",").map(s => s.trim()).filter(Boolean));
const ADMIN_CONTACT = process.env.ADMIN_CONTACT || "";
const CLIENT_ID = process.env.CLIENT_ID || "botwa-railway";

// ===== Keepalive server (for health checks) =====
const app = express();
app.get("/", (_req, res) => res.send("OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP keepalive on :" + PORT));

// ===== Utils =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isHttp = (u="") => /^https?:\/\//i.test(u || "");
const norm = (s="") => s.toString().toLowerCase().normalize("NFKD").replace(/\s+/g," ").trim();
const toID = (s="") => s.replace(/\D/g, "");
const IDR = (n) => new Intl.NumberFormat("id-ID", { style:"currency", currency:"IDR", maximumFractionDigits:0 }).format(Number(n || 0));
const paginate = (arr, page=1, per=8) => {
  const total = Math.max(1, Math.ceil(arr.length/per));
  const p = Math.min(Math.max(1, page), total);
  const start = (p-1)*per;
  return { items: arr.slice(start, start+per), page: p, total };
};

// ===== Data layer (Google Sheet CSV) =====
// Expected headers: nama,harga,ikon,deskripsi,kategori,wa,harga_lama,stok,kode,(optional:terjual,total)
let PRODUCTS = []; let LAST = 0; const TTL = 1000*60*5;

const rowToProduct = (r) => {
  const o = {}; for (const k of Object.keys(r)) o[k.trim().toLowerCase()] = (r[k] ?? "").toString().trim();
  return {
    nama: o.nama || "", harga: o.harga || "", ikon: o.ikon || "",
    deskripsi: o.deskripsi || "", kategori: o.kategori || "", wa: o.wa || "",
    harga_lama: o.harga_lama || "", stok: o.stok || "", kode: o.kode || "",
    terjual: o.terjual || "", total: o.total || ""
  };
};

async function loadData(force=false) {
  if (!force && PRODUCTS.length && (Date.now()-LAST) < TTL) return;
  if (!SHEET_URL) { PRODUCTS = [{ nama:"Contoh", harga:"10000", kode:"contoh", wa: ADMIN_CONTACT }]; LAST = Date.now(); return; }
  const res = await fetch(SHEET_URL);
  if (!res.ok) throw new Error("Fetch sheet failed: " + res.status);
  const csv = await res.text();
  const rows = parse(csv, { columns: true, skip_empty_lines: true });
  PRODUCTS = rows.map(rowToProduct).filter(p => p.nama && p.kode);
  LAST = Date.now();
}

const categories = () => [...new Set(PRODUCTS.map(p => p.kategori).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
const search = (q) => {
  const s = norm(q);
  return PRODUCTS.filter(p => [p.nama, p.deskripsi, p.kode, p.kategori].some(v => norm(v).includes(s)));
};
const byKode = (code) => PRODUCTS.find(p => norm(p.kode) === norm(code));

// ===== Card format =====
const cardHeader = () => [
  `╭────〔 BOT AUTO ORDER 〕─`,
  `┊・Untuk membeli ketik perintah berikut`,
  `┊・#buynow Kode(spasi)JumlahAkun`,
  `┊・Ex: #buynow spo3b 1`,
  `┊・Contact Admin: ${ADMIN_CONTACT || "-"}`,
  `╰┈┈┈┈┈┈┈┈`
].join("\n");

function cardProduk(p) {
  const hargaNow = IDR(p.harga);
  const hargaOld = p.harga_lama ? `~${IDR(p.harga_lama)}~ → *${hargaNow}*` : `*${hargaNow}*`;
  const stokTersedia = p.stok || "-";
  const stokTerjual = p.terjual || "-";
  const totalStok   = p.total || (p.stok && p.terjual ? (Number(p.stok)+Number(p.terjual)) : "-");
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

const buyPrefill = (p, jumlah=1) => [
  `Halo admin, saya mau pesan:`,
  `Nama: ${p.nama}`,
  `Kode: ${p.kode}`,
  `Jumlah: ${jumlah}`,
  `Harga Satuan: ${IDR(p.harga)}`,
  p.kategori ? `Kategori: ${p.kategori}` : null
].filter(Boolean).join("\n");

const waDeepLink = (p, jumlah=1) => {
  const num = toID(p.wa || ADMIN_CONTACT || "");
  if (!num) return "";
  return `https://wa.me/${num}?text=${encodeURIComponent(buyPrefill(p, jumlah))}`;
};

// ===== WA client with Chromium in Docker =====
const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
const client = new Client({
  authStrategy: new LocalAuth({ clientId: CLIENT_ID }),
  puppeteer: {
    headless: true,
    executablePath: execPath,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--disable-extensions"]
  }
});

client.on("qr", (qr) => { console.log("Scan QR berikut:"); qrcode.generate(qr, { small: true }); });
client.on("ready", async () => { console.log("✅ Bot siap! (Railway)"); try { await loadData(true); console.log("📦 Items:", PRODUCTS.length); } catch(e){ console.error(e); } });

client.on("message", async (msg) => {
  try {
    const text = (msg.body || "").trim(); const from = msg.from;
    if (msg.isStatus) return;

    if (/^#menu$/i.test(text)) return msg.reply([
      "📜 *Menu Bot*",
      "• #ping → tes bot",
      "• #kategori → daftar kategori",
      "• #list [kategori] [hal] → daftar produk (8/hal)",
      "• #harga <keyword> → cari produk",
      "• #detail <kode> → detail produk",
      "• #beli <kode> → link WA admin",
      "• #buynow <kode> <jumlah> → link WA admin + prefill",
      ADMIN_JIDS.has(from) ? "• #refresh → reload data (admin)" : null
    ].filter(Boolean).join("\n"));

    if (/^#ping$/i.test(text)) return msg.reply("Pong ✅ Bot aktif.");

    if (/^#refresh$/i.test(text)) {
      if (!ADMIN_JIDS.has(from)) return msg.reply("❌ Hanya admin.");
      await loadData(true); return msg.reply(`✅ Reload sukses. Items: ${PRODUCTS.length}`);
    }

    if (/^#kategori$/i.test(text)) {
      await loadData(); const cats = categories();
      return msg.reply(cats.length ? `🗂️ *Kategori*\n• ${cats.join("\n• ")}` : "Belum ada kategori.");
    }

    if (/^#list\b/i.test(text)) {
      await loadData();
      const parts = text.split(/\s+/).slice(1); let cat=""; let page=1;
      if (parts.length===1 && /^\d+$/.test(parts[0])) page = Number(parts[0]);
      else if (parts.length>=1){ const last=parts[parts.length-1];
        if (/^\d+$/.test(last)) { page=Number(last); cat=parts.slice(0,-1).join(" "); } else { cat=parts.join(" "); }
      }
      let data = PRODUCTS; if (cat) data = data.filter(p => norm(p.kategori).includes(norm(cat)));
      const { items, page:p, total } = paginate(data, page, 8);
      if (!items.length) return msg.reply(cat ? `Tidak ada produk untuk kategori *${cat}*.` : "Belum ada produk.");
      const chunks=[cardHeader()]; for (const prod of items) chunks.push(cardProduk(prod));
      return msg.reply(chunks.join("\n\n")+`\n\nHalaman ${p}/${total} — *#list ${cat ? cat + " " : ""}${p+1}* untuk berikutnya.`);
    }

    if (/^#(harga|cari)\b/i.test(text)) {
      await loadData(); const q = text.replace(/^#(harga|cari)\s*/i, ""); if (!q) return msg.reply("Format: *#harga <kata kunci>*");
      const found = search(q).slice(0,6); if (!found.length) return msg.reply("❌ Tidak ditemukan.");
      const chunks=[cardHeader()]; for (const p of found) chunks.push(cardProduk(p)); return msg.reply(chunks.join("\n\n"));
    }

    if (/^#detail\s+/i.test(text)) {
      await loadData(); const code = text.split(/\s+/)[1] || ""; const p = byKode(code);
      if (!p) return msg.reply("Kode tidak ditemukan.");
      const cap = [cardHeader(), cardProduk(p)].join("\n\n");
      if (isHttp(p.ikon)) { try { const media = await MessageMedia.fromUrl(p.ikon); return client.sendMessage(from, media, { caption: cap }); } catch {} }
      return msg.reply(cap);
    }

    if (/^#beli\s+/i.test(text)) {
      await loadData(); const code = text.split(/\s+/)[1] || ""; const p = byKode(code);
      if (!p) return msg.reply("Kode tidak ditemukan.");
      const link = waDeepLink(p,1); if (!link) return msg.reply("Nomor admin belum diisi.");
      return msg.reply(`Silakan order melalui WA admin:\n${link}`);
    }

    if (/^#buynow\s+/i.test(text)) {
      await loadData();
      const m = text.match(/^#buynow\s+(\S+)(?:\s+(\d+))?/i); const code = m?.[1] || ""; const qty = Number(m?.[2]||"1")||1;
      const p = byKode(code); if (!p) return msg.reply("Kode tidak ditemukan. Contoh: *#buynow spo3b 1*");
      const link = waDeepLink(p, qty); if (!link) return msg.reply("Nomor admin belum diisi.");
      return msg.reply(`👉 Klik untuk order ${qty} akun:\n${link}`);
    }

  } catch (e) { console.error("Handler error:", e); try { await msg.reply("⚠️ Terjadi error. Coba lagi nanti."); } catch {} }
});

process.on("SIGINT", async () => { console.log("\n🛑 Shutting down..."); try { await client.destroy(); } catch {} process.exit(0); });
client.initialize();
