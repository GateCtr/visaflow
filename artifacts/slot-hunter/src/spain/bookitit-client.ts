/**
 * Bookitit España API Client
 * 
 * Client TypeScript pour l'API Bookitit utilisée par l'ambassade d'Espagne
 * Basé sur l'analyse du bundle et les captures réseau
 */

import * as https from 'https';
import * as http from 'http';
import * as zlib from 'zlib';
import { promisify } from 'util';

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);

// Types basés sur l'analyse
export interface BookititService {
  id: string;
  groups_id: string;
  name: string;
  price: number | null;
  prepay: string;
  price_no_prepay: number | null;
  public_price: string;
  multiservice: string;
  multiservice_number: number;
  multiservice_number_min: string;
  multiselect: string;
  price_conf_type: string;
  min_price: number | null;
  description: string | null;
  video_call: string;
  groupname: string | null;
  symbol: string; // "€"
}

export interface BookititAgenda {
  id: string;
  name: string;
  // Autres champs à découvrir
}

export interface BookititSlot {
  datetime: number; // timestamp
  date: string; // ISO date
  agenda: string;
  available: boolean;
  slots: number;
}

export interface BookititClient {
  id: string;
  name: string;
  email: string;
  login: string;
  event_created: boolean;
}

export interface BookititWidgetConfiguration {
  any_agenda: string;
  registration_type: string;
  waiting_list: string;
  show_comments: string;
  mandatory_comments: string;
  min_service_to_enable: string;
  // Autres champs à découvrir
}

export interface BookititResponse<T = any> {
  Services?: BookititService[];
  Agendas?: BookititAgenda[];
  Slots?: BookititSlot[];
  Client?: BookititClient;
  WidgetConfiguration?: BookititWidgetConfiguration;
  ExtraServices?: any[];
  AllowAppointment?: boolean;
  Exception?: {
    code: string;
    message: string;
    status: number;
  };
}

export interface BookititApiOptions {
  publickey: string;
  widgetId: string;
  lang?: 'es' | 'fr' | 'en' | 'pt';
  type?: string;
  version?: string;
  baseUrl?: string;
  cfClearance?: string;
  userAgent?: string;
}

export class BookititApiClient {
  private options: Required<BookititApiOptions>;
  private defaultHeaders: Record<string, string>;

  constructor(options: BookititApiOptions) {
    this.options = {
      lang: 'es',
      type: 'default',
      version: '4',
      baseUrl: 'https://www.citaconsular.es/onlinebookings',
      cfClearance: '',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      ...options
    };

    this.defaultHeaders = {
      'User-Agent': this.options.userAgent,
      'Accept': 'text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01',
      'Accept-Language': `${this.options.lang}-${this.options.lang.toUpperCase()},${this.options.lang};q=0.9,en-US;q=0.8,en;q=0.7`,
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Referer': `https://www.citaconsular.es/es/hosteds/widgetdefault/${this.options.widgetId}/`,
      'X-Requested-With': 'XMLHttpRequest',
      'sec-ch-ua': '"Chromium";v="145", "Not:A-Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    };
  }

  setCfClearance(cookie: string): void {
    this.options.cfClearance = cookie;
  }

  private getHeaders(): Record<string, string> {
    const headers = { ...this.defaultHeaders };
    
    if (this.options.cfClearance) {
      headers['Cookie'] = `cf_clearance=${this.options.cfClearance}`;
    }
    
    return headers;
  }

  private buildUrl(endpoint: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.options.baseUrl}/${endpoint}`);
    
    const defaultParams = {
      type: this.options.type,
      publickey: this.options.publickey,
      lang: this.options.lang,
      version: this.options.version,
      src: `https://www.citaconsular.es/es/hosteds/widgetdefault/${this.options.widgetId}/`,
      srvsrc: 'https://www.citaconsular.es',
      callback: `jsonp_${Date.now()}`,
      '_': Date.now().toString()
    };
    
    const allParams = { ...defaultParams, ...params };
    
    Object.entries(allParams).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
    
    return url.toString();
  }

  private async decompressBuffer(buffer: Buffer, encoding: string | undefined): Promise<Buffer> {
    if (!encoding) {
      return buffer;
    }
    
    switch (encoding.toLowerCase()) {
      case 'gzip':
        return gunzip(buffer);
      case 'deflate':
        return inflate(buffer);
      case 'br':
        return brotliDecompress(buffer);
      default:
        return buffer;
    }
  }

  private parseJsonpResponse(body: string): BookititResponse {
    // Chercher le pattern JSONP: callback(...)
    const jsonpMatch = body.match(/^[a-zA-Z0-9_]+\((.+)\);?$/);
    
    if (jsonpMatch && jsonpMatch[1]) {
      try {
        return JSON.parse(jsonpMatch[1]);
      } catch (err) {
        // Essayer de nettoyer et reparser
        const cleaned = jsonpMatch[1]
          .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
          .trim();
        
        try {
          return JSON.parse(cleaned);
        } catch (err2) {
          const errMsg = err2 instanceof Error ? err2.message : String(err2);
          throw new Error(`Failed to parse JSONP: ${errMsg}. Raw: ${cleaned.substring(0, 200)}`);
        }
      }
    }
    
    // Essayer de parser comme JSON normal
    try {
      return JSON.parse(body);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Response is not valid JSON or JSONP: ${errMsg}`);
    }
  }

  async request<T = BookititResponse>(
    endpoint: string, 
    params: Record<string, string> = {},
    method: 'GET' | 'POST' = 'GET',
    body?: any
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = this.buildUrl(endpoint, params);
      const headers = this.getHeaders();
      
      const options: https.RequestOptions = {
        method,
        headers,
        timeout: 15000
      };
      
      const req = https.request(url, options, async (res) => {
        const chunks: Buffer[] = [];
        
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        
        res.on('end', async () => {
          try {
            const buffer = Buffer.concat(chunks);
            const encoding = res.headers['content-encoding'];
            
            // Décompresser si nécessaire
            const decompressedBuffer = await this.decompressBuffer(buffer, encoding);
            const responseBody = decompressedBuffer.toString('utf-8');
            
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${responseBody.substring(0, 200)}`));
              return;
            }
            
            // Parser la réponse JSONP
            const parsed = this.parseJsonpResponse(responseBody);
            
            // Vérifier les erreurs de l'API
            if (parsed.Exception) {
              reject(new Error(`Bookitit API Exception: ${parsed.Exception.code} - ${parsed.Exception.message}`));
              return;
            }
            
            resolve(parsed as T);
          } catch (err) {
            reject(err);
          }
        });
      });
      
      req.on('error', (err) => {
        reject(err);
      });
      
      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      if (body && method === 'POST') {
        req.write(JSON.stringify(body));
      }
      
      req.end();
    });
  }

  // Méthodes spécifiques de l'API
  
  async getServices(): Promise<BookititService[]> {
    const response = await this.request('getservices');
    return response.Services || [];
  }

  async getWidgetConfiguration(): Promise<BookititWidgetConfiguration | null> {
    const response = await this.request('getwidgetconfigurations');
    return response.WidgetConfiguration || null;
  }

  async getAgendas(serviceId: string): Promise<BookititAgenda[]> {
    const response = await this.request('getagendas', { service_id: serviceId });
    return response.Agendas || [];
  }

  async getSlots(agendaId: string, date: string): Promise<BookititSlot[]> {
    const response = await this.request('datetime', { 
      agenda: agendaId,
      date 
    });
    return response.Slots || [];
  }

  async signIn(login: string, password: string): Promise<{ client: BookititClient; token: string }> {
    const response = await this.request('signin', {}, 'POST', {
      login,
      password
    });
    
    if (!response.Client) {
      throw new Error('Authentication failed');
    }
    
    // Le token est probablement dans les headers ou cookies
    // À déterminer via capture
    return {
      client: response.Client,
      token: '' // À implémenter
    };
  }

  async checkAvailability(): Promise<{ hasSlots: boolean; slots: BookititSlot[] }> {
    // Flux complet: services -> agendas -> slots
    const services = await this.getServices();
    
    for (const service of services) {
      const agendas = await this.getAgendas(service.id);
      
      for (const agenda of agendas) {
        // Vérifier les 30 prochains jours
        for (let i = 0; i < 30; i++) {
          const date = new Date();
          date.setDate(date.getDate() + i);
          const dateStr = date.toISOString().split('T')[0];
          
          try {
            const slots = await this.getSlots(agenda.id, dateStr);
            const availableSlots = slots.filter(slot => slot.available && slot.slots > 0);
            
            if (availableSlots.length > 0) {
              return {
                hasSlots: true,
                slots: availableSlots
              };
            }
          } catch (err) {
            // Continuer avec la date suivante
            continue;
          }
        }
      }
    }
    
    return {
      hasSlots: false,
      slots: []
    };
  }
}

// Exemple d'utilisation
export async function testBookititApi() {
  const client = new BookititApiClient({
    publickey: '25028fcd7126544630b8da0c6e60722b5',
    widgetId: '25028fcd7126544630b8da0c6e60722b5',
    lang: 'es',
    cfClearance: 'gYEZ5xvvDIvzOhjATLh27Df_bX2ML_COKfuIjHTiUtE-1778517847-1.2.1.1-Ns484nN_guIur8BCq3ALLyeme52zKaKeYlJopMmE.vjffpcfPFHRNnu_SNmjQWsqcg2jo6FrVP2x3nc4tMSnWOPlwsq4XdxJ4fVqBqy5KZ5xsfzE.wbk_jIpgnV4vmeMmfWjCcCotX9988TgnuZBWAZ1Zvob510EIIWGLhWrIuyhAXJM7_W2uiKot6Vv8Jb1rwrj8OqiiFF9O28yTIifvStGf3Af5uatj_gYyKuG8F.aL9PYXQICYz1W..fJ0hYs5sA3ucHBVQSSrZapHU0LbXZvHpcb2c_nt8GjX6iZhhus76.LqOHIp3ZCRT9pL7WOaqRMPu8pjs0O2s8FrEAPQA'
  });

  try {
    console.log('🔍 Testing Bookitit España API...');
    
    // 1. Get services
    const services = await client.getServices();
    console.log(`✅ Services: ${services.length}`);
    services.forEach(service => {
      const name = service.name.replace(/<[^>]*>/g, '').trim();
      console.log(`   - ${service.id}: ${name || 'Hidden service'}`);
    });
    
    if (services.length > 0) {
      // 2. Get widget configuration
      const config = await client.getWidgetConfiguration();
      if (config) {
        console.log(`✅ Widget config: registration_type=${config.registration_type}, waiting_list=${config.waiting_list}`);
      }
      
      // 3. Check first service for agendas
      const serviceId = services[0].id;
      const agendas = await client.getAgendas(serviceId);
      console.log(`✅ Agendas for ${serviceId}: ${agendas.length}`);
      
      if (agendas.length > 0) {
        // 4. Check slots for today
        const today = new Date().toISOString().split('T')[0];
        const agendaId = agendas[0].id;
        const slots = await client.getSlots(agendaId, today);
        console.log(`✅ Slots for ${agendaId} on ${today}: ${slots.length}`);
        
        const availableSlots = slots.filter(s => s.available);
        console.log(`   Available slots: ${availableSlots.length}`);
      }
    }
    
    return { success: true, servicesCount: services.length };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('❌ API Error:', errMsg);
    return { success: false, error: errMsg };
  }
}

// Pour exécuter le test en standalone
// Utiliser: npx tsx src/spain/bookitit-client.ts
// ou importer depuis un autre fichier