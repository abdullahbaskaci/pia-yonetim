const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const db = require('./db');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const cron = require('node-cron');

// Merkezi Log Fonksiyonu (PostgreSQL uyumlu)
const activityLogger = async (req, res, next) => {
    // Sadece veri değişikliği yapan metodları izle
    const trackedMethods = ['POST', 'PUT', 'DELETE'];
    
    // İşlem bittiğinde çalışacak olay dinleyicisi
    res.on('finish', async () => {
        if (trackedMethods.includes(req.method) && res.statusCode < 400) {
            const adminId = req.headers['x-admin-id'] || 0;
            const adminName = req.headers['x-admin-name'] || 'Sistem/Bilinmiyor';
            const ip = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
            
            const islemTipi = `${req.method} ${req.path}`;
            const detay = `İstek Gövdesi: ${JSON.stringify(req.body)}`;

            try {
                await db.query(
                    "INSERT INTO logs (user_id, user_name, islem_tipi, detay, ip_adresi) VALUES ($1, $2, $3, $4, $5)",
                    [adminId, adminName, islemTipi, detay, ip]
                );
            } catch (err) {
                console.error("Otomatik Log Hatası:", err);
            }
        }
    });
    next();
};

// Tüm API isteklerinde bu middleware'i kullan
app.use('/api', activityLogger);

// Her ayın 1'inde saat 00:00'da çalışır
cron.schedule('0 0 1 * *', async () => {
    console.log("Aylık aidat borçlandırma işlemi başladı...");
    try {
        // 1. Tüm aktif daireleri ve aidat miktarlarını getir
        const daireler = await db.query("SELECT id, aidat_miktari FROM daireler WHERE aktif = true");
        
        const simdi = new Date();
        const donem = `${simdi.getFullYear()}-${simdi.getMonth() + 1}-01`;

        for (let daire of daireler.rows) {
            await db.query(
                "INSERT INTO tahakkuklar (daire_id, miktar, aciklama, donem) VALUES ($1, $2, $3, $4)",
                [daire.id, daire.aidat_miktari, `${simdi.getMonth() + 1}. Ay Aidatı`, donem]
            );
        }
        console.log("Borçlandırma başarıyla tamamlandı.");
    } catch (err) {
        console.error("Cron Job Hatası:", err);
    }
});
// ... (Dosya başındaki importlar aynı kalacak)

// 1. FİNANSAL AYARLARI GETİR (Yeni veya Güncellenmiş)
app.get('/api/finans-ayarlari', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM finans_ayarlari LIMIT 1");
        res.json(result.rows[0] || {});
    } catch (err) {
        res.status(500).json({ error: "Ayarlar alınamadı" });
    }
});

// 2. FİNANSAL AYARLARI GÜNCELLE (Tek ve Kapsamlı)
app.put('/api/finans-ayarlari', async (req, res) => {
    const { aidat_gunu, gecikme_gunu, gecikme_orani, aidat_tutari } = req.body;
    try {
        await db.query(
            `UPDATE finans_ayarlari 
             SET aidat_gunu = $1, gecikme_gunu = $2, gecikme_orani = $3, aidat_tutari = $4, guncelleme_tarihi = NOW()`,
            [aidat_gunu, gecikme_gunu, gecikme_orani, aidat_tutari]
        );
        res.json({ success: true, message: "Ayarlar başarıyla güncellendi." });
    } catch (err) {
        console.error("Güncelleme hatası:", err);
        res.status(500).send("Güncelleme hatası.");
    }
});

// 3. DİNAMİK OTOMATİK AİDAT FONKSİYONU
const otomatikAidatOlustur = async () => {
    try {
        // Ayarları veritabanından çek
        const ayarRes = await db.query("SELECT * FROM finans_ayarlari LIMIT 1");
        if (ayarRes.rows.length === 0) return;

        const { aidat_tutari, aidat_gunu } = ayarRes.rows[0];
        const bugun = new Date();
        
        // Sadece ayarlar panelinde belirlenen günde çalış
        if (bugun.getDate() !== aidat_gunu) return;

        console.log(`${bugun.toLocaleDateString()} - Otomatik aidat borçlandırma başlıyor...`);
        const donem = `${bugun.getMonth() + 1}-${bugun.getFullYear()}`;

        const insertQuery = `
            INSERT INTO borclar (daire_id, tur, miktar, aciklama, vade_tarihi, durum)
            SELECT id, 'Aidat', $1, $2, CURRENT_DATE + INTERVAL '15 days', 'Ödenmedi'
            FROM daireler
            WHERE durum = '1' AND id NOT IN (
                SELECT daire_id FROM borclar WHERE tur = 'Aidat' AND aciklama = $2
            )`;
        
        const result = await db.query(insertQuery, [aidat_tutari, `${donem} Dönemi Aidatı`]);
        if(result.rowCount > 0) console.log(`${result.rowCount} daire borçlandırıldı.`);
        
    } catch (err) {
        console.error("Otomatik aidat hatası:", err);
    }
};

 

// --- DOSYA YÜKLEME YAPILANDIRMASI (BELGELER) ---
const uploadDir = 'public/uploads/belgeler';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'belge-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// --- GİRİŞ SİSTEMİ (LOGIN) ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const query = `
            SELECT 
                d.id, d.sakin_ad_soyad, d.turu, d.daire_no, d.kat,
                b.blok_adi, 
                s.site_adi
            FROM daireler d
            LEFT JOIN bloklar b ON d.blok_id = b.id
            LEFT JOIN siteler s ON b.site_id = s.id
            WHERE d.giris_adi = $1 AND d.sifre = $2
        `;
        const result = await db.query(query, [username, password]);

        if (result.rows.length > 0) {
            const user = result.rows[0];
            res.json({
                success: true,
                id: user.id,
                username: user.sakin_ad_soyad,
                role: user.turu,
                turu: user.turu,
                site_adi: user.site_adi || 'Bilinmiyor',
                blok_adi: user.blok_adi || 'Bilinmiyor',
                kat: user.kat || '0',
                daire_no: user.daire_no || '-'
            });
        } else {
            res.status(401).json({ success: false, message: 'Kullanıcı adı veya şifre hatalı!' });
        }
    } catch (err) {
        console.error("Login Hatası:", err);
        res.status(500).json({ success: false, message: 'Sunucu hatası' });
    }
});

// --- SİTE İŞLEMLERİ ---
// --- TEK SİTE GETİR ---
app.get('/api/siteler/:id', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM siteler WHERE id = $1", [req.params.id]);
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ error: "Site bulunamadı" });
        }
    } catch (err) {
        res.status(500).json({ error: "Veritabanı hatası" });
    }
});

// --- SİTE GÜNCELLE ---
app.put('/api/siteler/:id', async (req, res) => {
    const { id } = req.params;
    let { site_adi, yonetici_ad_soyad, yonetici_gsm, adres, iban } = req.body;

    // IBAN Formatlama: Boşlukları kaldır, büyük harf yap 
    // TRCC BBBB BCCC CCCC CCCC CCCC CC formatına uygun hale getirmek için
    if (iban) {
        iban = iban.replace(/\s+/g, '').toUpperCase();
    }

    try {
        const query = `
            UPDATE siteler 
            SET site_adi = $1, yonetici_ad_soyad = $2, yonetici_gsm = $3, adres = $4, iban = $5 
            WHERE id = $6`;
        
        const values = [site_adi, yonetici_ad_soyad, yonetici_gsm, adres, iban, id];
        await db.query(query, values);
        
        res.json({ success: true, message: "Site ve yönetici bilgileri güncellendi." });
    } catch (err) {
        console.error("Güncelleme Hatası:", err);
        res.status(500).json({ success: false, error: "Güncelleme sırasında hata oluştu." });
    }
});
app.get('/api/siteler', async (req, res) => {
    try {
        const result = await db.query("SELECT id, site_adi FROM siteler ORDER BY site_adi ASC");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.post('/api/siteler', async (req, res) => {
    const { site_adi } = req.body;
    try {
        const result = await db.query(
            "INSERT INTO siteler (site_adi) VALUES ($1) RETURNING *",
            [site_adi]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Site eklenemedi" });
    }
});

// --- BLOK İŞLEMLERİ ---
app.get('/api/bloklar/:site_id', async (req, res) => {
    try {
        const result = await db.query(
            "SELECT id, blok_adi, bina_sorumlusu FROM bloklar WHERE site_id = $1 ORDER BY blok_adi ASC",
            [req.params.site_id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.post('/api/bloklar', async (req, res) => {
    const { site_id, blok_adi, bina_sorumlusu } = req.body;
    try {
        const result = await db.query(
            "INSERT INTO bloklar (site_id, blok_adi, bina_sorumlusu) VALUES ($1, $2, $3) RETURNING *",
            [site_id, blok_adi, bina_sorumlusu]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Blok eklenemedi" });
    }
});

app.put('/api/bloklar/:id', async (req, res) => {
    const { blok_adi, bina_sorumlusu } = req.body;
    try {
        await db.query(
            "UPDATE bloklar SET blok_adi = $1, bina_sorumlusu = $2 WHERE id = $3",
            [blok_adi, bina_sorumlusu, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Blok güncellenemedi" });
    }
});

app.delete('/api/bloklar/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('BEGIN');
        await db.query("DELETE FROM daireler WHERE blok_id = $1", [id]);
        const result = await db.query("DELETE FROM bloklar WHERE id = $1", [id]);
        await db.query('COMMIT');

        if (result.rowCount > 0) {
            res.json({ success: true, message: "Blok ve bağlı daireler başarıyla silindi." });
        } else {
            res.status(404).json({ success: false, message: "Blok bulunamadı." });
        }
    } catch (err) {
        await db.query('ROLLBACK');
        console.error("Blok Silme Hatası:", err);
        res.status(500).json({ success: false, error: "Veritabanı hatası oluştu." });
    }
});

// --- DAİRE İŞLEMLERİ ---
app.get('/api/admin/tum-daireler', async (req, res) => {
    try {
        const query = `
            SELECT d.id, d.daire_no, b.blok_adi, d.sakin_ad_soyad 
            FROM daireler d 
            JOIN bloklar b ON d.blok_id = b.id 
            ORDER BY b.blok_adi, CASE WHEN d.daire_no ~ '^\\d+$' THEN d.daire_no::int ELSE 999 END ASC`;
        const result = await db.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Daireler çekilirken hata:", err);
        res.status(500).json([]);
    }
});

app.get('/api/daireler/:blok_id', async (req, res) => {
    try {
        const blokSonuc = await db.query("SELECT blok_adi, bina_sorumlusu FROM bloklar WHERE id = $1", [req.params.blok_id]);
        if (blokSonuc.rows.length === 0) return res.status(404).json({ error: "Blok bulunamadı" });

        const blokBilgisi = blokSonuc.rows[0];
        const daireQuery = `
            SELECT id, daire_no, COALESCE(kat::text, '0') AS kat, sakin_ad_soyad, gsm, durum, turu, giris_adi, sifre
            FROM daireler WHERE blok_id = $1
            ORDER BY CASE WHEN daire_no ~ '^\\d+$' THEN daire_no::int ELSE 999 END ASC`;

        const daireSonuc = await db.query(daireQuery, [req.params.blok_id]);
        const donusVerisi = daireSonuc.rows.map(daire => ({
            ...daire,
            blok_adi: blokBilgisi.blok_adi,
            bina_sorumlusu: blokBilgisi.bina_sorumlusu
        }));

        res.json(donusVerisi.length > 0 ? donusVerisi : [{ id: null, blok_adi: blokBilgisi.blok_adi, bina_sorumlusu: blokBilgisi.bina_sorumlusu, bos_blok: true }]);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.put('/api/daireler/:id', async (req, res) => {
    const { daire_no, kat, sakin_ad_soyad, gsm, giris_adi, sifre, turu, durum } = req.body;
    try {
        await db.query(
            `UPDATE daireler SET daire_no=$1, kat=$2, sakin_ad_soyad=$3, gsm=$4, giris_adi=$5, sifre=$6, turu=$7, durum=$8 WHERE id=$9`,
            [daire_no, kat, sakin_ad_soyad, gsm, giris_adi, sifre, turu, durum, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/daireler/:id', async (req, res) => {
    try {
        await db.query("DELETE FROM daireler WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/daireler/toplu', async (req, res) => {
    const { blok_id, baslangic_no, adet } = req.body;
    try {
        const start = parseInt(baslangic_no);
        const count = parseInt(adet);
        for (let i = 0; i < count; i++) {
            await db.query(
                `INSERT INTO daireler (blok_id, daire_no, kat, durum, turu) VALUES ($1, $2, $3, $4, $5)`,
                [blok_id, (start + i).toString(), "0", "0", "Mülk Sahibi"]
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- TALEP İŞLEMLERİ ---
app.post('/api/talepler', async (req, res) => {
    const { userId, konu, aciklama } = req.body;
    try {
        const userRes = await db.query("SELECT sakin_ad_soyad FROM daireler WHERE id = $1", [userId]);
        const adSoyad = userRes.rows.length > 0 ? userRes.rows[0].sakin_ad_soyad : 'Bilinmeyen Sakin';

        const result = await db.query(
            "INSERT INTO talepler (sakin_ad_soyad, daire_id, konu, aciklama, durum) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            [adSoyad, userId, konu, aciklama, 'Bekliyor']
        );
        res.status(201).json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ success: false, error: "Veritabanı hatası" });
    }
});

app.get('/api/taleplerim/:daire_id', async (req, res) => {
    try {
        const result = await db.query(
            "SELECT * FROM talepler WHERE daire_id = $1 ORDER BY created_at DESC",
            [req.params.daire_id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.get('/api/admin/talepler', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT t.*, d.daire_no 
            FROM talepler t 
            JOIN daireler d ON t.daire_id = d.id 
            ORDER BY CASE WHEN t.durum = 'Bekliyor' THEN 1 ELSE 2 END, t.created_at DESC 
            LIMIT 50`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.put('/api/admin/talepler/:id', async (req, res) => {
    const { id } = req.params;
    const { durum, yonetici_notu } = req.body;
    try {
        await db.query(
            "UPDATE talepler SET durum = $1, yonetici_notu = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
            [durum, yonetici_notu, id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/admin/talepler/:id', async (req, res) => {
    try {
        await db.query("DELETE FROM talepler WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- DUYURU İŞLEMLERİ ---
app.post('/api/duyurular', async (req, res) => {
    const { baslik, icerik, oncelik } = req.body;
    try {
        const result = await db.query(
            "INSERT INTO duyurular (baslik, icerik, oncelik) VALUES ($1, $2, $3) RETURNING id",
            [baslik, icerik, oncelik]
        );
        res.status(201).json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ success: false, error: "Veritabanı hatası" });
    }
});

app.get('/api/duyurular', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM duyurular ORDER BY tarih DESC");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.delete('/api/duyurular/:id', async (req, res) => {
    try {
        await db.query("DELETE FROM duyurular WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- ADMİN İSTATİSTİKLERİ ---
app.get('/api/admin/stats', async (req, res) => {
    try {
        const totalDaire = await db.query('SELECT COUNT(*) as total FROM daireler');
        const activeDaire = await db.query("SELECT COUNT(*) as active FROM daireler WHERE durum = '1'");
        const pendingTalepler = await db.query("SELECT COUNT(*) as count FROM talepler WHERE durum = 'Bekliyor'");

        res.json({
            totalApartments: totalDaire.rows[0].total,
            activeApartments: activeDaire.rows[0].active,
            pendingRequests: pendingTalepler.rows[0].count
        });
    } catch (err) {
        res.status(500).json({ error: "İstatistikler alınamadı" });
    }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const result = await db.query(
            "SELECT sakin_ad_soyad as username, daire_no as apartment FROM daireler WHERE sakin_ad_soyad IS NOT NULL ORDER BY id DESC LIMIT 5"
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json([]);
    }
});

// --- FİNANSAL İŞLEMLER (SAKİN) ---
app.get('/api/sakin-borclar/:daire_id', async (req, res) => {
    try {
        const query = `
            SELECT id, tur, miktar, aciklama, vade_tarihi, durum
            FROM borclar 
            WHERE daire_id = $1 AND durum != 'Ödendi'
            ORDER BY vade_tarihi ASC`;
        const result = await db.query(query, [req.params.daire_id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.get('/api/sakin-odemeler/:daire_id', async (req, res) => {
    try {
        const query = `
            SELECT t.odenen_miktar as miktar, t.odeme_tarihi
            FROM tahsilatlar t
            JOIN borclar b ON t.borc_id = b.id
            WHERE b.daire_id = $1
        `;
        const result = await db.query(query, [req.params.daire_id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json([]);
    }
});

// --- FİNANSAL İŞLEMLER (ADMİN) ---
app.get('/api/finans/ozet', async (req, res) => {
    try {
        const query = `
            SELECT 
                COALESCE(SUM(CASE WHEN odeme_yontemi = 'Nakit' THEN odenen_miktar ELSE 0 END), 0) as nakit_toplam,
                COALESCE(SUM(CASE WHEN odeme_yontemi = 'Banka' THEN odenen_miktar ELSE 0 END), 0) as banka_toplam,
                (SELECT COALESCE(SUM(miktar), 0) FROM borclar WHERE durum != 'Ödendi' AND tur = 'Aidat') as bekleyen_aidat,
                (SELECT COALESCE(SUM(miktar), 0) FROM borclar WHERE durum != 'Ödendi' AND tur = 'Demirbaş') as bekleyen_demirbas,
                (SELECT COALESCE(SUM(miktar), 0) FROM borclar WHERE durum != 'Ödendi' AND tur = 'Yakıt') as bekleyen_yakit,
                (SELECT COALESCE(SUM(miktar), 0) FROM borclar WHERE durum != 'Ödendi') as toplam_alacak
            FROM tahsilatlar`;
        const result = await db.query(query);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ nakit_toplam: 0, banka_toplam: 0, bekleyen_aidat: 0, bekleyen_demirbas: 0, bekleyen_yakit: 0, toplam_alacak: 0 });
    }
});

app.get('/api/finans/liste', async (req, res) => {
    try {
        const query = `
            SELECT b.*, d.daire_no, d.sakin_ad_soyad, bl.blok_adi
            FROM borclar b
            JOIN daireler d ON b.daire_id = d.id
            JOIN bloklar bl ON d.blok_id = bl.id
            ORDER BY b.olusturma_tarihi DESC`;
        const result = await db.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.post('/api/finans/borclandir', async (req, res) => {
    const { daire_id, tur, miktar, aciklama, vade_tarihi } = req.body;
    try {
        if (daire_id === "tum_daireler") {
            const query = `
                INSERT INTO borclar (daire_id, tur, miktar, aciklama, vade_tarihi, durum)
                SELECT id, $1, $2, $3, $4, 'Ödenmedi'
                FROM daireler
                WHERE durum = '1'`;
            const result = await db.query(query, [tur, miktar, aciklama, vade_tarihi]);
            res.status(201).json({ success: true, message: `${result.rowCount} daireye borç yansıtıldı.` });
        } else {
            const query = `
                INSERT INTO borclar (daire_id, tur, miktar, aciklama, vade_tarihi, durum)
                VALUES ($1, $2, $3, $4, $5, 'Ödenmedi') RETURNING *`;
            const result = await db.query(query, [daire_id, tur, miktar, aciklama, vade_tarihi]);
            res.status(201).json({ success: true, data: result.rows[0] });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: "Borçlandırma hatası" });
    }
});

app.post('/api/finans/tahsilat', async (req, res) => {
    const { borc_id, miktar, odeme_yontemi } = req.body;
    try {
        await db.query('BEGIN');
        await db.query(`INSERT INTO tahsilatlar (borc_id, odenen_miktar, odeme_yontemi) VALUES ($1, $2, $3)`, [borc_id, miktar, odeme_yontemi]);
        await db.query(`UPDATE borclar SET durum = 'Ödendi' WHERE id = $1`, [borc_id]);
        await db.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ success: false, error: "Tahsilat hatası" });
    }
});

app.post('/api/finans/odeme-iptal/:borc_id', async (req, res) => {
    const { borc_id } = req.params;
    try {
        await db.query('BEGIN');
        await db.query(`DELETE FROM tahsilatlar WHERE borc_id = $1`, [borc_id]);
        await db.query(`UPDATE borclar SET durum = 'Ödenmedi' WHERE id = $1`, [borc_id]);
        await db.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ success: false });
    }
});
app.delete('/api/finans/borc-sil/:id', async (req, res) => {
    const borcId = req.params.id;
    // Header'dan gelen verileri oku
    const adminId = req.headers['x-admin-id'];
    const adminName = req.headers['x-admin-name'];

    try {
        // Log için borç miktarını ve daireyi öğren
        const borcSorgu = await db.query("SELECT miktar, daire_id FROM borclar WHERE id = $1", [borcId]);
        
        if (borcSorgu.rows.length > 0) {
            const borc = borcSorgu.rows[0];
            
            await db.query("DELETE FROM borclar WHERE id = $1", [borcId]);

            // LOG KAYDETME BURADA ÇAĞRILIYOR
            await logKaydet(adminId, adminName, "BORC_SILME", `${borcId} ID'li borç silindi.`, req);
            
            res.json({ success: true });
        } else {
            res.status(404).json({ error: "Borç bulunamadı" });
        }
    } catch (err) {
        console.error(err);
        res.status(500).send("Hata oluştu");
    }
});

app.post('/api/finans/toplu-borc-sil', async (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false });
    try {
        await db.query('BEGIN');
        await db.query("DELETE FROM tahsilatlar WHERE borc_id = ANY($1)", [ids]);
        await db.query("DELETE FROM borclar WHERE id = ANY($1)", [ids]);
        await db.query('COMMIT');
        res.json({ success: true, message: `${ids.length} adet kayıt silindi.` });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ success: false });
    }
});

// --- BELGE ARŞİV İŞLEMLERİ ---
app.post('/api/belgeler', upload.single('belge'), async (req, res) => {
    const { baslik, kategori, tarih, tutar, aciklama } = req.body;
    const dosya_yolu = req.file ? `/uploads/belgeler/${req.file.filename}` : null;
    try {
        const query = `INSERT INTO belgeler (baslik, kategori, tarih, tutar, aciklama, dosya_yolu) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
        const values = [baslik, kategori, tarih, tutar === "" ? null : tutar, aciklama, dosya_yolu];
        const result = await db.query(query, values);
        res.status(201).json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ success: false, error: "Veritabanı kayıt hatası" });
    }
});

app.get('/api/belgeler', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM belgeler ORDER BY tarih DESC");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.patch('/api/belgeler/:id/yayin-durumu', async (req, res) => {
    const { id } = req.params;
    const { is_public } = req.body;
    try {
        await db.query("UPDATE belgeler SET is_public = $1 WHERE id = $2", [is_public, id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Güncelleme hatası" });
    }
});

app.delete('/api/belgeler/:id', async (req, res) => {
    try {
        const findRes = await db.query("SELECT dosya_yolu FROM belgeler WHERE id = $1", [req.params.id]);
        if (findRes.rows.length > 0 && findRes.rows[0].dosya_yolu) {
            const fullPath = path.join(__dirname, 'public', findRes.rows[0].dosya_yolu);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
        await db.query("DELETE FROM belgeler WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});
 
// --- SİTE SİLME (YENİ EKLENDİ) ---
app.delete('/api/siteler/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.query('BEGIN');
        
        // 1. Önce bu siteye bağlı bloklardaki daireleri sil
        await db.query(`
            DELETE FROM daireler 
            WHERE blok_id IN (SELECT id FROM bloklar WHERE site_id = $1)
        `, [id]);
        
        // 2. Siteye bağlı blokları sil
        await db.query("DELETE FROM bloklar WHERE site_id = $1", [id]);
        
        // 3. En son siteyi sil
        const result = await db.query("DELETE FROM siteler WHERE id = $1", [id]);
        
        await db.query('COMMIT');

        if (result.rowCount > 0) {
            res.json({ success: true, message: "Site ve bağlı tüm veriler silindi." });
        } else {
            res.status(404).json({ success: false, message: "Site bulunamadı." });
        }
    } catch (err) {
        await db.query('ROLLBACK');
        console.error("Site Silme Hatası:", err);
        res.status(500).json({ success: false, error: "Veritabanı hatası." });
    }
});
// 1. Fonksiyonu Güncelle (PostgreSQL uyumlu)
async function logKaydet(userId, userName, islem, detay, req) {
    try {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
        const query = "INSERT INTO logs (user_id, user_name, islem_tipi, detay, ip_adresi) VALUES ($1, $2, $3, $4, $5)";
        await db.query(query, [userId || 0, userName || 'Sistem', islem, detay, ip]);
    } catch (err) {
        console.error("Log hatası:", err);
    }
}

// 2. Borç Silme API'sini Güncelle
app.delete('/api/finans/borc-sil/:id', async (req, res) => {
    const borcId = req.params.id;
    // Frontend'den gelen header'ları alıyoruz
    const adminId = req.headers['x-admin-id'];
    const adminName = req.headers['x-admin-name'];

    try {
        // Silmeden önce bilgi al
        const result = await db.query("SELECT miktar, daire_id FROM borclar WHERE id = $1", [borcId]);
        if (result.rows.length > 0) {
            const borc = result.rows[0];
            
            // Silme işlemi
            await db.query("DELETE FROM borclar WHERE id = $1", [borcId]);

            // LOG KAYDET
            await logKaydet(
                adminId, 
                adminName, 
                "BORC_SILME", 
                `ID: ${borcId} olan ${borc.miktar} TL tutarındaki borç silindi.`, 
                req
            );
            res.json({ success: true });
        } else {
            res.status(404).json({ error: "Borç bulunamadı" });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Sunucu hatası" });
    }
});
// --- SUNUCU BAŞLATMA ---
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Sunucu Aktif: http://localhost:${PORT}`);
    setInterval(otomatikAidatOlustur, 24 * 60 * 60 * 1000); // 24 saatte bir kontrol
    otomatikAidatOlustur(); // Başlangıçta çalıştır
});