// Membuat ikon PNG untuk instalasi (HP, iPad, laptop) dari file SVG logo.
// Ganti logo: edit public/icons/icon.svg dan icon-maskable.svg, lalu jalankan: npm run icons
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const dir = fileURLToPath(new URL("../public/icons/", import.meta.url));
const svg = (name) => readFileSync(dir + name, "utf8");

const jobs = [
  ["icon.svg", 192, "icon-192.png"],
  ["icon.svg", 512, "icon-512.png"],
  ["icon-maskable.svg", 512, "maskable-512.png"],
  ["icon-maskable.svg", 180, "apple-touch-icon.png"], // iPhone/iPad membulatkan sudutnya sendiri
  ["icon.svg", 32, "favicon-32.png"],
];

for (const [src, size, out] of jobs) {
  const png = new Resvg(svg(src), { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(dir + out, png);
  console.log(`✓ ${out} (${size}px)`);
}
