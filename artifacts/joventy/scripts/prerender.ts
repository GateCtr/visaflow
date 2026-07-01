import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DESTINATIONS_SEO } from "../src/data/destinations-seo";
import { getAllGuides } from "../src/data/guides-seo";
import { injectSeoMeta } from "../vite-plugin-seo";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../dist/public");

if (!fs.existsSync(DIST)) {
  console.error(`❌ dist/public not found at ${DIST}. Run "pnpm build:vite" first.`);
  process.exit(1);
}

const template = fs.readFileSync(path.join(DIST, "index.html"), "utf-8");
let count = 0;

function write(filePath: string, html: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, html, "utf-8");
}

console.log("🔧 Pre-rendering pages…\n");

for (const dest of DESTINATIONS_SEO) {
  const html = injectSeoMeta(template, `/${dest.slug}`);
  write(path.join(DIST, `${dest.slug}.html`), html);
  write(path.join(DIST, dest.slug, "index.html"), html);
  console.log(`  ✓ /${dest.slug}`);
  count++;
}

const guidesDir = path.join(DIST, "guides");
fs.mkdirSync(guidesDir, { recursive: true });

for (const guide of getAllGuides()) {
  const html = injectSeoMeta(template, `/guides/${guide.slug}`);
  write(path.join(guidesDir, `${guide.slug}.html`), html);
  write(path.join(guidesDir, guide.slug, "index.html"), html);
  console.log(`  ✓ /guides/${guide.slug}`);
  count++;
}

console.log(`\n🚀 Pre-rendered ${count} pages into dist/public`);
