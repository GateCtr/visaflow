/**
 * Bookitit España API Client — DEEP STEALTH EDITION v2
 * 
 * Client TypeScript pour l'API Bookitit utilisée par l'ambassade d'Espagne.
 * Alignement complet sur les captures réseau et anti-détection Cloudflare.
 * 
 * Features:
 * - Impit-powered TLS Chrome fingerprinting
 * - Full Client Hint alignment (Sec-CH-UA-*, perfect version matching)
 * - Cloudflare cookie injection (cf_clearance, __cf_bm)
 * - Proxy support (iProyal/SOAX)
 * - Request capture support for debugging
 */

import { getProxyImpit, getDirectImpit, setCevExternalUserAgent, getCevBrowserHeaders } from "../cev-shared-impit.js";

// Types basés sur l'analyse réseau
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
  cfBm?: string;
  otherCookies?: string;
  userAgent?: string;
  useProxy?: boolean; // True to use iProyal/SOAX proxy
}

export class BookititApiClient {
  private options: Required<BookititApiOptions>;
  private baseUrl: string;
  private refererUrl: string;

  constructor(options: BookititApiOptions) {
    this.options = {
      lang: 'es',
      type: 'default',
      version: '4',
      baseUrl: 'https://www.citaconsular.es/onlinebookings',
      cfClearance: '',
      cfBm: '',
      otherCookies: '',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36',
      useProxy: true,
      ...options
    };
    this.baseUrl = this.options.baseUrl;
    this.refererUrl = `https://www.citaconsular.es/es/hosteds/widgetdefault/${this.options.widgetId}/`;

    // Set the external user agent for full client hint alignment
    if (this.options.userAgent) {
      setCevExternalUserAgent(this.options.userAgent);
    }
  }

  setCfClearance(cookie: string): void {
    this.options.cfClearance = cookie;
  }

  setCfBm(cookie: string): void {
    this.options.cfBm = cookie;
  }

  setUserAgent(ua: string): void {
    this.options.userAgent = ua;
    setCevExternalUserAgent(ua);
  }

  setOtherCookies(cookies: string): void {
    this.options.otherCookies = cookies;
  }

  private buildCookieHeader(): string {
    const cookieParts: string[] = [];
    if (this.options.cfClearance) {
      cookieParts.push(`cf_clearance=${this.options.cfClearance}`);
    }
    if (this.options.cfBm) {
      cookieParts.push(`__cf_bm=${this.options.cfBm}`);
    }
    if (this.options.otherCookies) {
      cookieParts.push(this.options.otherCookies);
    }
    return cookieParts.join('; ');
  }

  private buildUrl(endpoint: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.baseUrl}/${endpoint}`);

    const defaultParams = {
      type: this.options.type,
      publickey: this.options.publickey,
      lang: this.options.lang,
      version: this.options.version,
      src: this.refererUrl,
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

  private parseJsonpResponse(body: string): BookititResponse {
    // Chercher le pattern JSONP: callback(...)
    // Bookitit retourne parfois callback=jQuery123({...}) avec le préfixe "callback="
    const jsonpMatch = body.match(/^(?:callback=)?[a-zA-Z0-9_$.]+\((.*)\);?$/s);

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
    const url = this.buildUrl(endpoint, params);
    const cookieHeader = this.buildCookieHeader();

    const impit = this.options.useProxy ? getProxyImpit() : getDirectImpit();

    const headers = getCevBrowserHeaders({
      referer: this.refererUrl,
      cookie: cookieHeader,
      userAgent: this.options.userAgent,
      xRequestedWith: true,
      accept: 'text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01'
    });

    const response = await impit.fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText.substring(0, 200)}`);
    }

    const responseBody = await response.text();

    // Parser la réponse JSONP
    const parsed = this.parseJsonpResponse(responseBody);

    // Vérifier les erreurs de l'API
    if (parsed.Exception) {
      throw new Error(`Bookitit API Exception: ${parsed.Exception.code} - ${parsed.Exception.message}`);
    }

    return parsed as T;
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
    // Flux complet: services → agendas → slots
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
    useProxy: true
  });

  try {
    console.log('🔍 Testing Bookitit España API (Deep Stealth)...');

    // 1. Get services
    const services = await client.getServices();
    console.log(`✅ Services: ${services.length}`);
    services.forEach(service => {
      const name = service.name ? service.name.replace(/<[^>]*>/g, '').trim() : 'Hidden service';
      console.log(`   - ${service.id}: ${name}`);
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
