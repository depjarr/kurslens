# KursLens

Arahkan kamera ke label harga di luar negeri, dan harganya langsung muncul dalam rupiah (atau mata uang lain) sebagai stiker di atas label. AI juga menerjemahkan tulisan di kemasan dan membaca info gizinya.

- Kurs live (open.er-api.com) + tren naik/turun harian (Frankfurter)
- AI pembaca label: Google Gemini (ada jatah gratis) atau Claude
- Kamera belakang & depan; versi PC memakai webcam
- Tampilan HP, iPad/tablet, dan PC
- Tema Indigo terang/gelap (ikut mode perangkat) + Lembut, Monokrom, Kidcore, Stroberi
- Bisa dipasang sebagai aplikasi (PWA) di HP, iPad, dan laptop
- Tanpa database: preferensi & item tersimpan ada di perangkat pengguna

## Menjalankan

Butuh Node.js 20.6 atau lebih baru.

```bash
npm install
cp .env.example .env   # Windows PowerShell: Copy-Item .env.example .env
```

Isi `.env`:

```
AI_PROVIDER=gemini
GEMINI_API_KEY=key_dari_aistudio.google.com/apikey
```

Lalu:

```bash
npm start
```

Buka http://localhost:3000. Untuk mencoba tanpa API key: http://localhost:3000/?demo=1

Kamera dan instalasi aplikasi di HP butuh HTTPS, jadi untuk dicoba di HP perlu di-deploy dulu (atau lewat tunnel seperti ngrok).

## Ganti logo / ikon

Edit `public/icons/icon.svg`, `icon-maskable.svg`, dan `pipit.svg`, lalu:

```bash
npm run icons
```
