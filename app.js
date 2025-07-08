require('dotenv').config();
const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const app = express();
const port = process.env.PORT || 3000;
const session = require('express-session');

// Buat connection pool untuk MySQL
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'cleon_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

app.use(session({
  secret: 'secret-key', // ganti dengan secret yang aman
  resave: false,
  saveUninitialized: true,
}));
// Variabel global untuk progress invoice (jika dibutuhkan)
let invoiceProgress = 0;

// Impor fungsi penting dari file index.js
const {
  resetBot,
  processOverdueInvoices,
  startBot,
  getCurrentQR,
  startBotSessionOnly,
  sendWhatsAppMessage
} = require('./index');

// Global handler untuk unhandled promise rejections agar server tidak crash
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Jangan lakukan process.exit() agar server tetap berjalan.
});

// Sajikan file statis dari folder public
app.use(express.static(path.join(__dirname, 'public')));

// Middleware body parsing built-in Express
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Set template engine dan folder views
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

// Endpoint untuk mendapatkan QR Code saat ini
app.get('/qr', (req, res) => {
  res.json({ qr: getCurrentQR() });
});

app.post('/switch-table', (req, res) => {
  const { table } = req.body; // nilai: misalnya "users_test" atau "users"
  req.session.tableName = table;
  res.redirect('/'); // redirect ke halaman utama untuk melihat perubahan
});

// Endpoint untuk pengiriman invoice overdue secara manual
app.post('/send-overdue-invoices', async (req, res) => {
  try {
    const sock = await startBot();
    // Ambil nama tabel dari session, default ke "users" jika tidak ada
    const tableName = req.session.tableName || 'users';

    // Proses di background tanpa blocking response, dengan mengirimkan tableName
    processOverdueInvoices(sock, tableName)
      .then(() => console.log('✅ Proses selesai'))
      .catch(err => console.error('❌ Error:', err));

    res.json({ 
      status: 'success', 
      message: 'Pengiriman dimulai! Sistem akan mengirim 5 invoice per batch dengan jeda 10 detik.' 
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});


app.post('/update-payment-date', async (req, res) => {
  const { id, tanggal_pembayaran, jatuh_tempo } = req.body;
  const sql = `UPDATE users SET tanggal_pembayaran = ?, jatuh_tempo = ? WHERE id = ?`;
  try {
    await pool.query(sql, [tanggal_pembayaran, jatuh_tempo, id]);
    res.json({ status: 'success', message: 'Tanggal pembayaran berhasil diperbarui.' });
  } catch (err) {
    console.error("Update payment date error:", err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Endpoint untuk mengirim single invoice
app.post('/send-single-invoice', async (req, res) => {
  try {
    const { no_telepon, message } = req.body;
    const sock = await startBotSessionOnly();
    if (sock) {
      await sendWhatsAppMessage(sock, no_telepon, message);
      res.json({ status: 'success', message: `Invoice sent to ${no_telepon}` });
    } else {
      console.error("Bot tidak terhubung.");
      res.status(500).json({ status: 'error', message: 'Bot is not connected.' });
    }
  } catch (err) {
    console.error("Error pada /send-single-invoice:", err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/auth-only', async(req, res) => {
  try{
    const sock = await startBotSessionOnly();
    res.json({status: 'success', message: `Autentikasi telah berhasil dan terhubung ke whatsapp`});
  } catch (err){
    console.error("Bot tidak terhubung ke Whatsapp dengan kode error :", err);
    res.status(500).json({status: 'error', message: err.message})
  }
});

// Endpoint reset bot
app.post('/reset-bot', async (req, res) => {
  try {
    await resetBot();
    res.redirect('/');
  } catch (err) {
    console.error("Reset bot gagal:", err);
    res.status(500).json({ message: 'Reset bot failed.' });
  }
});

// Endpoint untuk progress pengiriman invoice (jika dibutuhkan)
app.get('/progress', (req, res) => {
  res.json({ progress: invoiceProgress });
});

// Endpoint halaman utama: Query data dan render view
app.get('/', async (req, res) => {
  // Ambil nama tabel dari session, default ke "users" jika belum dipilih
  const tableName = req.session.tableName || 'users';
  // Flag untuk tampilan dropdown
  const isTestMode = tableName === 'uji_coba';

  try {
    const [results] = await pool.query(`SELECT * FROM ${tableName}`);
    console.log('Hasil query dari tabel', tableName, ':', results);
    res.render('uji_coba', { results, isTestMode });
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).send('Internal Server Error');
  }
});


// Endpoint untuk menyimpan data baru
app.post('/save', async (req, res) => {
  const { no_pelanggan, nama, alamat, no_telepon, latitude, longitude, layanan, tanggal_pembayaran, jatuh_tempo, tagihan } = req.body;
  // Gunakan nama tabel dari session, default ke "users"
  const tableName = req.session.tableName || 'users';
  const sql = `INSERT INTO ${tableName} (no_pelanggan, nama, alamat, no_telepon, latitude, longitude, layanan, tanggal_pembayaran, jatuh_tempo, tagihan)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const values = [no_pelanggan, nama, alamat, no_telepon, latitude, longitude, layanan, tanggal_pembayaran, jatuh_tempo, tagihan];
  try {
    await pool.query(sql, values);
    res.redirect('/');
  } catch (err) {
    console.error("Save error:", err);
    res.status(500).json({ message: "Save failed" });
  }
});


// Endpoint untuk update data
app.post('/update', async (req, res) => {
  const { id, no_pelanggan, nama, alamat, no_telepon, latitude, longitude, layanan, tanggal_pembayaran, jatuh_tempo, tagihan } = req.body;
  const tableName = req.session.tableName || 'users';
  const sql = `UPDATE ${tableName} SET 
                 no_pelanggan = ?, nama = ?, alamat = ?, no_telepon = ?, latitude = ?, longitude = ?, layanan = ?, tanggal_pembayaran = ?, jatuh_tempo = ?, tagihan = ?
               WHERE id = ?`;
  const values = [no_pelanggan, nama, alamat, no_telepon, latitude, longitude, layanan, tanggal_pembayaran, jatuh_tempo, tagihan, id];
  try {
    await pool.query(sql, values);
    res.redirect('/');
  } catch (err) {
    console.error("Update error:", err);
    res.status(500).json({ message: "Update failed" });
  }
});


// Endpoint untuk menghapus data
app.post('/delete', async (req, res) => {
  const { id } = req.body;
  const tableName = req.session.tableName || 'users';
  const sql = `DELETE FROM ${tableName} WHERE id = ?`;
  try {
    await pool.query(sql, [id]);
    res.redirect('/');
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ message: "Delete failed" });
  }
});

// Global error handling middleware (harus diletakkan paling akhir)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ status: 'error', message: 'Internal Server Error' });
});

// Mulai server
app.listen(port, () => {
  console.log(`Server berjalan di http://localhost:${port}`);
});