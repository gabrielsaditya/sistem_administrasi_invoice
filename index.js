require("dotenv").config();
const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode"); // Import modul qrcode
const mysql = require("mysql");
const util = require("util");
const fsExtra = require("fs-extra");
const path = require("path");

// Konfigurasi koneksi database
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'cleon_db'
});

db.connect((err) => {
  if (err) throw err;
  console.log('Connected to database!');
});

// Bungkus query dengan promisify agar mendukung async/await
db.query = util.promisify(db.query).bind(db);

// Variabel global untuk menyimpan QR Code dan instance socket
let currentQR = null;
let sockInstance = null;
// Variabel global untuk menyimpan progress invoice (0 - 100%)
let invoiceProgress = 0;

// Fungsi untuk menghasilkan data URL dari QR string
async function generateQRDataURL(qr) {
  try {
    const dataUrl = await QRCode.toDataURL(qr);
    return dataUrl;
  } catch (err) {
    console.error("Error generating QR data URL:", err);
    return null;
  }
}

// Fungsi format tanggal
function formatDate(date) {
  const options = { day: "2-digit", month: "long", year: "numeric" };
  return new Date(date).toLocaleDateString("id-ID", options);
}

// Fungsi mengirim pesan WhatsApp
async function sendWhatsAppMessage(sock, nomor, pesan) {
  try {
    // Jika nomor belum berupa JID, tambahkan @s.whatsapp.net
    const jid = nomor.includes("@s.whatsapp.net") ? nomor : `${nomor}@s.whatsapp.net`;
    console.log(`Mengirim pesan ke ${jid}: ${pesan}`);
    await sock.sendMessage(jid, { text: pesan });
    console.log(`✅ Pesan terkirim ke ${nomor}`);
  } catch (error) {
    console.error(`❌ Gagal mengirim ke ${nomor}:`, error);
  }
}

// Tambahkan fungsi pembagi array
function chunkArray(arr, chunkSize) {
  const results = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    results.push(arr.slice(i, i + chunkSize));
  }
  return results;
}

// Fungsi mengambil data pelanggan yang jatuh tempo dan mengirim pesan otomatis
// Update fungsi processOverdueInvoices
// Ubah fungsi processOverdueInvoices untuk menerima parameter tableName
async function processOverdueInvoices(sock, tableName) {
  // Query menggunakan nama tabel dinamis
  const rows = await db.query(`
    SELECT nama, no_pelanggan, layanan, no_telepon, tanggal_pembayaran, jatuh_tempo, tagihan 
    FROM ${tableName}
    WHERE no_telepon IS NOT NULL AND no_telepon <> ''
  `);

  // (Kode selanjutnya tetap sama)
  const BATCH_SIZE = 5;
  const MIN_DELAY = 10000; // 10 detik
  const MAX_DELAY = 15000; // 15 detik
  const BATCH_DELAY = 45000; // 45 detik antar batch

  const batches = chunkArray(rows, BATCH_SIZE);

  for (const [index, batch] of batches.entries()) {
    console.log(`🔄 Memproses batch ${index + 1}/${batches.length}`);

    for (const invoice of batch) {
      const message = `Pelanggan Yth.
Bapak/Ibu/Sdr : ${invoice.nama}
--------------------------------------------
Informasi Pembayaran Layanan CLEON
Nomor Pelanggan : ${invoice.no_pelanggan}
Layanan : ${invoice.layanan}
Periode Berjalan : ${formatDate(invoice.tanggal_pembayaran)} - ${formatDate(invoice.jatuh_tempo)}
Jatuh Tempo : ${formatDate(invoice.jatuh_tempo)}

TAGIHAN : Rp${invoice.tagihan}.000,00 Rupiah
--------------------------------------------
Untuk transfer bisa melalui:
1) Bank Mandiri - No.rek 1370011667371 atas nama Eksan Wahyu Nugroho
2) Bank BCA - No. rek 8465356509 atas nama Eksan Wahyu Nugroho
3) Bank BRI - No. rek 024501111055502 atas nama Eksan Wahyu Nugroho

Konfirmasikan pembayaran ke nomor wa.me/6281314152347`;

      try {
        await sendWhatsAppMessage(sock, invoice.no_telepon, message);
        console.log(`✅ Berhasil dikirim ke ${invoice.nama} dengan no.telp: ${invoice.no_telepon}`);
      } catch (error) {
        console.error(`❌ Gagal mengirim ke ${invoice.nama} dengan no.telp: ${invoice.no_telepon}:`, error);
      }

      const randomDelay = Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
      console.log(`⏳ Menunggu ${randomDelay / 1000} detik sebelum pesan berikutnya...`);
      await new Promise(resolve => setTimeout(resolve, randomDelay));
    }

    if (index < batches.length - 1) {
      console.log(`⏳ Menunggu ${BATCH_DELAY / 1000} detik sebelum batch berikutnya...`);
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    }
  }
  console.log('✅ Semua invoice terkirim!');
}




// Fungsi untuk connect ke WhatsApp just connect (auth only)
async function startBotSessionOnly() {
  if (sockInstance) {
    return sockInstance;
  }
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      console.log("connection.update:", update);
      const { connection, qr } = update;

      if (qr) {
        currentQR = await generateQRDataURL(qr);
        console.log("QR Code updated (tersimpan untuk web display).");
      }

      if (connection === "open") {
        console.log("✅ Bot terhubung ke WhatsApp!");
        currentQR = null;
      }

      if (connection === "close") {
        console.log("🔴 Koneksi terputus. Mencoba reconnect...");
        sockInstance = null;
        setTimeout(() => {
          startBotSessionOnly().catch(err => console.error("Reconnect error:", err));
        }, 5000);
      }
    });

    sockInstance = sock;
    return sock;
  } catch (err) {
    console.error("Error in startBotSessionOnly:", err);
    throw err;
  }
}


// Fungsi untuk menghubungkan ke WhatsApp dan memulai bot dan juga langsung kirim invoice processOverdueInvoices(sock)
async function startBot() {
  if (sockInstance) {
    return sockInstance;
  }
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      console.log("connection.update:", update);
      const { connection, qr } = update;

      if (qr) {
        currentQR = await generateQRDataURL(qr);
        console.log("QR Code updated (tersimpan untuk web display).");
      }

      if (connection === "open") {
        console.log("✅ Bot terhubung ke WhatsApp!");
        currentQR = null;
        await processOverdueInvoices(sock);
      }

      if (connection === "close") {
        console.log("🔴 Koneksi terputus. Mencoba reconnect...");
        sockInstance = null;
        setTimeout(() => {
          startBot().catch(err => console.error("Reconnect error:", err));
        }, 5000);
      }
    });

    

    sockInstance = sock;
    return sock;
  } catch (err) {
    console.error("Error in startBot:", err);
    throw err;
  }
}



// Fungsi reset bot dengan pendekatan alternatif menggunakan fs-extra dan clear cache
async function resetBot() {
  const authFolder = path.join(__dirname, 'auth');
  try {
    // Menghapus folder auth beserta seluruh isinya
    await fsExtra.remove(authFolder);
    console.log("Folder auth berhasil dihapus dengan fs-extra.");
  } catch (err) {
    console.error("Gagal menghapus folder auth:", err);
  }
  
  if (sockInstance) {
    try {
      // Tunda sejenak agar proses internal selesai
      await new Promise(resolve => setTimeout(resolve, 3000));
      // Jika ada fungsi logout, gunakan; jika tidak, tutup koneksi langsung
      if (typeof sockInstance.logout === 'function') {
        await sockInstance.logout().catch(err => console.error("Logout error:", err));
      } else {
        sockInstance.ws.close();
      }
    } catch (error) {
      console.error("Error saat memutus koneksi:", error.message);
    }
    sockInstance = null;
  }
  
  // Opsional: Hapus cache modul ini agar instance baru diinisialisasi
  delete require.cache[require.resolve(__filename)];
  
  // Inisialisasi ulang koneksi bot
  sockInstance = await startBotSessionOnly();
  console.log("Bot berhasil direset dan diinisialisasi ulang.");
  alert("Bot berhasil direset dan diinisialisasi ulang.");
}

// Fungsi untuk mendapatkan QR Code saat ini
function getCurrentQR() {
  return currentQR;
}

// Ekspor semua fungsi dan koneksi database agar bisa diakses di modul lain
module.exports = {
  db,
  startBot,
  processOverdueInvoices,
  sendWhatsAppMessage,
  getCurrentQR,
  resetBot,
  startBotSessionOnly
};