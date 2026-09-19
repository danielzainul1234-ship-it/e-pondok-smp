# E-Pondok SMP

Website Sistem Informasi dan Manajemen Pondok Pesantren tingkat SMP — front end publik (Beranda, Profil Pondok, Struktur Pengurus, Data Santri, Kegiatan, Hafalan, Informasi) dan dashboard internal berbasis peran (Admin, Pengurus, Ustadz/Ustadzah, Santri).

## Menjalankan secara lokal

```bash
npm install
npm start
```

Buka `http://localhost:3000`.

## Deploy ke Railway

Repo ini sudah menyertakan `package.json`, `server.js` (static file server tanpa dependency eksternal), dan `railway.json` sehingga Railway (Nixpacks) bisa langsung mendeteksi dan menjalankannya sebagai aplikasi Node.

1. Buka [railway.app](https://railway.app) dan login.
2. **New Project → Deploy from GitHub repo**, pilih repo ini.
3. Railway otomatis build & jalankan `npm start`.
4. Setelah deploy selesai, buka tab **Settings → Networking** pada service ini dan klik **Generate Domain** untuk mendapatkan URL publik (`*.up.railway.app`).

## Akun demo

| Role | Username | Password |
|---|---|---|
| Admin | `admin` | `admin123` |
| Pengurus | `pengurus` | `pengurus123` |
| Ustadz/Ustadzah | `ustadz` | `ustadz123` |
| Santri | `santri` | `santri123` |
