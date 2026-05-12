#!/usr/bin/env tsx
/**
 * Script de capture avancée du portail USA avec capture des événements DOM/Angular
 * 
 * Usage: npx tsx scripts/capture-usa-portal-enhanced.ts
 * 
 * Ce script capture:
 * 1. Toutes les requêtes/réponses HTTP avec headers
 * 2. Les événements DOM (clics, soumissions, changements)
 * 3. Les appels aux méthodes Angular
 * 4. Les logs console
 * 5. Les erreurs
 * 6. Les screenshots
 */

import { chromium, type Browser, type Page, type Request, type Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Configuration
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CAPTURE_DIR = path.join(__dirname, '../captured/usa-enhanced');
const TIMESTAMP = Date.now();
const SESSION_DIR = path.join(CAPTURE_DIR, `capture-${TIMESTAMP}`);

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

interface DomEvent {
  type: string;
  target: string;
  selector: string;
  value?: string;
  timestamp: number;
  pageUrl: string;
}

interface AngularEvent {
  type: string;
  component?: string;
  method?: string;
  data?: any;
  timestamp: number;
}

interface SessionData {
  startTime: number;
  endTime?: number;
  requests: CapturedRequest[];
  responses: CapturedResponse[];
  domEvents: DomEvent[];
  angularEvents: AngularEvent[];
  screenshots: string[];
  consoleLogs: Array<{ type: string; text: string; timestamp: number }>;
  pageErrors: Array<{ error: string; timestamp: number }>;
}

class USAPortalEnhancedCapturer {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private sessionData: SessionData = {
    startTime: Date.now(),
    requests: [],
    responses: [],
    domEvents: [],
    angularEvents: [],
    screenshots: [],
    consoleLogs: [],
    pageErrors: []
  };

  async initialize() {
    console.log(`[capture] Initialisation du capteur USA avancé...`);
    console.log(`[capture] Dossier de session: ${SESSION_DIR}`);
    
    // Créer le dossier de capture
    if (!fs.existsSync(CAPTURE_DIR)) {
      fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    }
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    
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

    // Injecter du code pour capturer les événements DOM
    await this.injectDomEventCapture();

    // Injecter du code pour détecter Angular
    await this.injectAngularDetection();
  }

  private async injectDomEventCapture() {
    if (!this.page) return;

    // Injecter du JavaScript pour capturer les événements DOM
    await this.page.addInitScript(() => {
      // Fonction pour capturer les événements
      const captureEvent = (event: Event) => {
        const target = event.target as HTMLElement;
        const eventData = {
          type: event.type,
          target: target.tagName + (target.id ? `#${target.id}` : '') + (target.className ? `.${target.className}` : ''),
          selector: getSelector(target),
          value: (target as HTMLInputElement).value,
          timestamp: Date.now(),
          pageUrl: window.location.href
        };

        // Envoyer l'événement au script principal
        (window as any).__capturedEvents = (window as any).__capturedEvents || [];
        (window as any).__capturedEvents.push(eventData);
        
        // Log dans la console
        console.log(`[DOM Event] ${event.type} on ${eventData.target}`);
      };

      // Fonction utilitaire pour générer un sélecteur CSS
      const getSelector = (element: HTMLElement): string => {
        if (element.id) return `#${element.id}`;
        
        let selector = element.tagName.toLowerCase();
        if (element.className) {
          selector += '.' + element.className.split(' ').join('.');
        }
        
        // Ajouter des attributs pour les éléments Angular
        const angularAttrs = ['ng-model', 'ng-click', 'ng-submit', 'ng-change', 'formcontrolname'];
        for (const attr of angularAttrs) {
          const value = element.getAttribute(attr);
          if (value) {
            selector += `[${attr}="${value}"]`;
            break;
          }
        }
        
        return selector;
      };

      // Écouter les événements importants
      const eventTypes = ['click', 'submit', 'change', 'input', 'focus', 'blur', 'keydown', 'keyup'];
      
      eventTypes.forEach(eventType => {
        document.addEventListener(eventType, captureEvent, true); // true pour la phase de capture
      });

      // Écouter les soumissions de formulaire
      document.addEventListener('submit', (event) => {
        const form = event.target as HTMLFormElement;
        console.log(`[Form Submit] ${form.id || form.className || 'form'}`, {
          action: form.action,
          method: form.method,
          elements: Array.from(form.elements).map((el: any) => ({
            name: el.name,
            type: el.type,
            value: el.value
          }))
        });
      }, true);

      console.log('[DOM Capture] Injection terminée - événements DOM surveillés');
    });

    // Polling pour récupérer les événements capturés
    setInterval(async () => {
      if (!this.page) return;
      
      try {
        const events = await this.page.evaluate(() => {
          const events = (window as any).__capturedEvents || [];
          (window as any).__capturedEvents = []; // Vider le buffer
          return events;
        });

        events.forEach((event: any) => {
          this.sessionData.domEvents.push({
            type: event.type,
            target: event.target,
            selector: event.selector,
            value: event.value,
            timestamp: event.timestamp,
            pageUrl: event.pageUrl
          });
        });
      } catch (error) {
        // Ignorer les erreurs de contexte
      }
    }, 1000); // Poll toutes les secondes
  }

  private async injectAngularDetection() {
    if (!this.page) return;

    // Injecter du code pour détecter Angular
    await this.page.addInitScript(() => {
      // Vérifier si Angular est présent
      const checkForAngular = () => {
        const hasAngular = !!(window as any).ng || 
                          !!document.querySelector('[ng-app]') || 
                          !!document.querySelector('[ng-controller]') ||
                          !!document.querySelector('[ng-model]');
        
        if (hasAngular) {
          console.log('[Angular Detection] Angular détecté sur la page');
          
          // Surveiller les appels HTTP Angular
          const originalFetch = window.fetch;
          window.fetch = function(...args) {
            console.log('[Angular HTTP] Fetch appelé:', args[0], args[1]);
            return originalFetch.apply(this, args);
          };

          // Surveiller XMLHttpRequest
          const originalXHROpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url, ...args) {
            console.log('[Angular HTTP] XHR ouvert:', method, url);
            this._method = method;
            this._url = url;
            return originalXHROpen.apply(this, [method, url, ...args]);
          };

          const originalXHRSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.send = function(body) {
            console.log('[Angular HTTP] XHR envoyé:', {
              method: this._method,
              url: this._url,
              body: body
            });
            return originalXHRSend.apply(this, [body]);
          };
        }
        
        return hasAngular;
      };

      // Vérifier périodiquement
      setInterval(checkForAngular, 2000);
      checkForAngular(); // Vérifier immédiatement
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
    
    // Extraire et log les headers importants
    const importantHeaders = ['authorization', 'refreshtoken', 'csrftoken', 'cookie', 'x-xsrf-token', 'x-correlation-key'];
    importantHeaders.forEach(header => {
      const value = request.headers()[header] || request.headers()[header.toLowerCase()];
      if (value) {
        console.log(`  [header ${header}] ${value.substring(0, 50)}${value.length > 50 ? '...' : ''}`);
      }
    });
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
          
          // Analyser les réponses JSON pour détecter des patterns Angular
          this.analyzeJSONResponse(response.url(), jsonData);
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
    
    // Log les headers de réponse importants
    const importantHeaders = ['set-cookie', 'x-correlation-key', 'content-type'];
    importantHeaders.forEach(header => {
      const value = response.headers()[header] || response.headers()[header.toLowerCase()];
      if (value) {
        console.log(`  [response header ${header}] ${value.substring(0, 100)}${value.length > 100 ? '...' : ''}`);
      }
    });
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
      
      const filePath = path.join(SESSION_DIR, `json-${safeFilename}-${timestamp}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      
      console.log(`[json saved] ${filePath}`);
    } catch (error) {
      console.error(`[json save error] ${url}: ${error}`);
    }
  }

  private analyzeJSONResponse(url: string, data: any) {
    // Détecter les patterns Angular dans les réponses JSON
    const angularPatterns = [
      { pattern: /pendingAppoStatus/, name: 'pending-appo-status' },
      { pattern: /applicationId/, name: 'application-id' },
      { pattern: /cancellable/, name: 'cancellable' },
      { pattern: /missionId/, name: 'mission-id' },
      { pattern: /appointmentId/, name: 'appointment-id' },
      { pattern: /applicantId/, name: 'applicant-id' }
    ];

    const jsonString = JSON.stringify(data).toLowerCase();
    
    angularPatterns.forEach(pattern => {
      if (jsonString.match(pattern.pattern)) {
        console.log(`[Angular Pattern] ${pattern.name} détecté dans ${url}`);
        
        this.sessionData.angularEvents.push({
          type: 'json-pattern',
          method: pattern.name,
          data: { url, pattern: pattern.name },
          timestamp: Date.now()
        });
      }
    });
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
    console.log(`[capture] Le script capture tout automatiquement:`);
    console.log(`[capture] - Requêtes HTTP avec headers`);
    console.log(`[capture] - Réponses HTTP avec JSON`);
    console.log(`[capture] - Événements DOM (clics, formulaires)`);
    console.log(`[capture] - Patterns Angular`);
    console.log(`[capture] - Logs console`);
    console.log(`[capture] Appuie sur Ctrl+C quand tu as terminé.`);
  }

  async takeScreenshot(name: string) {
    if (!this.page) return;
    
    try {
      const screenshotPath = path.join(SESSION_DIR, name);
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
    const sessionFilePath = path.join(SESSION_DIR, 'session-data.json');
    fs.writeFileSync(sessionFilePath, JSON.stringify(this.sessionData, null, 2), 'utf8');
    
    // Sauvegarder un résumé
    const summary = {
      timestamp: TIMESTAMP,
      duration: this.sessionData.endTime - this.sessionData.startTime,
      totalRequests: this.sessionData.requests.length,
      totalResponses: this.sessionData.responses.length,
      totalDomEvents: this.sessionData.domEvents.length,
      totalAngularEvents: this.sessionData.angularEvents.length,
      totalScreenshots: this.sessionData.screenshots.length,
      totalConsoleLogs: this.sessionData.consoleLogs.length,
      totalPageErrors: this.sessionData.pageErrors.length,
      sessionDir: SESSION_DIR
    };
    
    const summaryFilePath = path.join(SESSION_DIR, 'capture-summary.json');
    fs.writeFileSync(summaryFilePath, JSON.stringify(summary, null, 2), 'utf8');
    
    // Sauvegarder les requêtes et réponses dans des fichiers séparés
    const requestsFilePath = path.join(SESSION_DIR, 'requests.jsonl');
    const requestsData = this.sessionData.requests.map(req => JSON.stringify(req)).join('\n');
    fs.writeFileSync(requestsFilePath, requestsData, 'utf8');
    
    const responsesFilePath = path.join(SESSION_DIR, 'responses.jsonl');
    const responsesData = this.sessionData.responses.map(res => JSON.stringify(res)).join('\n');
    fs.writeFileSync(responsesFilePath, responsesData, 'utf8');
    
    // Sauvegarder les événements DOM
    const domEventsFilePath = path.join(SESSION_DIR, 'dom-events.jsonl');
    const domEventsData = this.sessionData.domEvents.map(event => JSON.stringify(event)).join('\n');
    fs.writeFileSync(domEventsFilePath, domEventsData, 'utf8');
    
    // Sauvegarder les événements Angular
    const angularEventsFilePath = path.join(SESSION_DIR, 'angular-events.jsonl');
    const angularEventsData = this.sessionData.angularEvents.map(event => JSON.stringify(event)).join('\n');
    fs.writeFileSync(angularEventsFilePath, angularEventsData, 'utf8');
    
    console.log(`[capture] Données de session sauvegardées dans: ${SESSION_DIR}`);
    console.log(`[capture] Résumé:`, summary);
    
    // Générer un rapport détaillé
    this.generateDetailedReport();
  }

  private generateDetailedReport() {
    const reportPath = path.join(SESSION_DIR, 'analysis-report.md');
    
    let report = `# Rapport d'analyse de capture USA\n\n`;
    report += `**Date:** ${new Date().toISOString()}\n`;
    report += `**Session:** ${SESSION_DIR}\n\n`;
    
    // Statistiques
    report += `## Statistiques\n\n`;
    report += `- Requêtes HTTP: ${this.sessionData.requests.length}\n`;
    report += `- Réponses HTTP: ${this.sessionData.responses.length}\n`;
    report += `- Événements DOM: ${this.sessionData.domEvents.length}\n`;
    report += `- Événements Angular: ${this.sessionData.angularEvents.length}\n`;
    report += `- Logs console: ${this.sessionData.consoleLogs.length}\n`;
    report += `- Erreurs: ${this.sessionData.pageErrors.length}\n\n`;
    
    // Endpoints détectés
    report += `## Endpoints API détectés\n\n`;
    const endpoints = new Map<string, number>();
    this.sessionData.requests.forEach(req => {
      const key = `${req.method} ${new URL(req.url).pathname}`;
      endpoints.set(key, (endpoints.get(key) || 0) + 1);
    });
    
    Array.from(endpoints.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .forEach(([endpoint, count]) => {
        report += `- ${endpoint} (${count} appels)\n`;
      });
    
    // Headers importants
    report += `\n## Headers importants détectés\n\n`;
    const headers = new Map<string, string[]>();
    this.sessionData.requests.forEach(req => {
      Object.entries(req.headers).forEach(([key, value]) => {
        if (key.toLowerCase().includes('token') || key.toLowerCase().includes('auth') || key.toLowerCase().includes('cookie')) {
          if (!headers.has(key)) headers.set(key, []);
          const values = headers.get(key)!;
          if (!values.includes(value) && values.length < 3) {
            values.push(value.substring(0, 100));
          }
        }
      });
    });
    
    Array.from(headers.entries()).forEach(([header, values]) => {
      report += `### ${header}\n`;
      values.forEach(value => {
        report += `- ${value}\n`;
      });
      report += `\n`;
    });
    
    // Événements DOM fréquents
    report += `## Événements DOM les plus fréquents\n\n`;
    const domEventCounts = new Map<string, number>();
    this.sessionData.domEvents.forEach(event => {
      const key = `${event.type} on ${event.target}`;
      domEventCounts.set(key, (domEventCounts.get(key) || 0) + 1);
    });
    
    Array.from(domEventCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([event, count]) => {
        report += `- ${event} (${count} fois)\n`;
      });
    
    // Patterns Angular détectés
    report += `\n## Patterns Angular détectés\n\n`;
    const angularPatterns = new Map<string, number>();
    this.sessionData.angularEvents.forEach(event => {
      angularPatterns.set(event.method || event.type, (angularPatterns.get(event.method || event.type) || 0) + 1);
    });
    
    Array.from(angularPatterns.entries()).forEach(([pattern, count]) => {
      report += `- ${pattern}: ${count} occurrences\n`;
    });
    
    // Recommandations
    report += `\n## Recommandations pour le hunter\n\n`;
    report += `1. Vérifier les endpoints dans usaPortal.ts\n`;
    report += `2. Mettre à jour les headers (CSRF, tokens)\n`;
    report += `3. Analyser la logique de pendingAppoStatus\n`;
    report += `4. Comprendre le flux des événements DOM\n`;
    report += `5. Tester avec différents états (cancellable=true/false)\n`;
    
    fs.writeFileSync(reportPath, report, 'utf8');
    console.log(`[report] Rapport d'analyse généré: ${reportPath}`);
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
      console.log(`\n[capture] === CAPTURE AVANCÉE EN COURS ===`);
      console.log(`[capture] 1. Connecte-toi manuellement au portail`);
      console.log(`[capture] 2. Navigue et interagis avec l'interface`);
      console.log(`[capture] 3. Clique sur les boutons, remplis les formulaires`);
      console.log(`[capture] 4. Navigue jusqu'à la recherche de créneaux`);
      console.log(`[capture] 5. Appuie sur Ctrl+C quand tu as terminé`);
      console.log(`[capture] ===================================\n`);
      
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
  const capturer = new USAPortalEnhancedCapturer();
  await capturer.cleanup();
  console.log(`[capture] Script terminé.`);
  process.exit(0);
});

// Lancer le capteur
const capturer = new USAPortalEnhancedCapturer();
capturer.run().catch(console.error);