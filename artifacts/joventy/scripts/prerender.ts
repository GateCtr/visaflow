import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DESTINATIONS_SEO } from "../src/data/destinations-seo";
import { getAllGuides } from "../src/data/guides-seo";
import { EMBASSIES_SEO } from "../src/data/embassies-seo";
import { CRENEAUX_PAGES } from "../src/data/creneaux-seo";
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
  console.log(`  ✓ /${dest.slug}`);
  count++;
}

for (const embassy of EMBASSIES_SEO) {
  const html = injectSeoMeta(template, `/${embassy.slug}`);
  write(path.join(DIST, `${embassy.slug}.html`), html);
  console.log(`  ✓ /${embassy.slug}`);
  count++;
}

const guidesDir = path.join(DIST, "guides");
fs.mkdirSync(guidesDir, { recursive: true });

for (const guide of getAllGuides()) {
  const html = injectSeoMeta(template, `/guides/${guide.slug}`);
  write(path.join(guidesDir, `${guide.slug}.html`), html);
  console.log(`  ✓ /guides/${guide.slug}`);
  count++;
}

for (const page of CRENEAUX_PAGES) {
  const html = injectSeoMeta(template, `/${page.slug}`);
  write(path.join(DIST, `${page.slug}.html`), html);
  console.log(`  ✓ /${page.slug}`);
  count++;
}

const staticRoutes = [
  "/guides",
  "/ambassades",
  "/prix",
  "/a-propos",
  "/methodologie-sources",
  "/mentions-legales",
  "/confidentialite",
  "/conditions",
  "/remboursement",
];

for (const route of staticRoutes) {
  const slug = route === "/" ? "index" : route.slice(1);
  write(path.join(DIST, `${slug}.html`), injectSeoMeta(template, route));
  console.log(`  ✓ ${route}`);
  count++;
}

console.log(`\n🚀 Pre-rendered ${count} pages into dist/public`);

const SITE = "https://joventy.cd";
const today = new Date().toISOString().slice(0, 10);

type SitemapEntry = { loc: string; changefreq: string; priority: string; lastmod?: string };

const staticEntries: SitemapEntry[] = [
  { loc: `${SITE}/`, changefreq: "weekly", priority: "1.0" },
  { loc: `${SITE}/ambassades`, changefreq: "monthly", priority: "0.8" },
  { loc: `${SITE}/guides`, changefreq: "daily", priority: "0.8" },
  { loc: `${SITE}/prix`, changefreq: "monthly", priority: "0.8" },
  { loc: `${SITE}/audit-diagnostic`, changefreq: "monthly", priority: "0.8" },
  { loc: `${SITE}/alerte-espagne`, changefreq: "weekly", priority: "0.85" },
  { loc: `${SITE}/alerte-schengen`, changefreq: "weekly", priority: "0.85" },
  { loc: `${SITE}/a-propos`, changefreq: "monthly", priority: "0.7" },
  { loc: `${SITE}/methodologie-sources`, changefreq: "monthly", priority: "0.7" },
  { loc: `${SITE}/mentions-legales`, changefreq: "yearly", priority: "0.3" },
  { loc: `${SITE}/confidentialite`, changefreq: "yearly", priority: "0.3" },
  { loc: `${SITE}/conditions`, changefreq: "yearly", priority: "0.3" },
  { loc: `${SITE}/remboursement`, changefreq: "yearly", priority: "0.3" },
];

const destEntries: SitemapEntry[] = DESTINATIONS_SEO.map((d) => ({
  loc: `${SITE}/${d.slug}`,
  changefreq: "weekly",
  priority: "0.9",
}));

const embassyEntries: SitemapEntry[] = EMBASSIES_SEO.map((e) => ({
  loc: `${SITE}/${e.slug}`,
  changefreq: "monthly",
  priority: "0.75",
}));

const guideEntries: SitemapEntry[] = getAllGuides().map((g) => ({
  loc: `${SITE}/guides/${g.slug}`,
  changefreq: "weekly",
  priority: "0.85",
  lastmod: g.updatedDate,
}));

const creneauxEntries: SitemapEntry[] = CRENEAUX_PAGES.map((p) => ({
  loc: `${SITE}/${p.slug}`,
  changefreq: "weekly",
  priority: "0.9",
}));

const allEntries = [...staticEntries, ...destEntries, ...embassyEntries, ...guideEntries, ...creneauxEntries];

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allEntries
  .map(
    (e) => `  <url>
    <loc>${e.loc}</loc>
    <lastmod>${e.lastmod ?? today}</lastmod>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`
  )
  .join("\n")}
</urlset>
`;

write(path.join(DIST, "sitemap.xml"), sitemapXml);
console.log(`🗺️  sitemap.xml régénéré automatiquement (${allEntries.length} URLs) — synchronisé avec destinations-seo.ts, embassies-seo.ts, guides-seo.ts`);
