#!/usr/bin/env tsx
/**
 * Script d'analyse des captures USA
 * 
 * Usage: npx tsx scripts/analyze-usa-capture.ts [capture-directory]
 * 
 * Analyse une capture existante et extrait les informations importantes:
 * - Endpoints API
 * - Headers utilisés
 * - Patterns de requêtes
 * - Données JSON importantes
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface AnalysisResult {
  captureDir: string;
  totalRequests: number;
  totalResponses: number;
  endpoints: Map<string, EndpointInfo>;
  headers: Map<string, string[]>;
  jsonFiles: string[];
  importantData: ImportantData[];
}

interface EndpointInfo {
  url: string;
  method: string;
  count: number;
  statusCodes: Map<number, number>;
  requestHeaders: Set<string>;
  responseHeaders: Set<string>;
}

interface ImportantData {
  file: string;
  type: string;
  data: any;
}

class USACaptureAnalyzer {
  private captureDir: string;
  private result: AnalysisResult;

  constructor(captureDir: string) {
    this.captureDir = captureDir;
    this.result = {
      captureDir,
      totalRequests: 0,
      totalResponses: 0,
      endpoints: new Map(),
      headers: new Map(),
      jsonFiles: [],
      importantData: []
    };
  }

  analyze() {
    console.log(`[analyse] Analyse de la capture: ${this.captureDir}`);
    
    if (!existsSync(this.captureDir)) {
      console.error(`[erreur] Dossier de capture non trouvé: ${this.captureDir}`);
      return this.result;
    }

    // Lire les fichiers de la capture
    const files = readdirSync(this.captureDir);
    
    // Analyser session-data.json
    const sessionDataPath = join(this.captureDir, 'session-data.json');
    if (existsSync(sessionDataPath)) {
      this.analyzeSessionData(sessionDataPath);
    }

    // Analyser les fichiers JSON individuels
    this.analyzeJSONFiles(files);

    // Générer un rapport
    this.generateReport();

    return this.result;
  }

  private analyzeSessionData(sessionDataPath: string) {
    try {
      const sessionData = JSON.parse(readFileSync(sessionDataPath, 'utf8'));
      
      this.result.totalRequests = sessionData.requests?.length || 0;
      this.result.totalResponses = sessionData.responses?.length || 0;

      // Analyser les requêtes
      if (sessionData.requests) {
        this.analyzeRequests(sessionData.requests);
      }

      // Analyser les réponses
      if (sessionData.responses) {
        this.analyzeResponses(sessionData.responses);
      }

    } catch (error) {
      console.error(`[erreur] Impossible d'analyser session-data.json: ${error}`);
    }
  }

  private analyzeRequests(requests: any[]) {
    for (const req of requests) {
      const url = req.url;
      const method = req.method;
      const key = `${method} ${url}`;

      if (!this.result.endpoints.has(key)) {
        this.result.endpoints.set(key, {
          url,
          method,
          count: 0,
          statusCodes: new Map(),
          requestHeaders: new Set(),
          responseHeaders: new Set()
        });
      }

      const endpoint = this.result.endpoints.get(key)!;
      endpoint.count++;

      // Analyser les headers de requête
      if (req.headers) {
        Object.keys(req.headers).forEach(header => {
          endpoint.requestHeaders.add(header);
          this.addHeaderExample(header, req.headers[header]);
        });
      }

      // Analyser le body pour les POST/PUT
      if (req.postData && ['POST', 'PUT', 'PATCH'].includes(method)) {
        this.analyzeRequestBody(url, req.postData);
      }
    }
  }

  private analyzeResponses(responses: any[]) {
    for (const res of responses) {
      const url = res.url;
      const method = 'GET'; // Par défaut, on devra corréler avec les requêtes
      const key = `${method} ${url}`;

      let endpoint = this.result.endpoints.get(key);
      if (!endpoint) {
        // Chercher un endpoint correspondant
        for (const [endpointKey, endpointInfo] of this.result.endpoints.entries()) {
          if (endpointInfo.url === url) {
            endpoint = endpointInfo;
            break;
          }
        }
      }

      if (endpoint) {
        // Compter les codes de statut
        const status = res.status;
        const currentCount = endpoint.statusCodes.get(status) || 0;
        endpoint.statusCodes.set(status, currentCount + 1);

        // Analyser les headers de réponse
        if (res.headers) {
          Object.keys(res.headers).forEach(header => {
            endpoint!.responseHeaders.add(header);
            this.addHeaderExample(header, res.headers[header]);
          });
        }

        // Analyser le body de réponse
        if (res.body) {
          this.analyzeResponseBody(url, res.body, res.headers?.['content-type']);
        }
      }
    }
  }

  private analyzeRequestBody(url: string, body: string) {
    try {
      // Essayer de parser comme JSON
      if (body.startsWith('{') || body.startsWith('[')) {
        const jsonData = JSON.parse(body);
        this.result.importantData.push({
          file: 'request-body',
          type: 'request',
          data: { url, body: jsonData }
        });
      }
    } catch (error) {
      // Pas du JSON, peut-être du form-urlencoded
      if (body.includes('=')) {
        const params = new URLSearchParams(body);
        const paramsObj: Record<string, string> = {};
        params.forEach((value, key) => {
          paramsObj[key] = value;
        });
        this.result.importantData.push({
          file: 'request-body',
          type: 'form-data',
          data: { url, params: paramsObj }
        });
      }
    }
  }

  private analyzeResponseBody(url: string, body: string, contentType?: string) {
    if (!body || body.length === 0) return;

    // Vérifier si c'est du JSON
    const isJSON = contentType?.includes('application/json') || 
                   (body.startsWith('{') || body.startsWith('['));
    
    if (isJSON) {
      try {
        const jsonData = JSON.parse(body);
        
        // Détecter les données importantes
        this.detectImportantData(url, jsonData);
        
      } catch (error) {
        // JSON invalide
      }
    }
  }

  private detectImportantData(url: string, data: any) {
    // Détecter les endpoints importants
    const importantPatterns = [
      { pattern: /getUserHistoryApplicantPaymentStatus/, name: 'user-payment-status' },
      { pattern: /getFirstAvailableMonth/, name: 'first-available-month' },
      { pattern: /getSlotDates/, name: 'slot-dates' },
      { pattern: /getSlotTime/, name: 'slot-time' },
      { pattern: /schedule/, name: 'schedule-appointment' },
      { pattern: /reschedule/, name: 'reschedule-appointment' },
      { pattern: /showRescheduleButton/, name: 'show-reschedule-button' },
      { pattern: /pendingAppoStatus/, name: 'pending-appo-status' },
      { pattern: /applicationId/, name: 'application-id' },
      { pattern: /missionId/, name: 'mission-id' }
    ];

    for (const pattern of importantPatterns) {
      if (url.match(pattern.pattern)) {
        this.result.importantData.push({
          file: url,
          type: pattern.name,
          data: data
        });
        break;
      }
    }

    // Rechercher récursivement dans les objets
    if (typeof data === 'object' && data !== null) {
      this.searchForImportantFields(data, url);
    }
  }

  private searchForImportantFields(obj: any, context: string) {
    if (Array.isArray(obj)) {
      obj.forEach(item => this.searchForImportantFields(item, context));
      return;
    }

    if (typeof obj === 'object' && obj !== null) {
      // Vérifier les champs importants
      const importantFields = ['pendingAppoStatus', 'applicationId', 'missionId', 
                               'appointmentId', 'applicantId', 'applicantUUID',
                               'cancellable', 'primaryApplicant', 'visaType'];
      
      for (const field of importantFields) {
        if (field in obj) {
          this.result.importantData.push({
            file: context,
            type: `field-${field}`,
            data: { [field]: obj[field] }
          });
        }
      }

      // Rechercher récursivement
      Object.values(obj).forEach(value => {
        this.searchForImportantFields(value, context);
      });
    }
  }

  private addHeaderExample(header: string, value: string) {
    if (!this.result.headers.has(header)) {
      this.result.headers.set(header, []);
    }
    
    const examples = this.result.headers.get(header)!;
    if (!examples.includes(value) && examples.length < 3) {
      examples.push(value);
    }
  }

  private analyzeJSONFiles(files: string[]) {
    for (const file of files) {
      if (file.endsWith('.json') && file !== 'session-data.json' && file !== 'capture-summary.json') {
        const filePath = join(this.captureDir, file);
        try {
          const content = readFileSync(filePath, 'utf8');
          const jsonData = JSON.parse(content);
          
          this.result.jsonFiles.push(file);
          
          // Analyser ce fichier JSON
          this.detectImportantData(file, jsonData);
          
        } catch (error) {
          // Ignorer les fichiers JSON invalides
        }
      }
    }
  }

  private generateReport() {
    console.log(`\n=== RAPPORT D'ANALYSE ===`);
    console.log(`Dossier: ${this.captureDir}`);
    console.log(`Requêtes totales: ${this.result.totalRequests}`);
    console.log(`Réponses totales: ${this.result.totalResponses}`);
    console.log(`Endpoints uniques: ${this.result.endpoints.size}`);
    console.log(`Fichiers JSON: ${this.result.jsonFiles.length}`);
    console.log(`Données importantes: ${this.result.importantData.length}`);

    console.log(`\n=== ENDPOINTS DÉTECTÉS ===`);
    const sortedEndpoints = Array.from(this.result.endpoints.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20); // Top 20
    
    for (const [key, endpoint] of sortedEndpoints) {
      console.log(`\n${key}`);
      console.log(`  Appels: ${endpoint.count}`);
      console.log(`  Codes de statut: ${Array.from(endpoint.statusCodes.entries()).map(([code, count]) => `${code}(${count})`).join(', ')}`);
      
      if (endpoint.requestHeaders.size > 0) {
        console.log(`  Headers requête: ${Array.from(endpoint.requestHeaders).slice(0, 5).join(', ')}${endpoint.requestHeaders.size > 5 ? '...' : ''}`);
      }
    }

    console.log(`\n=== HEADERS IMPORTANTS ===`);
    const importantHeaders = ['authorization', 'refreshtoken', 'csrftoken', 'cookie', 
                              'x-xsrf-token', 'x-correlation-key', 'referer', 'user-agent'];
    
    for (const header of importantHeaders) {
      const examples = this.result.headers.get(header) || this.result.headers.get(header.toLowerCase());
      if (examples && examples.length > 0) {
        console.log(`\n${header}:`);
        examples.forEach(example => {
          const preview = example.length > 100 ? example.substring(0, 100) + '...' : example;
          console.log(`  ${preview}`);
        });
      }
    }

    console.log(`\n=== DONNÉES IMPORTANTES EXTRACTES ===`);
    for (const data of this.result.importantData.slice(0, 10)) {
      console.log(`\n${data.type} (${data.file}):`);
      console.log(`  ${JSON.stringify(data.data, null, 2).split('\n').slice(0, 5).join('\n  ')}${JSON.stringify(data.data, null, 2).split('\n').length > 5 ? '\n  ...' : ''}`);
    }

    console.log(`\n=== RECOMMANDATIONS ===`);
    console.log(`1. Vérifier les endpoints dans usaPortal.ts`);
    console.log(`2. Mettre à jour les headers si nécessaire`);
    console.log(`3. Analyser les patterns de pendingAppoStatus`);
    console.log(`4. Vérifier la structure des réponses JSON`);
    console.log(`5. Comparer avec le bundle actuel`);
  }
}

// Point d'entrée
const args = process.argv.slice(2);
let captureDir = args[0];

if (!captureDir) {
  // Trouver la capture la plus récente
  const capturesDir = join(__dirname, '../captured/usa');
  if (existsSync(capturesDir)) {
    const captures = readdirSync(capturesDir)
      .filter(dir => dir.startsWith('capture-'))
      .map(dir => ({ dir, time: statSync(join(capturesDir, dir)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);
    
    if (captures.length > 0) {
      captureDir = join(capturesDir, captures[0].dir);
      console.log(`[info] Utilisation de la capture la plus récente: ${captureDir}`);
    }
  }
}

if (!captureDir) {
  console.error(`[erreur] Spécifie un dossier de capture ou exécute d'abord le script de capture.`);
  console.error(`Usage: npx tsx scripts/analyze-usa-capture.ts [capture-directory]`);
  process.exit(1);
}

const analyzer = new USACaptureAnalyzer(captureDir);
analyzer.analyze();