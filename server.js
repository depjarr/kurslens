import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

import { fileURLToPath } from "node:url";

const app = express();
app.use(express.json({ limit: "8mb" }));
// Folder public dicari relatif ke file ini, jadi `npm start` bisa dijalankan dari folder mana pun.
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));

// ---------- Pilih AI ----------
// AI_PROVIDER=gemini (Google AI Studio, ada jatah gratis) atau claude.
// Kalau tidak diisi: pakai Gemini bila GEMINI_API_KEY ada, selain itu Claude.
const PROVIDER = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? "gemini" : "claude")).toLowerCase();
const MODEL =
  PROVIDER === "gemini"
    ? process.env.GEMINI_MODEL || "gemini-3.5-flash-lite"
    : process.env.CLAUDE_MODEL || "claude-opus-5-5";
const client = PROVIDER === "claude" && process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const gemini = PROVIDER === "gemini" && process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

// ---------- Kurs live (cache 10 menit) ----------
// open.er-api.com: gratis, tanpa key, ~160 mata uang, basis USD. Konversi silang di klien.
let ratesCache = null;
const RATES_TTL = 10 * 60 * 1000;

app.get("/api/rates", async (_req, res) => {
  try {
    if (!ratesCache || Date.now() - ratesCache.fetchedAt > RATES_TTL) {
      const r = await fetch("https://open.er-api.com/v6/latest/USD");
      const data = await r.json();
      if (data.result !== "success") throw new Error("rate provider error");
      ratesCache = {
        base: "USD",
        rates: data.rates,
        providerUpdated: data.time_last_update_utc,
        fetchedAt: Date.now(),
      };
    }
    res.json(ratesCache);
  } catch (err) {
    if (ratesCache) return res.json({ ...ratesCache, stale: true });
    res.status(502).json({ error: "Gagal mengambil kurs: " + err.message });
  }
});

// ---------- Tren kurs 14 hari (naik/turun) ----------
// Frankfurter (data bank sentral Eropa, harian). Tidak semua mata uang ada (mis. SAR, VND).
const trendCache = new Map();
const TREND_TTL = 60 * 60 * 1000;

app.get("/api/trend", async (req, res) => {
  const from = String(req.query.from || "").toUpperCase();
  const to = String(req.query.to || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return res.status(400).json({ error: "kode mata uang tidak valid" });
  const key = `${from}-${to}`;
  const hit = trendCache.get(key);
  if (hit && Date.now() - hit.at < TREND_TTL) return res.json(hit.data);
  try {
    const start = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    const r = await fetch(`https://api.frankfurter.dev/v1/${start}..?from=${from}&to=${to}`);
    if (!r.ok) throw new Error("tidak tersedia");
    const json = await r.json();
    const series = Object.entries(json.rates || {})
      .map(([date, v]) => ({ date, rate: v[to] }))
      .filter((p) => typeof p.rate === "number");
    if (series.length < 2) throw new Error("data kurang");
    const last = series.at(-1).rate, prev = series.at(-2).rate;
    const data = { from, to, series, changePct: ((last - prev) / prev) * 100, asOf: series.at(-1).date };
    trendCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: "Tren tidak tersedia untuk pasangan ini" });
  }
});

// ---------- AI scan ----------
const nullableNum = { type: ["number", "null"] };
const BOX = {
  type: "object",
  additionalProperties: false,
  required: ["found", "x", "y", "w", "h"],
  description: "kotak dalam koordinat 0..1 relatif terhadap gambar (x,y = pojok kiri atas)",
  properties: { found: { type: "boolean" }, x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
};

const SCAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "product_name_original", "product_name_translated", "prices", "price_box", "product_box", "text_translation", "nutrition", "allergens", "notes"],
  properties: {
    subject: {
      type: "string",
      enum: ["price_label", "product", "none"],
      description: "price_label = ada label/tag harga terbaca; product = produk terlihat tapi tanpa harga; none = tidak ada produk",
    },
    product_name_original: { type: "string" },
    product_name_translated: { type: "string" },
    prices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["amount", "currency", "label", "tax_included"],
        properties: {
          amount: { type: "number" },
          currency: { type: "string", description: "kode ISO 4217, mis. JPY" },
          label: { type: "string", description: "keterangan singkat, mis. 'Termasuk pajak'" },
          tax_included: { type: ["boolean", "null"] },
        },
      },
    },
    price_box: BOX,
    product_box: BOX,
    text_translation: {
      type: "array",
      description: "maks 4 tulisan penting di kemasan/label",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["original", "translated"],
        properties: { original: { type: "string" }, translated: { type: "string" } },
      },
    },
    nutrition: {
      type: "object",
      additionalProperties: false,
      required: ["calories_kcal", "protein_g", "fat_g", "carbs_g", "sugar_g", "salt_g", "serving", "source"],
      properties: {
        calories_kcal: nullableNum,
        protein_g: nullableNum,
        fat_g: nullableNum,
        carbs_g: nullableNum,
        sugar_g: nullableNum,
        salt_g: nullableNum,
        serving: { type: "string" },
        source: { type: "string", enum: ["label", "estimate", "none"] },
      },
    },
    allergens: { type: "array", items: { type: "string" } },
    notes: { type: "string", description: "info singkat: babi/alkohol/halal, kafein, dll. Kosong jika tidak ada" },
  },
};

// Gemini paling akurat memberi kotak dalam format bawaannya: box_2d = [ymin, xmin, ymax, xmax] skala 0..1000.
// Skema untuk Gemini sama, hanya kotaknya diganti, lalu dinormalkan ke {x,y,w,h} 0..1 sebelum dikirim ke browser.
const GEMINI_BOX = {
  type: "object",
  required: ["found", "box_2d"],
  properties: {
    found: { type: "boolean" },
    box_2d: {
      type: "array",
      description: "[ymin, xmin, ymax, xmax], skala 0..1000. Isi [0,0,0,0] jika found=false",
      items: { type: "integer" },
      minItems: 4,
      maxItems: 4,
    },
  },
};
const GEMINI_SCHEMA = {
  ...SCAN_SCHEMA,
  properties: { ...SCAN_SCHEMA.properties, price_box: GEMINI_BOX, product_box: GEMINI_BOX },
};

function fromBox2d(b) {
  const none = { found: false, x: 0, y: 0, w: 0, h: 0 };
  if (!b?.found || !Array.isArray(b.box_2d) || b.box_2d.length !== 4) return none;
  const [ymin, xmin, ymax, xmax] = b.box_2d.map((v) => Math.min(1000, Math.max(0, Number(v) || 0)) / 1000);
  if (xmax <= xmin || ymax <= ymin) return none;
  return { found: true, x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin };
}

function buildPrompt({ language, sourceCurrency, camera }) {
  const currencyHint =
    sourceCurrency === "auto"
      ? "Tentukan mata uang dari konteks (simbol, bahasa, toko). ¥/円 = JPY, ₩/원 = KRW, ฿ = THB, ₽/руб = RUB, RM = MYR, S$ = SGD."
      : `Anggap semua harga dalam ${sourceCurrency} kecuali jelas tertulis lain.`;
  const cameraHint =
    camera === "front"
      ? "Foto dari kamera depan/webcam: pengguna biasanya memegang produk ke arah kamera, jadi fokus ke produk yang dipegang, abaikan wajah/orang."
      : "Foto dari kamera belakang: biasanya rak toko dengan label harga.";
  const system =
    "Kamu asisten belanja untuk wisatawan. Dari foto kamera, kenali produk utama dan label harganya. " +
    "Tulisan bisa dalam bahasa apa pun (Jepang, Korea, Thai, Rusia, Mandarin, Arab, dll); baca dengan teliti. " +
    "Ambil semua harga yang terlihat untuk produk itu (di Jepang: 税込 = termasuk pajak, 税抜/本体価格 = sebelum pajak). " +
    `Terjemahkan nama produk dan tulisan penting ke ${language}. ` +
    "Gizi: pakai angka dari label gizi jika terlihat (source='label'); jika tidak, perkirakan dari jenis produk (source='estimate'); jika tidak bisa, null dan source='none'. " +
    "Kotak price_box mengelilingi label harga utama, product_box mengelilingi produk; found=false jika tidak ada. " +
    "Jangan mengarang harga: jika tidak terbaca, prices kosong. Jawab ringkas.";
  return { system, user: `${cameraHint} ${currencyHint}` };
}

async function scanWithClaude({ mime, data, prompt }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCAN_SCHEMA } },
    system: prompt.system,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data } },
          { type: "text", text: prompt.user },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") throw Object.assign(new Error("AI menolak memproses gambar ini."), { status: 422 });
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Respons AI kosong");
  return JSON.parse(text);
}

async function scanWithGemini({ mime, data, prompt }) {
  const response = await gemini.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [{ text: prompt.user }, { inlineData: { mimeType: mime, data } }],
      },
    ],
    config: {
      systemInstruction: prompt.system + " Kotak ditulis sebagai box_2d [ymin, xmin, ymax, xmax] skala 0..1000.",
      responseMimeType: "application/json",
      responseJsonSchema: GEMINI_SCHEMA,
    },
  });
  const text = response.text;
  if (!text) throw new Error("Gemini tidak memberi jawaban (mungkin gambar diblokir filter keamanan).");
  const out = JSON.parse(text);
  out.price_box = fromBox2d(out.price_box);
  out.product_box = fromBox2d(out.product_box);
  return out;
}

// Pesan error Google datang sebagai teks JSON; ambil bagian "message"-nya saja.
function readableError(err) {
  const raw = err?.message || "Gagal memproses gambar";
  try { return JSON.parse(raw).error?.message || raw; } catch { return raw; }
}

app.post("/api/scan", async (req, res) => {
  if (PROVIDER === "gemini" && !gemini) return res.status(500).json({ error: "GEMINI_API_KEY belum diisi di file .env" });
  if (PROVIDER === "claude" && !client) return res.status(500).json({ error: "ANTHROPIC_API_KEY belum diisi di file .env" });
  if (PROVIDER !== "gemini" && PROVIDER !== "claude") return res.status(500).json({ error: `AI_PROVIDER "${PROVIDER}" tidak dikenal. Pakai gemini atau claude.` });

  const { image, language = "Bahasa Indonesia", sourceCurrency = "auto", camera = "back" } = req.body || {};
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(image || "");
  if (!m) return res.status(400).json({ error: "Gambar tidak valid" });

  const args = { mime: m[1], data: m[2], prompt: buildPrompt({ language, sourceCurrency, camera }) };
  try {
    const result = PROVIDER === "gemini" ? await scanWithGemini(args) : await scanWithClaude(args);
    res.json(result);
  } catch (err) {
    console.error(err);
    const status = err.status === 422 ? 422 : err.status === 429 || err instanceof Anthropic.RateLimitError ? 429 : 500;
    const msg =
      status === 429
        ? PROVIDER === "gemini"
          ? "Batas pemakaian gratis Gemini tercapai. Tunggu sebentar lalu coba lagi."
          : "Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi."
        : /API_KEY_INVALID|API key not valid/.test(err.message || "")
          ? "GEMINI_API_KEY tidak valid. Cek lagi key dari aistudio.google.com/apikey."
          : readableError(err);
    res.status(status).json({ error: msg });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KursLens jalan di http://localhost:${PORT}  (AI: ${PROVIDER}, model: ${MODEL})`);
  if ((PROVIDER === "gemini" && !gemini) || (PROVIDER === "claude" && !client)) {
    const need = PROVIDER === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
    console.warn(`⚠  ${need} belum diisi — scan AI tidak akan jalan. Coba mode demo: http://localhost:${PORT}/?demo=1`);
  }
});
