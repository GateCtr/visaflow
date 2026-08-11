/**
 * fetch-reference-lists.ts
 * Authenticates with visaonweb.diplomatie.be and fetches all /Common/* reference data.
 * Output: debug_dumps/reference-lists/<endpoint>.json
 *
 * Usage:
 *   VOWINT_TEST_PASSWORD=xxx npx ts-node --esm src/debug/fetch-reference-lists.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../../../../debug_dumps/reference-lists');
const VOWINT_BASE = 'https://visaonweb.diplomatie.be';
const EMAIL = 'screentapinc@gmail.com';
const PASSWORD = process.env.VOWINT_TEST_PASSWORD ?? '';
const TODAY = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

if (!PASSWORD) {
  console.error('❌  VOWINT_TEST_PASSWORD not set');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── Cookie jar (simple) ─────────────────────────────────────────────────────
const cookieJar: Map<string, string> = new Map();

function parseCookies(headers: Headers): void {
  // getSetCookie() returns ALL Set-Cookie headers as an array (Node 18+)
  const raw: string[] = (headers as any).getSetCookie?.() ?? [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (name) cookieJar.set(name, val);
  }
}

function cookieHeader(): string {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
    Cookie: cookieHeader(),
    ...extra,
  };
}

async function get(url: string): Promise<Response> {
  const r = await fetch(url, {
    headers: baseHeaders({ Accept: 'text/html,application/xhtml+xml,*/*' }),
    redirect: 'follow',
  });
  parseCookies(r.headers);
  return r;
}

async function getJson(path: string, params?: Record<string, string | number>): Promise<unknown> {
  const url = new URL(VOWINT_BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url.toString(), {
    headers: baseHeaders({ Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' }),
    redirect: 'follow',
  });
  parseCookies(r.headers);
  if (!r.ok) return { __error: r.status, __url: url.toString() };
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { return { __raw: text.slice(0, 500) }; }
}

// ─── Login ────────────────────────────────────────────────────────────────────
async function login(): Promise<void> {
  console.log('🔐  Step 1 — GET login page...');
  const loginPage = await get(`${VOWINT_BASE}/en/Account/Login`);
  const html = await loginPage.text();

  // Extract __RequestVerificationToken
  const tokenMatch = html.match(/name="__RequestVerificationToken"[^>]+value="([^"]+)"/);
  if (!tokenMatch) {
    // Try alternate format
    const alt = html.match(/__RequestVerificationToken.*?value="([^"]+)"/s);
    if (!alt) throw new Error('Could not find __RequestVerificationToken on login page');
    tokenMatch && undefined; // satisfy linter
    const token = alt[1];
    await doLogin(token);
    return;
  }
  await doLogin(tokenMatch[1]);
}

async function doLogin(token: string): Promise<void> {
  console.log(`🔐  Step 2 — POST login (token=${token.slice(0, 20)}...)...`);
  const body = new URLSearchParams({
    UserName: EMAIL,
    Password: PASSWORD,
    __RequestVerificationToken: token,
    RememberMe: 'false',
  });

  // Use redirect:'manual' to capture cookies set on the 302 response
  // (with redirect:'follow', Node fetch doesn't persist intermediate cookies)
  const r = await fetch(`${VOWINT_BASE}/en/Account/Login`, {
    method: 'POST',
    headers: {
      ...baseHeaders(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${VOWINT_BASE}/en/Account/Login`,
      Origin: VOWINT_BASE,
    },
    body: body.toString(),
    redirect: 'manual',
  });
  parseCookies(r.headers);

  const location = r.headers.get('location') ?? '/';
  const status = r.status;

  if (status >= 400) {
    const text = await r.text();
    if (text.includes('Invalid login') || text.includes('incorrect')) {
      throw new Error('Bad credentials');
    }
    throw new Error(`Login failed — HTTP ${status}`);
  }

  // Follow the redirect manually (to activate session on server)
  const redirectUrl = location.startsWith('http') ? location : `${VOWINT_BASE}${location}`;
  const r2 = await fetch(redirectUrl, {
    headers: baseHeaders({ Accept: 'text/html' }),
    redirect: 'follow',
  });
  parseCookies(r2.headers);

  // Verify session by hitting IndexByUserId
  const verify = await fetch(`${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, {
    headers: baseHeaders({ Accept: 'text/html' }),
    redirect: 'follow',
  });
  parseCookies(verify.headers);

  const isLoggedIn = !verify.url.includes('/Account/Login');
  if (!isLoggedIn) {
    throw new Error(`Session not authenticated — IndexByUserId redirected to: ${verify.url}`);
  }
  console.log(`✅  Logged in — session verified (${[...cookieJar.keys()].join(', ')})`);
}

// ─── Save helper ──────────────────────────────────────────────────────────────
function save(filename: string, data: unknown): void {
  const fp = path.join(OUT_DIR, filename);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
  const size = Array.isArray(data) ? `${(data as unknown[]).length} items` :
    typeof data === 'object' && data !== null && '__raw' in data ? 'raw text' :
    `${JSON.stringify(data).length} bytes`;
  console.log(`  💾  ${filename} — ${size}`);
}

// ─── Fetch all reference lists ────────────────────────────────────────────────
async function fetchNoParamEndpoints(): Promise<void> {
  console.log('\n📋  Fetching no-param reference lists...');

  const noParam: Array<[string, string]> = [
    ['/Common/GetAllCountryTypes',    'countries.json'],
    ['/Common/GetAllNationalityTypes','nationalities.json'],
    ['/Common/GetAllSexTypes',        'sex-types.json'],
    ['/Common/GetAllVisaStatusTypes', 'visa-status-types.json'],
    ['/Common/GetNewGuidAsync',       'new-guid.json'],
  ];

  for (const [ep, fname] of noParam) {
    process.stdout.write(`  GET ${ep}... `);
    const data = await getJson(ep);
    save(fname, data);
  }
}

async function fetchVisaTypeDependentEndpoints(): Promise<void> {
  console.log('\n📋  Fetching visaTypeId-dependent endpoints (probing IDs 1–20)...');

  // Probe visa type IDs 1–20
  const purposeByVisaType: Record<number, unknown> = {};
  const categoriesByVisaType: Record<number, unknown> = {};

  for (let id = 1; id <= 20; id++) {
    const data = await getJson('/Common/GetPurposeOfTravelTypesByVisaType', { visaTypeId: id, dateOfApplication: TODAY });
    if (Array.isArray(data) && data.length > 0) {
      purposeByVisaType[id] = data;
      process.stdout.write(`  visaTypeId=${id}: ${(data as unknown[]).length} purposes\n`);
    }
    const cats = await getJson('/Common/GetPurposeOfTravelCategoryByVisaTypeId', { visaTypeId: id, dateOfApplication: TODAY });
    if (Array.isArray(cats) && cats.length > 0) {
      categoriesByVisaType[id] = cats;
    }
  }

  save('purpose-of-travel-by-visa-type.json', purposeByVisaType);
  save('categories-by-visa-type.json', categoriesByVisaType);

  // Probe purposeOfTravelId 1–50
  console.log('\n📋  Probing GetPurposeOfTravelCategoryByPurposeOfTravelId (IDs 1–50)...');
  const categoryByPurpose: Record<number, unknown> = {};
  for (let id = 1; id <= 50; id++) {
    const data = await getJson('/Common/GetPurposeOfTravelCategoryByPurposeOfTravelId', { purposeOfTravelId: id });
    if (data && typeof data === 'object' && !('__error' in data)) {
      categoryByPurpose[id] = data;
    }
  }
  save('category-by-purpose-of-travel.json', categoryByPurpose);

  // Probe categoryId 1–30 for GetPurposeOfTravelByCategory
  console.log('\n📋  Probing GetPurposeOfTravelByCategory (categoryIds 1–30)...');
  const purposeByCategory: Record<number, unknown> = {};
  for (let id = 1; id <= 30; id++) {
    const data = await getJson('/Common/GetPurposeOfTravelByCategory', { categoryId: id });
    if (Array.isArray(data) && data.length > 0) {
      purposeByCategory[id] = data;
      process.stdout.write(`  categoryId=${id}: ${(data as unknown[]).length} purposes\n`);
    }
  }
  save('purpose-of-travel-by-category.json', purposeByCategory);
}

async function fetchExemptions(): Promise<void> {
  console.log('\n📋  Fetching exemptions (visaType 1–10, birthDate=1990-01-01)...');
  const results: Record<number, unknown> = {};
  for (let vt = 1; vt <= 10; vt++) {
    const data = await getJson('/Common/GetExemptionsByVisaType', {
      visaType: vt,
      birthDate: '1990-01-01',
      dateOfApplication: TODAY,
      appId: 0,
      memberStateOfDestinationId: 1,
    });
    if (Array.isArray(data) && data.length > 0) {
      results[vt] = data;
      process.stdout.write(`  visaType=${vt}: ${(data as unknown[]).length} exemptions\n`);
    }
  }
  save('exemptions-by-visa-type.json', results);
}

async function fetchVacData(): Promise<void> {
  console.log('\n📋  Fetching VAC currencies (vacIds 1–30)...');
  const currencies: Record<number, unknown> = {};
  const currencySingles: Record<number, unknown> = {};

  for (let id = 1; id <= 30; id++) {
    const c = await getJson('/Common/GetVacCurrencies', { vacId: id });
    if (Array.isArray(c) && c.length > 0) { currencies[id] = c; }
    const cs = await getJson('/Common/GetVacCurrency', { vacId: id });
    if (cs && typeof cs === 'object' && !('__error' in cs) && !('__raw' in cs)) {
      currencySingles[id] = cs;
    }
  }
  save('vac-currencies.json', currencies);
  save('vac-currency-default.json', currencySingles);
}

async function fetchCountryLookups(): Promise<void> {
  console.log('\n📋  Fetching GetCountryIdByIso2 for common ISO2 codes...');
  const commonIso2 = ['CD', 'BE', 'FR', 'US', 'GB', 'DE', 'IT', 'ES', 'NL', 'PT',
    'CN', 'JP', 'IN', 'BR', 'CA', 'AU', 'ZA', 'NG', 'KE', 'MA',
    'DZ', 'TN', 'SN', 'CM', 'CI', 'GH', 'AO', 'RW', 'ET', 'MZ'];
  const iso2Map: Record<string, unknown> = {};
  for (const iso of commonIso2) {
    const data = await getJson('/Common/GetCountryIdByIso2', { iso2: iso });
    iso2Map[iso] = data;
  }
  save('country-id-by-iso2.json', iso2Map);
}

async function fetchApplicationFeeProbe(): Promise<void> {
  console.log('\n📋  Probing GetApplicationFee (nationality 1–5, visaType 1–5)...');
  const fees: Array<unknown> = [];
  for (let nat = 1; nat <= 5; nat++) {
    for (let vt = 1; vt <= 5; vt++) {
      const data = await getJson('/Common/GetApplicationFee', {
        gratuityId: 0,
        visaTypeId: vt,
        nationalityId: nat,
        issuingCountryId: 1,
        documentTypeId: 1,
        dateOfApplication: TODAY,
        dateOfBirth: '1990-01-01',
        memberOfDestinationId: 1,
      });
      if (data && typeof data === 'object' && !('__error' in data) && !('__raw' in data)) {
        fees.push({ nationalityId: nat, visaTypeId: vt, ...data as object });
      }
    }
  }
  save('application-fee-sample.json', fees);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n🌍  VOWINT Reference List Fetcher`);
  console.log(`📁  Output: ${OUT_DIR}\n`);

  await login();

  await fetchNoParamEndpoints();
  await fetchVisaTypeDependentEndpoints();
  await fetchExemptions();
  await fetchVacData();
  await fetchCountryLookups();
  await fetchApplicationFeeProbe();

  // Summary
  const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json'));
  console.log(`\n✅  Done — ${files.length} files saved to ${OUT_DIR}`);
  for (const f of files) {
    const stat = fs.statSync(path.join(OUT_DIR, f));
    console.log(`   ${f.padEnd(48)} ${(stat.size / 1024).toFixed(1)} KB`);
  }
}

main().catch(e => {
  console.error('💥  Fatal:', e);
  process.exit(1);
});
