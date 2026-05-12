#!/usr/bin/env tsx
/**
 * Script de capture complète du portail USA
 * 
 * Usage: npx tsx scripts/capture-usa-portal.ts
 * 
 * Ce script lance un navigateur Playwright sur le portail USA,
 * capture toutes les requêtes/réponses/headers/JSON,
 * et sauvegarde tout dans un dossier usa-capture/ pour analyse.
 */

import { chromium, type Browser, type Page, type Request, type Response } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Configuration
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CAPTURE_DIR = join(__dirname, '../captured/usa');
const TIMESTAMP = Date.now();
const SESSION_DIR = join(CAPTURE_DIR, `capture-${TIMESTAMP}`);

// Données capturées
interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  timestamp: number;
}

interface CapturedResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body?: string;
  bodySize?: number;
  timestamp: number;
}

interface SessionData {
  startTime: number;
  endTime?: number;
  requests: CapturedRequest[];
  responses: CapturedResponse[];
  screenshots: string[];
  consoleLogs: Array<{ type: string; text: string; timestamp: number }>;
  pageErrors: Array<{ error: string; timestamp: number }>;
}

class USAPortalCapturer {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private sessionData: SessionData = {
    startTime: Date.now(),
    requests: [],
    responses: [],
    screenshots: [],
    consoleLogs: [],
    pageErrors: []
  };

  async initialize() {
    console.log(`[capture] Initialisation du capteur USA...`);
    console.log(`[capture] Dossier de session: ${SESSION_DIR}`);
    
    // Créer le dossier de capture
    if (!existsSync(CAPTURE_DIR)) {
      mkdirSync(CAPTURE_DIR, { recursive: true });
    }
    mkdirSync(SESSION_DIR, { recursive: true });
    
    // Lancer le navigateur
    this.browser = await chromium.launch({
      headless: false, // Mode visible pour que tu puisses interagir
      slowMo: 100, // Ralentir pour mieux voir
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox'
      ]
    });
    
    // Créer un contexte avec user-agent réaliste
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });
    
    this.page = await context.newPage();
    
    // Configurer les intercepteurs
    await this.setupInterceptors();
    
    console.log(`[capture] Navigateur lancé. Prêt à capturer.`);
  }

  private async setupInterceptors() {
    if (!this.page) return;

    // Intercepter toutes les requêtes
    this.page.on('request', (request: Request) => {
      this.captureRequest(request);
    });

    // Intercepter toutes les réponses
    this.page.on('response', async (response: Response) => {
      await this.captureResponse(response);
    });

    // Capturer les logs console
    this.page.on('console', (msg) => {
      this.sessionData.consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now()
      });
      console.log(`[console ${msg.type()}] ${msg.text()}`);
    });

    // Capturer les erreurs de page
    this.page.on('pageerror', (error) => {
      this.sessionData.pageErrors.push({
        error: error.message,
        timestamp: Date.now()
      });
      console.error(`[page error] ${error.message}`);
    });

    // Capturer les requêtes réseau échouées
    this.page.on('requestfailed', (request) => {
      console.error(`[request failed] ${request.url()} - ${request.failure()?.errorText}`);
    });
  }

  private async captureRequest(request: Request) {
    const captured: CapturedRequest = {
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      timestamp: Date.now()
    };

    // Capturer le body pour les POST/PUT
    if (['POST', 'PUT', 'PATCH'].includes(request.method())) {
      const postData = request.postData();
      if (postData) {
        captured.postData = postData;
      }
    }

    this.sessionData.requests.push(captured);
    
    // Log pour le debug
    console.log(`[request] ${request.method()} ${request.url()}`);
  }

  private async captureResponse(response: Response) {
    const captured: CapturedResponse = {
      url: response.url(),
      status: response.status(),
      statusText: response.statusText(),
      headers: response.headers(),
      timestamp: Date.now()
    };

    try {
      // Essayer de capturer le body
      const body = await response.text();
      captured.body = body;
      captured.bodySize = body.length;
      
      // Détecter et sauvegarder les JSON
      if (response.headers()['content-type']?.includes('application/json')) {
        try {
          const jsonData = JSON.parse(body);
          this.saveJSONResponse(response.url(), jsonData);
        } catch (e) {
          // Pas un JSON valide
        }
      }
    } catch (error) {
      console.warn(`[capture] Impossible de capturer le body pour ${response.url()}: ${error}`);
    }

    this.sessionData.responses.push(captured);
    
    // Log pour le debug
    console.log(`[response] ${response.status()} ${response.url()} (${captured.bodySize || 0} bytes)`);
  }

  private saveJSONResponse(url: string, data: any) {
    try {
      // Créer un nom de fichier safe à partir de l'URL
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(p => p);
      const filename = pathParts.join('_') || 'root';
      
      // Limiter la longueur du nom de fichier
      const safeFilename = filename.length > 50 ? filename.substring(0, 50) : filename;
      const timestamp = Date.now();
      
      const filePath = join(SESSION_DIR, `json-${safeFilename}-${timestamp}.json`);
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      
      console.log(`[json saved] ${filePath}`);
    } catch (error) {
      console.error(`[json save error] ${url}: ${error}`);
    }
  }

  async navigateToPortal() {
    if (!this.page) throw new Error('Page non initialisée');
    
    console.log(`[capture] Navigation vers le portail USA...`);
    
    // Aller sur le portail USA
    await this.page.goto('https://www.usvisaappt.com/visaapplicantui/', {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    
    // Prendre une capture d'écran
    await this.takeScreenshot('01-portal-home.png');
    
    console.log(`[capture] Portail chargé. Tu peux maintenant te connecter manuellement.`);
    console.log(`[capture] Le script capture tout automatiquement.`);
    console.log(`[capture] Appuie sur Ctrl+C quand tu as terminé.`);
  }

  async takeScreenshot(name: string) {
    if (!this.page) return;
    
    try {
      const screenshotPath = join(SESSION_DIR, name);
      await this.page.screenshot({ path: screenshotPath, fullPage: false });
      this.sessionData.screenshots.push(screenshotPath);
      console.log(`[screenshot] ${screenshotPath}`);
    } catch (error) {
      console.error(`[screenshot error] ${error}`);
    }
  }

  async saveSessionData() {
    this.sessionData.endTime = Date.now();
    
    // Sauvegarder les données de session
    const sessionFilePath = join(SESSION_DIR, 'session-data.json');
    writeFileSync(sessionFilePath, JSON.stringify(this.sessionData, null, 2), 'utf8');
    
    // Sauvegarder un résumé
    const summary = {
      timestamp: TIMESTAMP,
      duration: this.sessionData.endTime - this.sessionData.startTime,
      totalRequests: this.sessionData.requests.length,
      totalResponses: this.sessionData.responses.length,
      totalScreenshots: this.sessionData.screenshots.length,
      totalConsoleLogs: this.sessionData.consoleLogs.length,
      totalPageErrors: this.sessionData.pageErrors.length,
      sessionDir: SESSION_DIR
    };
    
    const summaryFilePath = join(SESSION_DIR, 'capture-summary.json');
    writeFileSync(summaryFilePath, JSON.stringify(summary, null, 2), 'utf8');
    
    // Sauvegarder les requêtes et réponses dans des fichiers séparés
    const requestsFilePath = join(SESSION_DIR, 'requests.jsonl');
    const requestsData = this.sessionData.requests.map(req => JSON.stringify(req)).join('\n');
    writeFileSync(requestsFilePath, requestsData, 'utf8');
    
    const responsesFilePath = join(SESSION_DIR, 'responses.jsonl');
    const responsesData = this.sessionData.responses.map(res => JSON.stringify(res)).join('\n');
    writeFileSync(responsesFilePath, responsesData, 'utf8');
    
    console.log(`[capture] Données de session sauvegardées dans: ${SESSION_DIR}`);
    console.log(`[capture] Résumé:`, summary);
  }

  async cleanup() {
    if (this.page) {
      await this.page.close();
    }
    if (this.browser) {
      await this.browser.close();
    }
    
    await this.saveSessionData();
    
    console.log(`[capture] Nettoyage terminé.`);
  }

  async run() {
    try {
      await this.initialize();
      await this.navigateToPortal();
      
      // Attendre indéfiniment que l'utilisateur termine (Ctrl+C)
      console.log(`\n[capture] === CAPTURE EN COURS ===`);
      console.log(`[capture] 1. Connecte-toi manuellement au portail`);
      console.log(`[capture] 2. Navigue jusqu'à la recherche de créneaux`);
      console.log(`[capture] 3. Appuie sur Ctrl+C quand tu as terminé`);
      console.log(`[capture] =========================\n`);
      
      // Garder le script en vie
      await new Promise(() => {});
      
    } catch (error) {
      console.error(`[capture error] ${error}`);
      await this.cleanup();
      process.exit(1);
    }
  }
}

// Gestion de Ctrl+C
process.on('SIGINT', async () => {
  console.log(`\n[capture] Arrêt demandé...`);
  const capturer = new USAPortalCapturer();
  await capturer.cleanup();
  console.log(`[capture] Script terminé.`);
  process.exit(0);
});

// Lancer le capteur
const capturer = new USAPortalCapturer();
capturer.run().catch(console.error);