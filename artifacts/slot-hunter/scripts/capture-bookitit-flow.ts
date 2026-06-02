import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// URL du consulat d'Espagne à Kinshasa ou lien direct vers leur widget Bookitit
const TARGET_URL = 'https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5'; // Mets ici l'URL exacte d'entrée

interface CapturedFlow {
  userAgent: string;
  clientHints: Record<string, string>;
  cloudflareCookies: { name: string; value: string; domain: string }[];
  bookititRequests: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData: string | null;
  }[];
}

async function runCapture() {
  console.log('🚀 Démarrage du Sniffer de Furtivité Bookitit...');

  const browser = await chromium.launch({
    headless: false, // Obligatoire pour résoudre le challenge à la main
    args: ['--disable-blink-features=AutomationControlled'] // Mode furtif de base pour Playwright
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: 'fr-FR'
  });

  const page = await context.newPage();

  // Stockage des données capturées
  const flowData: CapturedFlow = {
    userAgent: '',
    clientHints: {},
    cloudflareCookies: [],
    bookititRequests: []
  };

  // 1. Interception de l'User-Agent global
  flowData.userAgent = await page.evaluate(() => navigator.userAgent);

  // 2. Écoute et interception des requêtes réseau en bruit de fond
  page.on('request', request => {
    const url = request.url();

    // On cible uniquement les requêtes liées à l'infrastructure de réservation (Bookitit ou consulat)
    if (url.includes('bookitit') || url.includes('citaconsular.es') || url.includes('bkt')) {
      const headers = request.headers();

      // Capturer les Client Hints la première fois qu'on les voit passer
      if (headers['sec-ch-ua'] && Object.keys(flowData.clientHints).length === 0) {
        flowData.clientHints = {
          'sec-ch-ua': headers['sec-ch-ua'],
          'sec-ch-ua-platform': headers['sec-ch-ua-platform'] || '',
          'sec-ch-ua-mobile': headers['sec-ch-ua-mobile'] || ''
        };
      }

      // Si c'est une requête API intéressante (XHR / Fetch / POST)
      if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch' || request.method() === 'POST') {
        console.log(`📡 Requête interceptée : [${request.method()}] ${url.substring(0, 80)}...`);
        flowData.bookititRequests.push({
          url: url,
          method: request.method(),
          headers: headers,
          postData: request.postData()
        });
      }
    }
  });

  console.log(`\n🌍 Chargement de la page : ${TARGET_URL}`);
  await page.goto(TARGET_URL);

  console.log('\n==========================================================');
  console.log('⚠️ ATTENTE ACTIVE — ACTION REQUISE :');
  console.log('1. Résous le challenge Cloudflare si nécessaire.');
  console.log('2. Navigue jusqu\'à l\'affichage du calendrier ou des créneaux.');
  console.log('3. Tape sur Entrée dans ton terminal pour stopper la capture.');
  console.log('==========================================================\n');

  // Mode "Play & Wait" : attends une interaction clavier dans le terminal
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => {
      resolve();
    });
  });

  // 3. Extraction finale des cookies générés (y compris Cloudflare)
  console.log('🍪 Extraction du pack de cookies...');
  const allCookies = await context.cookies();
  flowData.cloudflareCookies = allCookies.filter(c =>
    c.name === 'cf_clearance' || c.name === '__cf_bm' || c.name.includes('bookitit') || c.name.includes('session')
  ).map(c => ({ name: c.name, value: c.value, domain: c.domain }));

  // 4. Écriture du rapport JSON
  const outputPath = path.join(process.cwd(), 'bookitit_stealth_footprint.json');
  fs.writeFileSync(outputPath, JSON.stringify(flowData, null, 2), 'utf-8');

  console.log(`\n✅ Capture terminée avec succès !`);
  console.log(`📊 Rapport d'audit généré : ${outputPath}`);
  console.log(`💡 Tu as capturé ${flowData.bookititRequests.length} requêtes API clés.`);

  await browser.close();
  process.exit(0);
}

runCapture().catch(err => {
  console.error('❌ Erreur pendant la capture :', err);
  process.exit(1);
});
