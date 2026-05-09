/**
 * Test hCaptcha via 2captcha — sitekey CEV diplomatie.be
 * Usage : npx tsx src/test-captcha.ts
 */

const API_KEY     = process.env.TWOCAPTCHA_API_KEY ?? '';
const SITE_KEY    = '5f64399c-14a8-415e-ad1a-7ebccdc4943a';
const PAGE_URL    = 'https://appointment.cloud.diplomatie.be/Captcha';

async function main() {
  if (!API_KEY) { console.error('❌ TWOCAPTCHA_API_KEY absente'); process.exit(1); }

  console.log('='.repeat(60));
  console.log(' TEST 2CAPTCHA — hCaptcha CEV diplomatie.be');
  console.log('='.repeat(60));
  console.log(`Sitekey : ${SITE_KEY}`);
  console.log(`Page    : ${PAGE_URL}`);
  console.log(`API key : ${API_KEY.slice(0, 8)}...`);

  // ── 1. Vérifier le solde ─────────────────────────────────
  console.log('\n[0] Vérification solde...');
  const balRes = await fetch(`https://api.2captcha.com/getBalance?key=${API_KEY}`);
  const balText = await balRes.text();
  console.log(`    Réponse: ${balText}`);
  if (balText.startsWith('ERROR')) {
    console.error('❌ Clé invalide ou erreur API');
    process.exit(1);
  }
  console.log(`    ✅ Solde: $${balText}`);

  // ── 2. Créer la tâche via nouvelle API JSON ──────────────
  console.log('\n[1] Création tâche hCaptcha (API JSON v2)...');
  const createRes = await fetch('https://api.2captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: API_KEY,
      task: {
        type: 'HCaptchaTaskProxyless',
        websiteURL: PAGE_URL,
        websiteKey: SITE_KEY,
      },
    }),
  });
  const createData = await createRes.json() as { errorId: number; errorCode?: string; taskId?: number };
  console.log('    Réponse createTask:', JSON.stringify(createData));

  if (createData.errorId !== 0 || !createData.taskId) {
    console.warn('⚠️  Nouvelle API échoue — essai API form-encoded (v1)...');

    // ── 3. Fallback ancienne API form-encoded ────────────
    console.log('\n[1b] Création tâche hCaptcha (API form-encoded v1)...');
    const submitRes = await fetch('http://2captcha.com/in.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        key: API_KEY,
        method: 'hcaptcha',
        sitekey: SITE_KEY,
        pageurl: PAGE_URL,
        json: '1',
      }).toString(),
    });
    const submitData = await submitRes.json() as { status: number; request: string };
    console.log('    Réponse in.php:', JSON.stringify(submitData));

    if (submitData.status !== 1) {
      console.error(`❌ Échec v1 aussi: ${submitData.request}`);
      process.exit(1);
    }

    // Polling v1
    const captchaId = submitData.request;
    console.log(`\n[2] Polling résultat (taskId=${captchaId})...`);
    for (let i = 1; i <= 30; i++) {
      await new Promise(r => setTimeout(r, 5_000));
      const pollRes = await fetch(`http://2captcha.com/res.php?key=${API_KEY}&action=get&id=${captchaId}&json=1`);
      const pollData = await pollRes.json() as { status: number; request: string };
      console.log(`    Poll #${i}: ${pollData.request}`);
      if (pollData.status === 1) {
        console.log('\n✅ TOKEN RÉSOLU (v1) !');
        console.log(`   Token (${pollData.request.length} chars): ${pollData.request.slice(0, 80)}...`);
        process.exit(0);
      }
      if (pollData.request !== 'CAPCHA_NOT_READY') {
        console.error(`❌ Erreur polling v1: ${pollData.request}`);
        process.exit(1);
      }
    }
    console.error('❌ Timeout — pas de token après 150s');
    process.exit(1);
  }

  // ── 4. Polling nouvelle API ──────────────────────────────
  const taskId = createData.taskId;
  console.log(`\n[2] Polling résultat (taskId=${taskId})...`);
  for (let i = 1; i <= 30; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    const pollRes = await fetch('https://api.2captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: API_KEY, taskId }),
    });
    const pollData = await pollRes.json() as {
      errorId: number; status: string;
      solution?: { gRecaptchaResponse?: string };
      errorCode?: string;
    };
    console.log(`    Poll #${i}: status=${pollData.status} errorId=${pollData.errorId}${pollData.errorCode ? ' errorCode=' + pollData.errorCode : ''}`);
    if (pollData.errorId !== 0) {
      console.error(`❌ Erreur polling: ${pollData.errorCode}`);
      process.exit(1);
    }
    if (pollData.status === 'ready' && pollData.solution?.gRecaptchaResponse) {
      const token = pollData.solution.gRecaptchaResponse;
      console.log('\n✅ TOKEN RÉSOLU (v2) !');
      console.log(`   Token (${token.length} chars): ${token.slice(0, 80)}...`);
      process.exit(0);
    }
  }
  console.error('❌ Timeout — pas de token après 150s');
  process.exit(1);
}

main().catch(err => { console.error('Erreur:', err); process.exit(1); });
