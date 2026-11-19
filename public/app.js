// KursLens — kamera + AI + kurs live. Tanpa database: kurs dari API publik,
// pembacaan produk dari AI, preferensi & item tersimpan di localStorage perangkat.

const $ = (id) => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has("demo");

const THEMES = [
  { id: "indigo", name: "Indigo", desc: "Bersih & terang" },
  { id: "indigo-gelap", name: "Indigo Gelap", desc: "Mode gelap" },
  { id: "lembut", name: "Lembut", desc: "Lavender & peach" },
  { id: "monokrom", name: "Monokrom", desc: "Hitam putih elegan" },
  { id: "kidcore", name: "Kidcore", desc: "Ceria, warna primer" },
  { id: "stroberi", name: "Stroberi", desc: "Pink manis" },
];
const POPULAR = ["JPY", "KRW", "SGD", "MYR", "THB", "SAR", "CNY", "USD", "EUR", "AUD", "HKD", "TWD", "GBP", "IDR"];
const ZERO_DEC = new Set(["IDR", "JPY", "KRW", "VND", "CLP", "ISK", "HUF", "TWD"]);

const store = {
  get(k, d) { try { const v = localStorage.getItem("kl." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("kl." + k, JSON.stringify(v)); } catch {} },
};

const state = {
  theme: store.get("theme", "indigo"),
  themeAuto: store.get("themeAuto", true), // ikut mode terang/gelap perangkat (Indigo ↔ Indigo Gelap)
  from: store.get("from", "auto"),
  to: store.get("to", "IDR"),
  lang: store.get("lang", "Bahasa Indonesia"),
  auto: store.get("auto", true),
  saved: store.get("saved", []),
  facing: "environment",
  rates: null,
  trend: null,
  result: null,        // hasil AI terakhir
  resultMeta: null,    // { at, source }
  resultFresh: false,  // false = kamera sudah pindah, stiker disembunyikan
  lastCurrency: store.get("lastCurrency", null),
  busy: false,
  error: null,
  manualOpen: false,
  pick: "from",        // kartu mana yang aktif di halaman mata uang
  diet: store.get("diet", []),        // id profil makanan, lihat DIET_OPTIONS
  lastImage: null,                    // foto terakhir yang di-scan, untuk kartu Bagikan
};

const DIET_OPTIONS = [
  { id: "halal", label: "Halal", group: "diet" },
  { id: "no-pork", label: "Tanpa babi", group: "diet" },
  { id: "no-alcohol", label: "Tanpa alkohol", group: "diet" },
  { id: "vegetarian", label: "Vegetarian", group: "diet" },
  { id: "vegan", label: "Vegan", group: "diet" },
  { id: "peanut", label: "Kacang", ai: "Alergi kacang", group: "allergy" },
  { id: "shellfish", label: "Udang & kerang", ai: "Alergi udang & kerang", group: "allergy" },
  { id: "fish", label: "Ikan", ai: "Alergi ikan", group: "allergy" },
  { id: "milk", label: "Susu", ai: "Alergi susu", group: "allergy" },
  { id: "egg", label: "Telur", ai: "Alergi telur", group: "allergy" },
  { id: "wheat", label: "Gandum / gluten", ai: "Alergi gandum/gluten", group: "allergy" },
  { id: "soy", label: "Kedelai", ai: "Alergi kedelai", group: "allergy" },
  { id: "sesame", label: "Wijen", ai: "Alergi wijen", group: "allergy" },
];
const dietForAI = () => DIET_OPTIONS.filter((o) => state.diet.includes(o.id)).map((o) => o.ai || o.label);

// ---------------- Layout: phone / tablet / desktop ----------------
// PC = layar lebar + mouse → tampilan web dengan webcam (kamera depan saja).
const mqDesk = matchMedia("(min-width: 1024px) and (hover: hover) and (pointer: fine)");
const mqTab = matchMedia("(min-width: 700px)");
const isDesk = () => document.documentElement.dataset.layout === "desktop";
function applyLayout() {
  const layout = mqDesk.matches ? "desktop" : mqTab.matches ? "tablet" : "phone";
  const prev = document.documentElement.dataset.layout;
  if (prev === layout) return;
  document.documentElement.dataset.layout = layout;
  if (layout === "desktop") {
    $("detail").hidden = true;
    if (state.facing !== "user") { state.facing = "user"; if (stream) startCamera(); }
  } else if (prev === "desktop") {
    state.facing = "environment"; // HP/tablet: kembali ke kamera belakang
    if (stream || $("demoScene")) startCamera();
  }
  requestAnimationFrame(() => renderAll());
}
mqDesk.addEventListener("change", applyLayout);
mqTab.addEventListener("change", applyLayout);

const names = (() => { try { return new Intl.DisplayNames(["id"], { type: "currency" }); } catch { return null; } })();
const curName = (c) => { try { return names?.of(c) || c; } catch { return c; } };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------- Theme ----------------
const mqDark = matchMedia("(prefers-color-scheme: dark)");
const resolvedTheme = () => (state.themeAuto ? (mqDark.matches ? "indigo-gelap" : "indigo") : state.theme);

// id diisi = pengguna memilih tema sendiri → mode otomatis dimatikan
function applyTheme(id) {
  if (id) {
    state.theme = id;
    state.themeAuto = false;
    store.set("theme", id);
    store.set("themeAuto", false);
  }
  document.documentElement.dataset.theme = resolvedTheme();
  const box = $("themeAuto");
  if (box) box.checked = state.themeAuto;
  renderThemeGrid();
}
mqDark.addEventListener("change", () => state.themeAuto && applyTheme());

// ---------------- Money ----------------
function convert(amount, from, to) {
  const r = state.rates?.rates;
  if (!r || !r[from] || !r[to]) return null;
  return (amount / r[from]) * r[to];
}
function fmt(amount, cur, forceDec) {
  const dec = forceDec ?? (ZERO_DEC.has(cur) ? 0 : 2);
  try {
    // CNY pakai "CN¥" supaya tidak tertukar dengan yen Jepang (¥)
    const display = cur === "CNY" ? "symbol" : "narrowSymbol";
    return new Intl.NumberFormat("id-ID", { style: "currency", currency: cur, currencyDisplay: display, minimumFractionDigits: dec, maximumFractionDigits: dec })
      .format(amount).replace(/\s/g, "");
  } catch { return `${amount.toLocaleString("id-ID")} ${cur}`; }
}
const fmtRate = (v, cur) => fmt(v, cur, v < 1000 ? 2 : 0);
const effFrom = () => (state.from === "auto" ? state.lastCurrency : state.from);

function mainPrice(r) {
  const ps = r?.prices || [];
  if (!ps.length) return null;
  return ps.find((p) => p.tax_included === true) || ps[0];
}
function priceCur(p) { return state.from === "auto" ? (p.currency || "").toUpperCase() : state.from; }

// ---------------- Rates & trend ----------------
async function loadRates() {
  try {
    const r = await fetch("/api/rates");
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    state.rates = data;
    const t = new Date(data.fetchedAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
    $("rateTime").textContent = `kurs ${t}${data.stale ? " · offline" : ""}`;
  } catch (e) {
    $("rateTime").textContent = "Kurs gagal dimuat";
  }
  renderAll();
  loadTrend();
}

async function loadTrend() {
  const f = effFrom(), t = state.to;
  state.trend = null;
  if (f && f !== t) {
    try {
      const r = await fetch(`/api/trend?from=${f}&to=${t}`);
      if (r.ok) state.trend = await r.json();
    } catch {}
  }
  renderPair();
  renderTrendBox();
}

// ---------------- Camera ----------------
const video = $("video"), still = $("still");
let stream = null;

async function startCamera() {
  if (isDesk()) state.facing = "user";
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: state.facing }, width: { ideal: 2560 }, height: { ideal: 1440 } },
      audio: false,
    });
    video.srcObject = stream;
    $("noCam").hidden = true;
    removeDemoScene();
  } catch {
    $("noCam").hidden = !!DEMO;
    if (DEMO) addDemoScene();
  }
  const front = state.facing === "user";
  video.classList.toggle("mirror", front);
  $("flipBtn").classList.toggle("front", front);
  $("flipBtn").setAttribute("aria-label", front ? "Ganti ke kamera belakang" : "Ganti ke kamera depan");
  $("camLabel").hidden = !front;
  $("camLabel").textContent = isDesk() ? "Webcam · teks dibalik otomatis" : "Kamera depan · teks dibalik otomatis";
}

function liveReady() { return !!stream && video.videoWidth > 0 && still.hidden; }

const canvas = document.createElement("canvas");
// Foto dikirim sampai 1920 px (sisi terpanjang) supaya label harga yang agak jauh masih terbaca
function grab(source, w, h) {
  const max = 1920, s = Math.min(1, max / Math.max(w, h));
  canvas.width = Math.round(w * s);
  canvas.height = Math.round(h * s);
  // gambar mentah (tidak dicerminkan) → teks kamera depan terbaca normal oleh AI
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.86);
}

// --- deteksi pindah produk (beda gambar) ---
const thumbC = document.createElement("canvas");
thumbC.width = 24; thumbC.height = 18;
const thumbX = thumbC.getContext("2d", { willReadFrequently: true });
let prevThumb = null, scanThumb = null, stableTicks = 0;

function thumb() {
  thumbX.drawImage(video, 0, 0, 24, 18);
  const d = thumbX.getImageData(0, 0, 24, 18).data, g = new Uint8Array(24 * 18);
  for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return g;
}
function diff(a, b) {
  if (!a || !b) return 255;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

setInterval(() => {
  if (!liveReady() || document.hidden || $("camera").hidden) return;
  const t = thumb();
  const moved = diff(t, scanThumb);
  const still_ = diff(t, prevThumb) < 6;
  prevThumb = t;
  stableTicks = still_ ? stableTicks + 1 : 0;

  // kamera pindah jauh dari gambar yang di-scan → stiker lama tidak cocok lagi
  if (state.result && state.resultFresh && moved > 18) {
    state.resultFresh = false;
    renderOverlay();
    renderCard();
  }
  // Auto: scan begitu kamera diam di objek baru
  if (state.auto && !state.busy && stableTicks >= 2 && (scanThumb === null || moved > 18)) {
    scan();
  }
}, 400);

// ---------------- Scan ----------------
async function scan(image) {
  if (state.busy) return;
  let source = "back";
  if (!image) {
    if (!still.hidden) { still.hidden = true; video.hidden = false; }
    if (liveReady()) {
      scanThumb = thumb();
      image = grab(video, video.videoWidth, video.videoHeight);
      source = state.facing === "user" ? "front" : "back";
    } else if (DEMO) {
      source = state.facing === "user" ? "front" : "back";
    } else {
      toast("Kamera belum siap. Coba unggah foto.");
      return;
    }
  } else {
    source = "gallery";
  }

  state.busy = true;
  state.error = null;
  document.body.classList.add("scanning");
  renderCard();
  try {
    let data;
    if (DEMO) {
      await new Promise((r) => setTimeout(r, 700));
      data = demoResult(source);
    } else {
      const r = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image, language: state.lang, sourceCurrency: state.from,
          camera: source === "front" ? "front" : "back",
          diet: dietForAI(), // AI sendiri yang menentukan: produk/label harga atau menu restoran
        }),
      });
      data = await r.json();
      if (!r.ok) throw new Error(data.error);
    }
    state.result = data;
    state.lastImage = image || null;
    state.resultMeta = { at: new Date(), source, mirror: source === "front" };
    state.resultFresh = true;
    state.manualOpen = false;
    const p = mainPrice(data);
    const detected = data.kind === "menu" ? data.currency : p?.currency || data.currency;
    state.detectedCur = detected ? detected.toUpperCase() : null;
    if (detected && state.from === "auto") {
      const cur = detected.toUpperCase();
      if (cur !== state.lastCurrency) { state.lastCurrency = cur; store.set("lastCurrency", cur); loadTrend(); }
    }
  } catch (e) {
    state.error = e.message || "Gagal memproses gambar";
  } finally {
    state.busy = false;
    document.body.classList.remove("scanning");
    renderAll();
  }
}

async function fromFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    still.src = url;
    still.hidden = false;
    scan(grab(img, img.naturalWidth, img.naturalHeight));
  };
  img.src = url;
}

// ---------------- Overlay (stiker di atas label) ----------------
function frameSize() {
  const cam = $("stage");
  if (!still.hidden && still.naturalWidth) return { fw: still.naturalWidth, fh: still.naturalHeight };
  if (video.videoWidth) return { fw: video.videoWidth, fh: video.videoHeight };
  return { fw: cam.clientWidth, fh: cam.clientHeight };
}
function mapBox(b) {
  const cam = $("stage"), cw = cam.clientWidth, ch = cam.clientHeight;
  const { fw, fh } = frameSize();
  const s = Math.max(cw / fw, ch / fh), ox = (cw - fw * s) / 2, oy = (ch - fh * s) / 2;
  let x = b.x * fw * s + ox;
  const w = b.w * fw * s;
  if (state.resultMeta?.mirror) x = cw - (x + w);
  return { x, y: b.y * fh * s + oy, w, h: b.h * fh * s, cw, ch };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Area kamera yang tidak tertutup tombol: di HP/tablet ada bar atas + chip di atas,
// dan dock tombol + kartu hasil di bawah. Stiker tidak boleh jatuh di belakangnya.
function visibleRect(el) {
  if (!el || el.hidden || !el.offsetParent) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? r : null;
}
function freeArea() {
  const stage = $("stage"), sr = stage.getBoundingClientRect();
  let top = 16;
  const blockers = [];
  if (!isDesk()) {
    for (const el of [document.querySelector(".cam-top"), document.querySelector(".cam-chips")]) {
      const r = visibleRect(el);
      if (r) top = Math.max(top, r.bottom - sr.top + 10);
    }
    for (const el of [document.querySelector(".dock"), $("card")]) {
      const r = visibleRect(el);
      // offsetTop: posisi akhir (tidak terpengaruh animasi muncul kartu)
      if (r) blockers.push({ left: r.left - sr.left, right: r.right - sr.left, top: el.offsetTop - stage.offsetTop });
    }
  }
  return { top, blockers, cw: stage.clientWidth, ch: stage.clientHeight };
}
// Taruh elemen (stiker/label produk) di area bebas: utamakan posisi yang diminta,
// kalau menabrak tombol di bawah, naikkan; tidak pernah lebih tinggi dari chip atas.
function placeFree(el, left, top, area) {
  const w = el.offsetWidth, h = el.offsetHeight;
  left = clamp(left, 12, area.cw - w - 12);
  let bottom = area.ch - 16;
  for (const b of area.blockers) {
    if (left < b.right && left + w > b.left) bottom = Math.min(bottom, b.top - 12);
  }
  const maxTop = Math.max(area.top, bottom - h);
  el.style.left = left + "px";
  el.style.top = clamp(top, area.top, maxTop) + "px";
}

// Angka harga "berputar" dari 0 ke nilai akhir saat stiker baru muncul
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
function countUp(el, value, cur, animate) {
  cancelAnimationFrame(el._raf);
  if (!animate || reduceMotion.matches) { el.textContent = fmt(value, cur); return; }
  el.textContent = fmt(0, cur);
  const start = performance.now(), dur = 700;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur), eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(value * eased, cur);
    if (t < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

// Mata uang label rak: pilihan pengguna, atau yang dikenali AI
function shelfCur(r) {
  return state.from === "auto" ? (r.currency || mainPrice(r)?.currency || "").toUpperCase() : state.from;
}

// Stiker kecil untuk label harga lain di rak (foto agak jauh berisi banyak produk)
function renderShelfTags(r, area, animate) {
  let layer = $("shelfLayer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "shelfLayer";
    $("overlay").prepend(layer);
  }
  layer.innerHTML = "";
  if (!r || !state.resultFresh || r.kind === "menu") return;
  const cur = shelfCur(r);
  (r.shelf_tags || []).forEach((t, i) => {
    if (!t.box?.found || !(t.price > 0)) return;
    const v = convert(t.price, cur, state.to);
    if (v == null) return;
    const b = mapBox(t.box);
    const ring = document.createElement("div");
    ring.className = "shelf-ring";
    Object.assign(ring.style, { left: b.x - 4 + "px", top: b.y - 4 + "px", width: b.w + 8 + "px", height: b.h + 8 + "px" });
    const el = document.createElement("button");
    el.className = "shelf-sticker";
    el.dataset.open = "detail";
    el.setAttribute("aria-label", `${t.name_translated || "Produk"}: ${fmt(v, state.to)}`);
    el.innerHTML = `<b>${esc(fmt(v, state.to))}</b><small>${esc(fmt(t.price, cur))}</small>`;
    layer.append(ring, el);
    countUp(el.querySelector("b"), v, state.to, animate);
    placeFree(el, b.x + b.w / 2 - el.offsetWidth / 2, b.y - el.offsetHeight - 8, area);
  });
}

function renderOverlay() {
  const st = $("sticker"), corners = $("corners"), tag = $("productTag");
  const r = state.result;
  st.hidden = corners.hidden = tag.hidden = true;
  const area = freeArea(), { cw, ch } = area;
  // animasi angka hanya untuk hasil scan baru, bukan saat kurs diperbarui atau layar diputar
  const animate = !!r && state.resultFresh && state.animatedFor !== r;
  if (animate) state.animatedFor = r;
  renderShelfTags(r, area, animate);
  if (!r || !state.resultFresh || r.subject === "none" || r.kind === "menu") return;
  const warn = state.diet.length > 0 && r.diet_check?.status === "tidak_cocok";
  st.classList.toggle("warn", warn);
  st.querySelector(".st-hint").textContent = warn ? "tidak cocok untukmu" : "ketuk untuk detail";

  const p = mainPrice(r);
  const boxSrc = p && r.price_box?.found ? r.price_box : r.product_box?.found ? r.product_box : null;
  const box = boxSrc ? mapBox(boxSrc) : null;

  if (box) {
    Object.assign(corners.style, { left: box.x - 10 + "px", top: box.y - 10 + "px", width: box.w + 20 + "px", height: box.h + 20 + "px" });
    corners.hidden = false;
  }

  if (p) {
    const cur = priceCur(p), conv = convert(p.amount, cur, state.to);
    $("stCode").textContent = state.to;
    if (conv != null) countUp($("stAmount"), conv, state.to, animate);
    else $("stAmount").textContent = "—";
    $("stSub").textContent = `${fmt(p.amount, cur)}${p.label ? " · " + p.label.toLowerCase() : ""}`;
    st.hidden = false;
    const sw = st.offsetWidth, sh = st.offsetHeight;
    const left = box ? box.x + box.w / 2 - sw / 2 : cw / 2 - sw / 2;
    let top = box ? box.y - sh - 18 : ch * 0.32;
    if (box && top < area.top) top = box.y + box.h + 18; // tidak muat di atas label → taruh di bawahnya
    placeFree(st, left, top, area);
  } else if (r.product_name_translated) {
    tag.innerHTML = esc(r.product_name_translated);
    tag.hidden = false;
    const tw = tag.offsetWidth;
    let left = box ? box.x + box.w + 12 : cw / 2 - tw / 2;
    if (box && left + tw > cw - 12) left = box.x - tw - 12;
    placeFree(tag, left, box ? box.y + box.h * 0.3 : ch * 0.35, area);
  }
}

// ---------------- Profil makanan: tanda cocok / tidak ----------------
const DIET_ICON = {
  cocok: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7"/></svg>',
  tidak_cocok: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>',
  tidak_pasti: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="5.5"/><path d="M7 4v3.5M7 10h.01"/></svg>',
};
const DIET_TEXT = { cocok: "Cocok untukmu", tidak_cocok: "Tidak cocok", tidak_pasti: "Belum pasti" };
const DIET_CLASS = { cocok: "diet-ok", tidak_cocok: "diet-bad", tidak_pasti: "diet-unsure" };

function dietBadge(status, reason) {
  if (!state.diet.length || !DIET_CLASS[status]) return "";
  const label = reason && status !== "cocok" ? `${DIET_TEXT[status]}: ${reason}` : DIET_TEXT[status];
  return `<span class="diet-badge ${DIET_CLASS[status]}">${DIET_ICON[status]}<span>${esc(label)}</span></span>`;
}
function dietBanner(check) {
  if (!state.diet.length || !check || !DIET_CLASS[check.status]) return "";
  const reasons = (check.reasons || []).filter(Boolean);
  return `<div class="diet-banner ${DIET_CLASS[check.status]}">
    <b>${DIET_ICON[check.status]}${DIET_TEXT[check.status]} dengan profilmu</b>
    ${reasons.length ? `<ul>${reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
  </div>`;
}

// ---------------- Mode menu restoran ----------------
function menuPriceHtml(price, cur) {
  if (price == null || !cur) return `<b>—</b>`;
  const v = convert(price, cur, state.to);
  return `<b>${v != null ? fmt(v, state.to) : "?"}</b><small>${fmt(price, cur)}</small>`;
}
function menuCur(r) { return state.from === "auto" ? (r.currency || "").toUpperCase() : state.from; }

function menuHtml(r) {
  const items = r.items || [];
  if (!r.found || !items.length) {
    return `<h1 class="detail-title" style="margin-top:0">Belum ada menu terbaca</h1>
      <p class="fine" style="margin:6px 0 0">Foto menu lebih dekat dan pastikan tulisannya tidak buram.</p>`;
  }
  const cur = menuCur(r), one = cur ? convert(1, cur, state.to) : null;
  const bad = items.filter((i) => i.diet_status === "tidak_cocok").length;
  let h = `<div class="menu-head"><h1 class="detail-title" style="margin-top:0">Menu · ${items.length} item</h1></div>
    <div class="detail-orig">${one != null ? `1 ${esc(cur)} = ${fmtRate(one, state.to)}` : esc(cur)}${state.diet.length ? ` · ${bad} tidak cocok untukmu` : ""}</div>
    <div class="menu-list">`;
  for (const it of items) {
    h += `<div class="menu-item">
      <div><b>${esc(it.name_translated || it.name_original)}</b><div class="orig jp">${esc(it.name_original)}</div></div>
      <div class="price">${menuPriceHtml(it.price, cur)}</div>
      ${it.description ? `<p class="desc">${esc(it.description)}</p>` : ""}
      ${(it.tags?.length || state.diet.length) ? `<div class="tags">${dietBadge(it.diet_status, it.diet_reason)}${(it.tags || []).map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
    </div>`;
  }
  h += `</div>`;
  if (r.notes) h += `<div class="note">${esc(r.notes)}</div>`;
  h += `<p class="fine" style="margin:12px 0 0">Dibaca AI dari foto. Tanyakan ke pelayan kalau kamu punya alergi.</p>` + actionsHtml();
  return h;
}

function actionsHtml() {
  return `<div class="actions">
      <button class="btn btn-line" id="saveBtn">Simpan</button>
      <button class="btn btn-line" id="shareBtn">Bagikan</button>
      <button class="btn btn-primary wide" data-close="detail" data-rescan>Scan lagi</button>
    </div>`;
}

// ---------------- Card ----------------
function chipsHtml(r, n = 3) {
  const out = [];
  const kcal = r.nutrition?.calories_kcal;
  if (kcal != null) out.push(`${Math.round(kcal)} kkal`);
  for (const a of r.allergens || []) out.push(a);
  return out.slice(0, n).map((c) => `<span>${esc(c)}</span>`).join("");
}

function renderCard() {
  const card = $("card"), r = state.result;
  if (isDesk()) { card.innerHTML = ""; card.hidden = true; return; } // PC: hasil tampil di panel samping
  let html = "";
  if (state.busy && !r) {
    html = `<div class="loading"><img class="loading-pipit" src="/icons/pipit.svg" alt="" /><span class="dots">Pipit lagi membaca label</span></div>`;
  } else if (state.error && !r) {
    html = `<p class="error">${esc(state.error)}</p>`;
  } else if (!r) {
    card.hidden = true;
    $("camera").style.setProperty("--card-h", "0px");
    return;
  } else if (r.kind === "menu") {
    const items = r.items || [];
    const bad = items.filter((i) => i.diet_status === "tidak_cocok").length;
    html = items.length && r.found
      ? `<div class="card-row ${state.resultFresh ? "" : "stale"}">
          <div style="flex:1;min-width:0">
            <div class="eyebrow">${state.busy ? "Membaca menu…" : "Menu terbaca"}</div>
            <div class="card-title">${items.length} item menu</div>
            <div class="card-sub">${esc(items.slice(0, 3).map((i) => i.name_translated || i.name_original).join(", "))}${items.length > 3 ? ", …" : ""}</div>
            ${state.diet.length ? `<div class="chips">${bad ? `<span class="diet-bad">${bad} tidak cocok</span>` : `<span class="diet-ok">Tidak ada yang melanggar profil</span>`}</div>` : ""}
          </div>
          <button class="round-go" data-open="detail" aria-label="Lihat semua menu">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>
          </button>
        </div>`
      : `<div class="eyebrow">${state.busy ? "Membaca…" : "Belum terbaca"}</div>
        <div class="card-title">Belum ada menu terbaca</div>
        <div class="card-sub">Foto menu lebih dekat dan pastikan tulisannya jelas.</div>`;
  } else if (r.subject === "none") {
    html = `<div class="eyebrow">${state.busy ? "Membaca…" : "Belum terbaca"}</div>
      <div class="card-title">Belum ada produk terlihat</div>
      <div class="card-sub">Dekatkan kamera ke label harga, produk, atau menu.</div>`;
  } else {
    const p = mainPrice(r);
    const eyebrow = state.busy ? "Membaca produk baru…" : !state.resultFresh ? "Hasil sebelumnya" : p ? "Terdeteksi" : "Produk dikenali";
    html = `<div class="card-row ${state.resultFresh ? "" : "stale"}">
        <div style="flex:1;min-width:0">
          <div class="eyebrow">${eyebrow}</div>
          <div class="card-title">${esc(r.product_name_translated || r.product_name_original)}</div>
          ${p ? "" : `<div class="card-sub jp">${esc(r.product_name_original)}</div>`}
          ${dietBadge(r.diet_check?.status, r.diet_check?.reasons?.[0])}
          <div class="chips">${chipsHtml(r)}</div>
        </div>
        <button class="round-go" data-open="detail" aria-label="Lihat detail">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>
        </button>
      </div>`;
    if (!p) {
      html += state.manualOpen
        ? `<form class="manual" id="manualForm">
             <label class="sr-only" for="manualAmt">Harga dalam ${esc(effFrom() || "JPY")}</label>
             <input id="manualAmt" inputmode="decimal" placeholder="Harga dalam ${esc(effFrom() || "JPY")}" autocomplete="off" />
             <button class="small-btn">Hitung</button>
           </form>`
        : `<div class="card-foot"><p>Harga tidak terlihat. Arahkan ke label rak, atau isi sendiri.</p>
             <button class="small-btn" id="manualBtn">Isi harga</button></div>`;
    }
  }
  if (state.error && r) html += `<p class="error" style="margin-top:10px">${esc(state.error)}</p>`;
  card.innerHTML = html;
  card.hidden = false;
  $("camera").style.setProperty("--card-h", card.offsetHeight + 20 + "px");
  if (state.manualOpen) $("manualAmt")?.focus();
}

// ---------------- Detail ----------------
function renderDetail() {
  if (isDesk()) return renderSidePanel();
  const r = state.result;
  if (!r || $("detail").hidden) return;
  $("detailMeta").textContent = metaText();
  $("detailBody").innerHTML = detailHtml(r);
}

function metaText() {
  const meta = state.resultMeta;
  const src = { back: "Kamera belakang", front: isDesk() ? "Webcam" : "Kamera depan", gallery: "Foto galeri" }[meta?.source] || "";
  return `Dipindai ${meta?.at.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })} · ${src}`;
}

function renderSidePanel() {
  const el = $("sidePanel"), r = state.result;
  let h = "";
  if (!r || (r.subject === "none" && r.kind !== "menu")) {
    h = `<div class="panel-empty"><img class="panel-pipit" src="/icons/pipit.svg" alt="" />
      ${state.busy ? `<div class="loading"><div class="spinner"></div><span class="dots">Pipit lagi membaca label</span></div>` : `<div class="eyebrow">${r ? "Belum terbaca" : "Siap scan"}</div>`}
      <h2>${r ? "Belum ada produk terlihat" : "Pegang produk di depan webcam"}</h2>
      <p>Harga, terjemahan kemasan, dan info gizi akan muncul di sini.</p>
      <ol>
        <li><span>1</span>Pilih mata uang tujuan di atas</li>
        <li><span>2</span>Dekatkan produk atau label harga ke webcam</li>
        <li><span>3</span>Tekan <b>Scan sekarang</b>, atau nyalakan Auto</li>
      </ol>
      ${state.error ? `<p class="error" style="margin-top:14px">${esc(state.error)}</p>` : ""}
    </div>`;
  } else {
    h = `<div class="eyebrow" style="margin-bottom:12px">${state.busy ? "Membaca produk baru…" : esc(metaText())}</div>` + detailHtml(r);
    if (state.error) h += `<p class="error" style="margin-top:12px">${esc(state.error)}</p>`;
  }
  el.innerHTML = h;
}

function detailHtml(r) {
  if (r.kind === "menu") return menuHtml(r);
  const p = mainPrice(r);
  let h = "";
  if (p) {
    const cur = priceCur(p), conv = convert(p.amount, cur, state.to), one = convert(1, cur, state.to);
    h += `<div class="hero-price">
        <div class="top"><span>HARGA DALAM ${esc(state.to)}</span><span>${one != null ? `1 ${esc(cur)} = ${fmtRate(one, state.to)}` : ""}</span></div>
        <div class="amount">${conv != null ? fmt(conv, state.to) : "—"}</div>
        <div class="sub">${fmt(p.amount, cur)}${p.label ? " · " + esc(p.label.toLowerCase()) : ""}</div>
      </div>`;
    if (r.prices.length > 1) {
      h += `<div class="price-table">` + r.prices.map((q) => {
        const c = priceCur(q), v = convert(q.amount, c, state.to);
        return `<div class="price-row"><span class="lbl">${esc(q.label || "Harga")}</span><span class="orig">${fmt(q.amount, c)}</span><span class="conv">${v != null ? fmt(v, state.to) : "?"}</span></div>`;
      }).join("") + `</div>`;
    }
  }
  h += `<h1 class="detail-title" style="${p ? "" : "margin-top:0"}">${esc(r.product_name_translated || "Produk")}</h1>
        <div class="detail-orig jp">${esc(r.product_name_original)}</div>` + dietBanner(r.diet_check);

  // Label harga lain yang terbaca di rak yang sama
  const others = (r.shelf_tags || []).filter((t) => t.price > 0);
  if (others.length) {
    const cur = shelfCur(r);
    h += `<div class="h2">Harga lain di rak ini</div><div class="price-table">` + others.map((t) => {
      const v = convert(t.price, cur, state.to);
      return `<div class="price-row"><span class="lbl">${esc(t.name_translated || t.name_original || "Produk lain")}</span>
        <span class="orig">${fmt(t.price, cur)}</span><span class="conv">${v != null ? fmt(v, state.to) : "?"}</span></div>`;
    }).join("") + `</div>`;
  }
  if (!p && isDesk()) {
    const cur = esc(effFrom() || "JPY");
    h += `<div class="panel-manual"><p>Harga tidak terlihat. Dekatkan label harga ke webcam, atau isi sendiri.</p>
      <form class="manual" id="manualForm"><label class="sr-only" for="manualAmt">Harga dalam ${cur}</label>
        <input id="manualAmt" inputmode="decimal" placeholder="Harga dalam ${cur}" autocomplete="off" />
        <button class="small-btn">Hitung</button></form></div>`;
  }

  if (r.text_translation?.length) {
    h += `<div class="h2">Tulisan di kemasan</div><div class="tr-list">` +
      r.text_translation.map((t) => `<div class="tr"><small class="jp">${esc(t.original)}</small><b>${esc(t.translated)}</b></div>`).join("") + `</div>`;
  }

  const n = r.nutrition;
  if (n && n.source !== "none") {
    const c = (n.carbs_g || 0) * 4, f = (n.fat_g || 0) * 9, pr = (n.protein_g || 0) * 4, tot = c + f + pr;
    const g = (v, u) => (v == null ? "—" : `${String(Math.round(v * 10) / 10).replace(".", ",")} ${u}`);
    h += `<div class="h2"><span>Gizi ${esc(n.serving ? "· " + n.serving : "")}</span><span class="badge">${n.source === "label" ? "dari label" : "perkiraan AI"}</span></div>
      <div class="nutri">
        <div class="kcal"><b>${n.calories_kcal == null ? "—" : Math.round(n.calories_kcal)}</b><span>kkal</span></div>
        ${tot > 0 ? `<div class="energy" role="img" aria-label="Sumber energi: karbohidrat ${Math.round(c / tot * 100)}%, lemak ${Math.round(f / tot * 100)}%, protein ${Math.round(pr / tot * 100)}%">
          <i style="flex:${c};background:var(--primary)"></i><i style="flex:${f};background:var(--chart-2);box-shadow:var(--outline)"></i><i style="flex:${pr};background:var(--muted)"></i></div>` : ""}
        <div class="macro-grid">
          <div><small><i style="background:var(--primary)"></i>Karbo</small><b>${g(n.carbs_g, "g")}</b></div>
          <div><small><i style="background:var(--chart-2);box-shadow:var(--outline)"></i>Lemak</small><b>${g(n.fat_g, "g")}</b></div>
          <div><small><i style="background:var(--muted)"></i>Protein</small><b>${g(n.protein_g, "g")}</b></div>
        </div>
        ${n.sugar_g != null ? `<div class="kv"><span>Gula</span><b>${g(n.sugar_g, "g")}</b></div>` : ""}
        ${n.salt_g != null ? `<div class="kv"><span>Garam</span><b>${g(n.salt_g, "g")}</b></div>` : ""}
      </div>`;
  }
  if (r.allergens?.length) {
    h += `<div class="h2">Alergen</div><div class="big-chips">${r.allergens.map((a) => `<span>${esc(a)}</span>`).join("")}</div>`;
  }
  if (r.notes) h += `<div class="note">${esc(r.notes)}</div>`;
  h += `<p class="fine" style="margin:12px 0 0">Dibaca AI dari foto. Cek ulang label kalau kamu punya alergi.</p>` + actionsHtml();
  return h;
}

// ---------------- Pair + currency page ----------------
function renderPair() {
  const f = effFrom();
  // Mode otomatis diberi tanda kecil "auto" supaya jelas mata uangnya ikut label
  $("pairFrom").innerHTML = state.from === "auto"
    ? `${esc(f || "Auto")}${f ? '<i class="auto-tag">auto</i>' : ""}`
    : esc(state.from);

  // Mata uang dipilih manual, tapi label yang di-scan jelas pakai mata uang lain → tawarkan ganti
  const warn = $("curWarn");
  const det = state.detectedCur;
  const mismatch = state.from !== "auto" && det && det !== state.from && state.rates?.rates?.[det];
  warn.hidden = !mismatch;
  if (mismatch) warn.innerHTML = `Label pakai ${esc(det)}, bukan ${esc(state.from)} · <b>Ganti</b>`;
  $("pairTo").textContent = state.to;
  const one = f ? convert(1, f, state.to) : null;
  const rate = $("pairRate");
  rate.hidden = one == null || f === state.to;
  if (!rate.hidden) rate.textContent = fmtRate(one, state.to);
  $("pairBtn").classList.toggle("has-rate", !rate.hidden);

  const chip = $("trendChip");
  const tr = state.trend;
  chip.hidden = !tr;
  if (tr) {
    const up = tr.changePct >= 0;
    chip.classList.toggle("up", up);
    chip.classList.toggle("down", !up);
    chip.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="${up ? "M5 1.5l3.5 6h-7z" : "M5 8.5l3.5-6h-7z"}" fill="currentColor"/></svg>
      ${Math.abs(tr.changePct).toFixed(2).replace(".", ",")}% ${up ? "naik" : "turun"} dari kemarin`;
  }
}

function renderTrendBox() {
  const box = $("trendBox"), tr = state.trend;
  box.hidden = !tr;
  if (!tr) return;
  const vals = tr.series.map((p) => p.rate), min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 116 + 2},${40 - ((v - min) / span) * 36}`).join(" ");
  const up = tr.changePct >= 0;
  box.innerHTML = `<div><small>1 ${tr.from} · ${tr.series.length} hari kerja terakhir</small>
      <b>${fmtRate(tr.series.at(-1).rate, tr.to)}</b>
      <small><span class="${up ? "up" : "down"}">${up ? "▲" : "▼"}</span> ${Math.abs(tr.changePct).toFixed(2).replace(".", ",")}% dari hari sebelumnya</small></div>
    <svg viewBox="0 0 120 44" role="img" aria-label="Grafik kurs ${tr.from} ke ${tr.to}, ${up ? "naik" : "turun"}">
      <polyline points="${pts}" fill="none" stroke="var(${up ? "--up" : "--down"})" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
}

function renderCurrencyPage() {
  if ($("currency").hidden || !state.rates) return;
  const f = state.from;
  $("fromCode").textContent = f === "auto" ? "Auto" : f;
  $("fromName").textContent = f === "auto" ? (state.lastCurrency ? `Terakhir: ${state.lastCurrency}` : "Deteksi otomatis") : curName(f);
  $("toCode").textContent = state.to;
  $("toName").textContent = curName(state.to);
  $("fromCard").classList.toggle("active", state.pick === "from");
  $("toCard").classList.toggle("active", state.pick === "to");
  $("autoRow").hidden = state.pick !== "from";
  $("autoDetect").checked = f === "auto";
  $("listFor").textContent = state.pick === "from" ? "Dari" : "Ke";
  $("listUnit").textContent = state.pick === "from" ? `1 unit dalam ${state.to}` : "";

  const q = $("curSearch").value.trim().toLowerCase();
  const all = Object.keys(state.rates.rates);
  const ordered = [...POPULAR.filter((c) => all.includes(c)), ...all.filter((c) => !POPULAR.includes(c)).sort()];
  const sel = state.pick === "from" ? (f === "auto" ? null : f) : state.to;
  $("curList").innerHTML = ordered
    .filter((c) => !q || c.toLowerCase().includes(q) || curName(c).toLowerCase().includes(q))
    .slice(0, q ? 60 : 40)
    .map((c) => {
      const one = state.pick === "from" ? convert(1, c, state.to) : null;
      const on = c === sel;
      return `<button class="cur-row ${on ? "sel" : ""}" data-cur="${c}" aria-pressed="${on}">
        <span class="code">${c}</span><span class="name">${esc(curName(c))}</span>
        <span class="rate">${one != null && c !== state.to ? fmtRate(one, state.to) : ""}</span>
        <span class="check">${on ? `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.5l2.5 2.5 4.5-5"/></svg>` : ""}</span>
      </button>`;
    }).join("");
}

function setCurrency(which, code) {
  state[which] = code;
  store.set(which, code);
  renderAll();
  loadTrend();
}

// ---------------- Settings ----------------
function renderThemeGrid() {
  $("themeGrid").innerHTML = THEMES.map((t) => `
    <button class="theme-card" data-theme="${t.id}" data-pick-theme="${t.id}" aria-pressed="${t.id === resolvedTheme()}">
      <div class="theme-prev" aria-hidden="true"><span class="s">Rp16.054</span><span class="b"><i></i><u></u></span></div>
      <div class="tn"><b>${t.name}</b><small>${t.desc}</small></div>
    </button>`).join("");
}
function renderSaved() {
  const el = $("savedList");
  el.innerHTML = state.saved.length
    ? state.saved.map((s, i) => `<div class="saved-item"><div><b>${esc(s.name)}</b><small>${esc(s.orig)} · ${esc(s.when)}</small></div>
        <span class="p">${esc(s.conv)}</span>
        <button class="icon-btn plain" data-del="${i}" aria-label="Hapus ${esc(s.name)}">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button></div>`).join("")
    : `<p class="empty">Belum ada. Tekan "Simpan" di halaman detail produk.</p>`;
}

function renderDiet() {
  const btn = (o) => `<button data-diet="${o.id}" aria-pressed="${state.diet.includes(o.id)}">${esc(o.label)}</button>`;
  $("dietDiet").innerHTML = DIET_OPTIONS.filter((o) => o.group === "diet").map(btn).join("");
  $("dietAllergy").innerHTML = DIET_OPTIONS.filter((o) => o.group === "allergy").map(btn).join("");
}


// ---------------- Bagikan (WhatsApp, dll) ----------------
function loadImg(src) {
  return new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
}
function wrapLines(ctx, text, maxW, maxLines) {
  const words = String(text).split(/\s+/), lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…"; }
  return lines;
}

// Kartu gambar 1080×1350 (pas untuk WhatsApp/Instagram): foto, nama, harga rupiah, harga asli.
async function makeShareImage(r) {
  await document.fonts.ready;
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  const font = getComputedStyle(document.body).fontFamily;
  const W = 1080, H = 1350, pad = 56;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  x.fillStyle = v("--sheet"); x.fillRect(0, 0, W, H);

  // foto produk
  const ph = 600;
  x.save();
  x.beginPath(); x.roundRect(pad, pad, W - pad * 2, ph, 40); x.clip();
  x.fillStyle = v("--soft"); x.fillRect(pad, pad, W - pad * 2, ph);
  try {
    const img = await loadImg(state.lastImage || "/icons/pipit.svg");
    if (state.lastImage) {
      const s = Math.max((W - pad * 2) / img.width, ph / img.height);
      const w = img.width * s, h = img.height * s;
      x.drawImage(img, pad + (W - pad * 2 - w) / 2, pad + (ph - h) / 2, w, h);
    } else {
      x.drawImage(img, W / 2 - 150, pad + ph / 2 - 166, 300, 332);
    }
  } catch {}
  x.restore();

  // harga
  const p = mainPrice(r);
  let y = pad + ph + 40;
  if (p) {
    const cur = priceCur(p), conv = convert(p.amount, cur, state.to);
    x.fillStyle = v("--hero");
    x.beginPath(); x.roundRect(pad, y, W - pad * 2, 252, 36); x.fill();
    x.fillStyle = v("--hero-ink");
    x.font = `700 30px ${font}`; x.globalAlpha = 0.8;
    x.fillText(`HARGA DALAM ${state.to}`, pad + 40, y + 62);
    x.globalAlpha = 1; x.font = `800 112px ${font}`;
    x.fillText(conv != null ? fmt(conv, state.to) : "—", pad + 36, y + 170);
    x.font = `600 34px ${font}`; x.globalAlpha = 0.85;
    x.fillText(`${fmt(p.amount, cur)}${p.label ? " · " + p.label.toLowerCase() : ""}`, pad + 40, y + 222);
    x.globalAlpha = 1;
    y += 252 + 56;
  }
  // nama produk
  x.fillStyle = v("--ink"); x.font = `800 52px ${font}`;
  for (const line of wrapLines(x, r.product_name_translated || r.product_name_original || "Produk", W - pad * 2, 2)) {
    x.fillText(line, pad, y + 10); y += 62;
  }
  x.fillStyle = v("--muted"); x.font = `500 32px 'IBM Plex Sans JP', ${font}`;
  for (const line of wrapLines(x, r.product_name_original || "", W - pad * 2, 1)) { x.fillText(line, pad, y + 8); y += 44; }

  // kaki: logo + tanggal
  try { x.drawImage(await loadImg("/icons/icon.svg"), pad, H - pad - 72, 72, 72); } catch {}
  x.fillStyle = v("--ink"); x.font = `800 36px ${font}`;
  x.fillText("KursLens", pad + 92, H - pad - 30);
  x.fillStyle = v("--muted"); x.font = `500 26px ${font}`;
  x.fillText(`kurs ${new Date().toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}`, pad + 92, H - pad + 2);

  return new Promise((ok) => c.toBlob(ok, "image/png"));
}

function shareText(r) {
  if (r.kind === "menu") {
    const cur = menuCur(r);
    const lines = (r.items || []).slice(0, 25).map((it) => {
      const v = it.price != null && cur ? convert(it.price, cur, state.to) : null;
      const price = v != null ? `${fmt(v, state.to)} (${fmt(it.price, cur)})` : "harga tidak tertulis";
      const warn = state.diet.length && it.diet_status === "tidak_cocok" ? " [tidak cocok]" : "";
      return `• ${it.name_translated || it.name_original}: ${price}${warn}`;
    });
    return `Menu (${(r.items || []).length} item), dicek pakai KursLens:\n${lines.join("\n")}`;
  }
  const p = mainPrice(r);
  let t = r.product_name_translated || r.product_name_original || "Produk";
  if (p) {
    const cur = priceCur(p), v = convert(p.amount, cur, state.to);
    t += `: ${v != null ? fmt(v, state.to) : "?"} (${fmt(p.amount, cur)})`;
  }
  return t + ". Dicek pakai KursLens.";
}

// HP: menu "Bagikan" bawaan (WhatsApp, Telegram, dll) dengan gambar kartu.
// Laptop tanpa menu itu: gambar diunduh, lalu WhatsApp Web dibuka dengan teksnya.
async function shareResult() {
  const r = state.result;
  if (!r) return;
  const text = shareText(r);
  let blob = null;
  if (r.kind !== "menu") blob = await makeShareImage(r).catch(() => null);
  try {
    const file = blob && new File([blob], "kurslens.png", { type: "image/png" });
    if (file && navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], text });
    if (navigator.share) return await navigator.share({ text });
  } catch (e) {
    if (e?.name === "AbortError") return; // pengguna menutup menu bagikan
  }
  if (blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "kurslens.png"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");
  toast(blob ? "Gambar diunduh, WhatsApp dibuka" : "WhatsApp dibuka");
}

// ---------------- Navigation ----------------
function show(id) {
  for (const v of ["welcome", "how", "camera"]) $(v).hidden = v !== id;
  if (id === "camera") {
    store.set("onboarded", true);
    if (!stream) startCamera();
  }
}
function openSheet(id) {
  if (id === "detail" && isDesk()) { $("sidePanel").scrollTo({ top: 0, behavior: "smooth" }); return; }
  $(id).hidden = false;
  if (id === "currency") { state.pick = "from"; $("curSearch").value = ""; renderCurrencyPage(); renderTrendBox(); }
  if (id === "settings") { renderThemeGrid(); renderDiet(); renderSaved(); }
  if (id === "detail") renderDetail();
}
function closeSheet(id) { $(id).hidden = true; }

function renderAll() {
  renderPair();
  renderCard(); // kartu dulu: tingginya menentukan posisi dock, lalu stiker menghindari keduanya
  renderOverlay();
  renderDetail();
  renderCurrencyPage();
}

let toastT;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 2200);
}

// ---------------- Events ----------------
document.addEventListener("click", (e) => {
  const el = e.target.closest("button, [data-go], [data-open], [data-close]");
  if (!el) return;
  if (el.dataset.go) return show(el.dataset.go);
  if (el.dataset.open) return openSheet(el.dataset.open);
  if (el.dataset.close) {
    closeSheet(el.dataset.close);
    if (el.hasAttribute("data-rescan")) scan();
    return;
  }
  if (el.dataset.pickTheme) return applyTheme(el.dataset.pickTheme);
  if (el.dataset.diet) {
    const id = el.dataset.diet;
    state.diet = state.diet.includes(id) ? state.diet.filter((d) => d !== id) : [...state.diet, id];
    store.set("diet", state.diet);
    el.setAttribute("aria-pressed", state.diet.includes(id));
    return renderAll();
  }
  if (el.dataset.cur) {
    setCurrency(state.pick, el.dataset.cur);
    if (state.pick === "from") { state.pick = "to"; renderCurrencyPage(); }
    return;
  }
  if (el.dataset.del) {
    state.saved.splice(Number(el.dataset.del), 1);
    store.set("saved", state.saved);
    return renderSaved();
  }
  switch (el.id) {
    case "shutter": return scan();
    case "flipBtn":
      state.facing = state.facing === "user" ? "environment" : "user";
      scanThumb = null; state.resultFresh = false; renderOverlay(); renderCard();
      return startCamera();
    case "autoBtn":
      state.auto = !state.auto;
      store.set("auto", state.auto);
      el.setAttribute("aria-pressed", state.auto);
      return toast(state.auto ? "Auto: scan otomatis saat kamera diam di produk baru" : "Auto mati: tekan tombol untuk scan");
    case "sticker": return openSheet("detail");
    case "pairBtn": return openSheet("currency");
    case "settingsBtn": return openSheet("settings");
    case "fromCard": state.pick = "from"; return renderCurrencyPage();
    case "toCard": state.pick = "to"; return renderCurrencyPage();
    case "swapBtn": {
      const f = effFrom();
      if (!f) return toast("Scan dulu atau pilih mata uang asal");
      const to = state.to;
      state.to = f; store.set("to", f);
      setCurrency("from", to);
      return;
    }
    case "manualBtn": state.manualOpen = true; return renderCard();
    case "installBtn": return installApp();
    case "shareBtn": return shareResult();
    case "curWarn":
      setCurrency("from", "auto");
      return toast(`Mata uang kembali otomatis: ${state.detectedCur}`);
    case "saveBtn": {
      const r = state.result, p = mainPrice(r);
      const name = r.kind === "menu" ? `Menu (${(r.items || []).length} item)` : r.product_name_translated || r.product_name_original;
      const item = { name, when: new Date().toLocaleDateString("id-ID", { day: "numeric", month: "short" }), orig: "", conv: "" };
      if (p) {
        const cur = priceCur(p), v = convert(p.amount, cur, state.to);
        item.orig = fmt(p.amount, cur);
        item.conv = v != null ? fmt(v, state.to) : "";
      }
      state.saved.unshift(item);
      state.saved = state.saved.slice(0, 50);
      store.set("saved", state.saved);
      return toast("Tersimpan di perangkat ini");
    }
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.id !== "manualForm") return;
  e.preventDefault();
  const v = parseFloat($("manualAmt").value.replace(/\./g, "").replace(",", "."));
  if (!(v > 0)) return toast("Masukkan angka harga");
  const cur = effFrom() || "JPY";
  state.result = { ...state.result, subject: "price_label", prices: [{ amount: v, currency: cur, label: "Diisi manual", tax_included: null }], price_box: { found: false, x: 0, y: 0, w: 0, h: 0 } };
  state.manualOpen = false;
  state.resultFresh = true;
  renderAll();
});

$("fileInput").addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) fromFile(f);
  e.target.value = "";
});
$("curSearch").addEventListener("input", renderCurrencyPage);
$("autoDetect").addEventListener("change", (e) => {
  if (e.target.checked) setCurrency("from", "auto");
  else setCurrency("from", state.lastCurrency || "JPY");
});
$("lang").value = state.lang;
$("themeAuto").addEventListener("change", (e) => {
  state.themeAuto = e.target.checked;
  store.set("themeAuto", state.themeAuto);
  applyTheme();
});
$("lang").addEventListener("change", (e) => { state.lang = e.target.value; store.set("lang", state.lang); });
window.addEventListener("resize", renderOverlay);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const id of ["detail", "currency", "settings"]) if (!$(id).hidden) return closeSheet(id);
});

// ---------------- Demo (tanpa API key / kamera) ----------------
function addDemoScene() {
  if ($("demoScene")) return;
  const d = document.createElement("div");
  d.id = "demoScene";
  d.className = "hero-scene";
  d.style.cssText = "position:absolute;inset:0;margin:0;height:auto;border-radius:0;box-shadow:none";
  d.innerHTML = `<div class="scene-blur" style="top:150px;height:280px"><i></i><i></i><i></i></div>
    <div class="scene-shelf" style="top:44%"></div>
    <div class="shelf-tag" id="demoTag" style="top:calc(44% + 18px)"><div class="jp small">ツナマヨネーズ おにぎり</div>
      <div class="tag-price"><span class="jp tax">税込</span><span>¥140</span></div>
      <div class="jp small" style="font-size:10px;margin-top:4px;color:#4A4D52">本体価格 ¥130</div></div>
    <div class="shelf-tag" id="demoTag2" style="left:16px;top:24%;transform:none;width:auto;padding:5px 8px"><div class="jp small" style="font-size:9px">梅おにぎり</div><div class="tag-price" style="font-size:20px">¥128</div></div>
    <div class="shelf-tag" id="demoTag3" style="left:auto;right:16px;top:24%;transform:none;width:auto;padding:5px 8px"><div class="jp small" style="font-size:9px">鮭おにぎり</div><div class="tag-price" style="font-size:20px">¥160</div></div>`;
  $("stage").prepend(d);
}
function removeDemoScene() { $("demoScene")?.remove(); }

let demoTurn = 0;
function demoBox(id) {
  const el = $(id), cam = $("stage").getBoundingClientRect();
  if (!el) return { found: false, x: 0, y: 0, w: 0, h: 0 };
  const b = el.getBoundingClientRect();
  return { found: true, x: (b.left - cam.left) / cam.width, y: (b.top - cam.top) / cam.height, w: b.width / cam.width, h: b.height / cam.height };
}
// Penilaian profil versi demo (di aplikasi asli, AI yang menilai dari komposisi)
function demoDiet(contains, halalKnown) {
  if (!state.diet.length) return { status: "tidak_pasti", reasons: [] };
  const hit = DIET_OPTIONS.filter((o) => state.diet.includes(o.id) && contains[o.id]).map((o) => contains[o.id]);
  if (hit.length) return { status: "tidak_cocok", reasons: hit };
  if (state.diet.includes("halal") && !halalKnown) return { status: "tidak_pasti", reasons: ["Tidak ada logo halal di kemasan"] };
  return { status: "cocok", reasons: [] };
}
// Demo bergiliran: label harga onigiri → botol teh (tanpa harga) → menu restoran
function demoResult(source) {
  const turn = demoTurn++ % 3;
  if (turn === 2) {
    const item = (o, t, d, price, tags, contains) => {
      const c = demoDiet(contains, false);
      return { name_original: o, name_translated: t, description: d, price, tags, diet_status: c.status, diet_reason: c.reasons[0] || "" };
    };
    return {
      kind: "menu", found: true, currency: "JPY",
      items: [
        item("豚骨ラーメン", "Ramen tonkotsu", "Kuah kaldu tulang babi, irisan chashu", 980, ["babi"], { "no-pork": "Kuah dan daging babi", halal: "Mengandung babi", wheat: "Mi gandum" }),
        item("醤油ラーメン", "Ramen shoyu", "Kuah kecap asin, telur, nori", 880, ["ayam"], { egg: "Ada telur rebus", soy: "Kecap kedelai", wheat: "Mi gandum" }),
        item("海老天丼", "Nasi tempura udang", "Udang goreng tepung di atas nasi", 1200, ["seafood"], { shellfish: "Udang", wheat: "Tepung gandum", egg: "Adonan pakai telur" }),
        item("野菜カレー", "Kari sayur", "Kari Jepang dengan sayuran", 850, ["vegetarian"], { wheat: "Roux kari dari gandum", milk: "Roux kari biasanya pakai susu" }),
        item("生ビール", "Bir draft", "", 600, ["alkohol"], { "no-alcohol": "Minuman beralkohol", halal: "Minuman beralkohol" }),
        item("緑茶", "Teh hijau", "Gratis isi ulang", null, [], {}),
      ],
      notes: "Harga sudah termasuk pajak. Ada biaya meja ¥300 per orang setelah jam 18.00.",
    };
  }
  const cam = $("stage").getBoundingClientRect();
  const tagEl = $("demoTag");
  const tb = tagEl?.getBoundingClientRect();
  const box = tb ? { found: true, x: (tb.left - cam.left) / cam.width, y: (tb.top - cam.top) / cam.height, w: tb.width / cam.width, h: tb.height / cam.height } : { found: false, x: 0, y: 0, w: 0, h: 0 };
  const none = { found: false, x: 0, y: 0, w: 0, h: 0 };
  if (turn === 1) {
    return {
      subject: "product", product_name_original: "緑茶 無糖 525ml", product_name_translated: "Teh hijau tanpa gula",
      prices: [], price_box: none, product_box: none,
      text_translation: [{ original: "無糖", translated: "Tanpa gula" }, { original: "カフェイン含有", translated: "Mengandung kafein" }],
      nutrition: { calories_kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0, sugar_g: 0, salt_g: 0.07, serving: "per 100 ml", source: "label" },
      allergens: [], notes: "Mengandung kafein. Tidak ada bahan dari babi atau alkohol di komposisi.",
      diet_check: demoDiet({}, true), kind: "product",
    };
  }
  return {
    subject: "price_label", product_name_original: "ツナマヨネーズ おにぎり", product_name_translated: "Onigiri tuna mayones",
    prices: [
      { amount: 140, currency: "JPY", label: "Termasuk pajak", tax_included: true },
      { amount: 130, currency: "JPY", label: "Sebelum pajak", tax_included: false },
    ],
    price_box: box, product_box: none, currency: "JPY",
    shelf_tags: [
      { name_original: "梅おにぎり", name_translated: "Onigiri plum asin", price: 128, box: demoBox("demoTag2") },
      { name_original: "鮭おにぎり", name_translated: "Onigiri salmon", price: 160, box: demoBox("demoTag3") },
    ],
    text_translation: [
      { original: "国産米使用", translated: "Pakai beras dalam negeri Jepang" },
      { original: "お早めにお召し上がりください", translated: "Sebaiknya segera dimakan" },
    ],
    nutrition: { calories_kcal: 232, protein_g: 5.2, fat_g: 8.9, carbs_g: 32.6, sugar_g: null, salt_g: 1.1, serving: "per 1 buah", source: "label" },
    allergens: ["Telur", "Kedelai", "Ikan (tuna)"],
    diet_check: demoDiet({ egg: "Mayones mengandung telur", soy: "Mengandung kedelai", fish: "Isi tuna" }, false), kind: "product",
    notes: "Tidak tertulis babi atau alkohol di komposisi. Tidak ada logo sertifikat halal di kemasan.",
  };
}

// ---------------- Pasang sebagai aplikasi (PWA) ----------------
// Chrome/Edge/Android/Samsung: pakai tombol pasang bawaan browser.
// iPhone/iPad (Safari): tidak ada tombol otomatis, jadi tampilkan langkah "Tambah ke Layar Utama".
let installPrompt = null;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function renderInstall() {
  const canPrompt = !!installPrompt;
  $("installBox").hidden = isStandalone() || !(canPrompt || isIOS);
  $("installBtn").textContent = canPrompt ? "Pasang" : "Caranya";
  $("installHint").textContent = isIOS && !canPrompt
    ? "Pasang lewat Safari supaya muncul di layar utama."
    : "Buka langsung dari layar utama, tanpa browser.";
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  renderInstall();
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  renderInstall();
  toast("KursLens terpasang");
});
async function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    return renderInstall();
  }
  if (isIOS) $("iosSteps").hidden = !$("iosSteps").hidden;
}
if ("serviceWorker" in navigator && !DEMO) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// ---------------- Start ----------------
renderInstall();
applyLayout();
applyTheme();
$("autoBtn").setAttribute("aria-pressed", state.auto);
show("welcome"); // selalu mulai dari halaman awal; kamera baru menyala setelah pengguna menekan "Mulai scan harga"
loadRates();
setInterval(loadRates, 10 * 60 * 1000);
