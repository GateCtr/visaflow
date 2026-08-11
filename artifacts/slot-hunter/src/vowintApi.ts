/**
 * vowintApi.ts — Client HTTP VOWINT (visaonweb.diplomatie.be)
 *
 * Encapsule le cycle de vie complet d'un dossier visa :
 *   login → [createApplication] → loadApplication → saveApplication → submitApplication
 *
 * Pas de Playwright — appels fetch() purs avec gestion du cookie jar.
 * Sérialisation jQuery $.param() pour le format attendu par ASP.NET MVC.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

export const VOWINT_BASE = 'https://visaonweb.diplomatie.be';
const GDPR_HCAPTCHA_SITEKEY = '1a9c5211-bf1a-4897-a16b-3060d469fb5d';
const GDPR_PAGE_URL = `${VOWINT_BASE}/en/VisaApplication/Gdpr`;
const ANTI_CAPTCHA_POLL_INTERVAL_MS = 5_000;
const ANTI_CAPTCHA_MAX_POLLS = 40;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VowintAddress {
  Street: string | null;
  HouseNumber: string | null;
  City: string | null;
  PostalCode: string | null;
  CountryId: number | null;
}

export interface VowintOrganisationAddress {
  Street: string | null;
  HouseNumber: string | null;
  City: string | null;
  PostalCode: string | null;
  CountryId: number | null;
}

export interface VowintReference {
  Id: string;
  ActorType: number | null;           // ActorTypes list
  ActorSubType: number | null;        // ActorSubTypes list
  Invitation: boolean | null;
  SponsorType: number | null;
  ReferenceType: number | null;
  Sponsor: boolean | null;
  SchoolID: string | null;
  Accompany: boolean | null;
  Signaled: boolean | null;
  Deleted: boolean;
  SameAddress: boolean;
  Guarantor: boolean;
  // Person (private reference)
  Person_LastName?: string | null;
  Person_FirstName?: string | null;
  Person_BirthDate?: string | null;   // "YYYY-MM-DD"
  Person_NationalityId?: number | null;
  Person_Address?: VowintAddress;
  Person_Telephonenumber?: string | null;
  Person_Email?: string | null;
  // Organisation (company / school reference)
  Organisation_Number?: string | null;
  Organisation_Name?: string | null;
  Organisation_Address?: VowintOrganisationAddress;
  Organisation_VATNumber?: string | null;
  Organisation_TelephoneNumber?: string | null;
  Organisation_EMailAddress?: string | null;
  Organisation_ContactPerson?: string | null;
  Organisation_URL?: string | null;
}

export interface VowintOccupation {
  Name: string | null;
  Address: VowintAddress;
  Email: string | null;
  Telephonenumber: string | null;
  Sponsor: boolean | null;
  ActorSubTypeId: number;
  Occupation_StatusId: number;
}

export interface VowintEUFamilyMember {
  LastName: string | null;
  FirstName: string | null;
  BirthDate: string | null;
  NationalityId: number | null;
  Address: string | null;
  IdentityDocumentNumber: string | null;
  RelationshipId: number | null;
}

/**
 * Objet VA complet — correspond à `$scope.VA` dans l'AngularJS du portail VOWINT.
 * Tous les champs sont optionnels sauf AppId (requis par le server pour Save/Submit).
 * Les champs non renseignés doivent rester `null` (pas `undefined`).
 */
export interface VowintVA {
  // ── Identifiants ──────────────────────────────────────────────────────────
  AppId: string;                          // GUID — ex: "0a3b39bb-bd63-f111-a3ae-00505691de06"
  VOWId?: string;                         // VOWINT ID — ex: "VOWINT6142288" (read-only)
  VacId?: number;                         // VAC: 1 = Belgium Brussels

  // ── Statut ────────────────────────────────────────────────────────────────
  StatusId?: number;                      // 1=New
  StatusScan?: number;
  GdprApproval?: number;                  // 1 = GDPR accepté
  Language?: string;                      // "en-US" | "fr-FR" | "nl-NL" | "de-DE"
  Application_LanguageForDossierId?: number | null;  // LanguageForDossierTypes
  DateOfApplication?: string;            // "D/MM/YYYY HH:mm:ss" — auto
  IsTravellerGroupQuestion?: number;      // TravellerGroupQuestion: 0=None, 1=Alone, 2=Group, 3=Family

  // ── Données personnelles ──────────────────────────────────────────────────
  // 1. Nom de famille
  Personal_Data_LastName?: string | null;
  // 2. Nom de naissance (si différent)
  Personal_Data_BirthLastName?: string | null;
  // 3. Prénom(s)
  Personal_Data_FirstName?: string | null;
  // 4. Date de naissance — format "YYYY-MM-DD"
  Personal_Data_BirthDate?: string | null;
  // Mineur prolongé (< 18 ans)
  Personal_Data_ExtendedMinor?: boolean | null;
  // 5. Lieu de naissance
  Personal_Data_BirthCity?: string | null;
  // 6. Pays de naissance — countryId
  Personal_Data_BirthCountryId?: number | null;
  // 7. Nationalité actuelle — nationalityId (ex: 116 = DRC)
  Personal_Data_NationalityId?: number | null;
  // 7. Nationalité à la naissance si différente
  Personal_Data_BirthNationalityId?: number | null;
  // Autres nationalités
  Personal_Data_Other_Nationalities?: Array<{ NationalityId: number }>;
  // 8. Sexe — SexTypes: 1=Male, 2=Female, 3=Unidentified
  Personal_Data_GenderId?: number | null;
  // 9. Situation civile — CivilStateTypes
  Personal_Data_CivilStateId?: number | null;
  // 11. Numéro d'identité national
  Personal_Data_PersonNumber?: string | null;
  // Membre famille UE/EEA/CH
  Application_FreeMovement?: boolean;
  EUFamilyMember?: VowintEUFamilyMember;

  // ── Adresse personnelle (19) ──────────────────────────────────────────────
  Personal_Data_Address?: VowintAddress;
  Personal_Data_Telephonenumber?: string | null;
  Personal_Data_Mobilenumber?: string | null;
  Personal_Data_Email?: string | null;
  Confirm_Email?: string | null;
  PhoneValid?: boolean;

  // ── Profession actuelle (21) ──────────────────────────────────────────────
  // OccupationTypes: 1=Farmer, 2=Legal, 3=Artist, 4=Trader...
  Personal_Data_OccupationId?: number | null;
  Personal_Data_Sponsor?: boolean | null;
  Personal_Occupation?: VowintOccupation;

  // ── Document de voyage (12-16) ────────────────────────────────────────────
  // TravelDocumentTypes: 1=Ordinary passport, 4=Diplomatic, 5=Service...
  TravelDocument_DocumentTypeId?: number | null;
  TravelDocument_DocumentNumber?: string | null;
  // Dates au format "YYYY-MM-DD"
  TravelDocument_DateOfIssue?: string | null;
  TravelDocument_ValidUntil?: string | null;
  TravelDocument_IssuingAuthorityPlace?: string | null;
  // Pays émetteur — countryId
  TravelDocument_IssuingAuthorityCountryId?: number | null;

  // ── Informations voyage ───────────────────────────────────────────────────
  // Visa type: 1=A(Airport transit), 2=C(Short stay), 3=D(Long stay)
  Application_VisaTypeRequestedId?: number | null;
  // PurposeOfTravelCategoryTypes: 1=Leisure, 2=Academic, 3=Family, 4=Humanitarian, 5=Business, 6=Return, 7=Transit
  Application_PurposeOfTravelCategoryId?: number | null;
  // PurposeOfTravelTypes (53 types) — filtré par catégorie + visa type
  Application_PurposeOfTravelId?: number | null;
  // 24. Informations supplémentaires sur le motif
  Application_PurposeOfTravelInfo?: string | null;
  // 25. État membre de destination — countryId: 32=Belgium
  Application_MemberStateOfDestinationId?: number | null;
  // 26. État membre de première entrée — countryId
  Application_MemberStateOfFirstEntryId?: number | null;
  // 27. Nombre d'entrées — NumberOfEntryTypes: 1=One, 2=Two, 3=Multiple
  Application_NumberOfEntriesRequestedId?: number | null;
  // 25/27. Durée du séjour prévu (jours)
  Application_DurationOfIntendedStay?: number | null;
  // Dates prévues — format "YYYY-MM-DD"
  Application_IntendedDateOfArrival?: string | null;
  Application_IntendedDateOfDeparture?: string | null;
  // Moyen de transport principal — MainTransportationTypes
  Application_MainTransportationId?: number | null;

  // ── Visa Schengen précédent ───────────────────────────────────────────────
  PreviousSchengenVisa_VisaNumber?: string | null;
  PreviousSchengenVisa_DateOfIssue?: string | null;   // "YYYY-MM-DD"
  PreviousSchengenVisa_ValidUntil?: string | null;    // "YYYY-MM-DD"
  PreviousSchengenVisa_DeliveredByCountryId?: number | null;

  // ── Empreintes précédentes ────────────────────────────────────────────────
  PreviousFingerPrint?: boolean | null;
  PreviousFingerprint_CaptureDate?: string | null;    // "YYYY-MM-DD"
  PreviousFingerprint_VisaNumber?: string | null;
  Application_FingerprintExemptionId?: number | null;
  Application_FingerprintExemptionReason?: string | null;
  Application_FingerprintExemptionReason_Mandatory?: boolean;
  HasFingerprints?: boolean;

  // ── Frais (géré par le système) ───────────────────────────────────────────
  // Payable le jour du RDV — mis à jour automatiquement par VOWINT
  Application_GratuityId?: number | null;   // GratuityTypes: 1=None (standard), 2=Diplomatic, 7=FamilyEU...
  Application_Fee?: number | null;           // Montant (ex: 80 EUR) — read-only
  Application_Currency?: number;
  Application_CurrencyCode?: string;
  Application_CurrencyId?: string;
  Application_Rate?: number;

  // ── Références (hébergement / invitation / financement) ───────────────────
  ReferencePersonId?: string;               // ID de la référence principale (GUID)
  References?: VowintReference[];

  // ── Tuteurs (mineurs) ─────────────────────────────────────────────────────
  Guardian_Parent1?: {
    Id: string; ActorSubTypeId: number | null; Lastname: string | null;
    Firstname: string | null; Birthdate: string | null; NationalityId: number | null;
    Address: VowintAddress; Sponsor: boolean | null;
  };
  Guardian_Parent2?: {
    Id: string; ActorSubTypeId: number | null; Lastname: string | null;
    Firstname: string | null; Birthdate: string | null; NationalityId: number | null;
    Address: VowintAddress; Sponsor: boolean | null;
  };

  // ── Permis (long séjour) ──────────────────────────────────────────────────
  PermitForResidenceCountry_DocumentNumber?: string | null;
  PermitForResidenceCountry_PermitValidUntil?: string | null;
  PermitForDestinationCountry_CountryId?: number | null;
  PermitForDestinationCountry_PermitValidFrom?: string | null;
  PermitForDestinationCountry_PermitValidUntil?: string | null;
  PermitForResidenceRequired?: boolean;

  // ── Champs internes (read-only, envoyés tels quels dans Save) ─────────────
  CompanyPrefix?: string;
  PostId?: string | null;
  GroupId?: string | null;
  SubGroupId?: string | null;
  OSUniqueId?: string | null;
  Edit?: boolean;
  SelectedVacCountry?: string | null;
  Mrz1?: string | null;
  Mrz2?: string | null;
  [key: string]: unknown;   // Autres champs renvoyés par le serveur
}

export interface VowintSaveResult {
  Success: boolean;
  SuccessMessage?: string;
  ModelErrors?: Array<{ Key: string; Value: string[] }>;
  VA?: VowintVA;
  rights?: Array<{ Key: string; Value: boolean }>;
}

export interface VowintLoadResult {
  Success: boolean;
  VA: VowintVA;
  Lists: Record<string, unknown[]>;
  rights: Array<{ Key: string; Value: boolean }>;
  ownApplication: boolean;
  anyDocument: boolean;
}

export interface VowintCreateResult {
  Success: boolean;
  VACoreId: string;         // GUID — ex: "0a3b39bb-bd63-f111-a3ae-00505691de06"
  ErrorMessage?: string;
}

// ─── jQuery $.param() ─────────────────────────────────────────────────────────
// Reproduit le comportement de jQuery.param() (mode non-traditional, défaut jQuery >= 1.4)
// Utilisé par l'AngularJS VOWINT pour sérialiser $scope.VA en form-urlencoded.

function jQueryParam(obj: unknown, prefix?: string): string {
  const parts: string[] = [];
  
  const add = (key: string, value: unknown) => {
    if (value === undefined) return;
    const strVal = value === null ? '' : String(value);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(strVal)}`);
  };
  
  const buildParam = (val: unknown, key: string) => {
    if (val === null || val === undefined) {
      add(key, val);
    } else if (Array.isArray(val)) {
      val.forEach((item, i) => {
        buildParam(item, `${key}[${i}]`);
      });
    } else if (typeof val === 'object' && !(val instanceof Date)) {
      Object.entries(val as Record<string, unknown>).forEach(([k, v]) => {
        buildParam(v, `${key}[${k}]`);
      });
    } else {
      add(key, val);
    }
  };
  
  if (prefix) {
    buildParam(obj, prefix);
  } else if (obj !== null && obj !== undefined && typeof obj === 'object' && !Array.isArray(obj)) {
    Object.entries(obj as Record<string, unknown>).forEach(([key, val]) => {
      buildParam(val, key);
    });
  }
  
  return parts.join('&');
}

// ─── Cookie jar ───────────────────────────────────────────────────────────────

class CookieJar {
  private jar = new Map<string, string>();
  
  parse(headers: Headers): void {
    const setCookieHeader = headers as unknown as { getSetCookie?(): string[] };
    const cookies = typeof setCookieHeader.getSetCookie === 'function'
      ? setCookieHeader.getSetCookie()
      : [];
    for (const c of cookies) {
      const eq = c.indexOf('=');
      const sc = c.indexOf(';');
      const k = c.slice(0, eq).trim();
      const v = c.slice(eq + 1, sc > 0 ? sc : undefined).trim();
      if (k) this.jar.set(k, v);
    }
  }
  
  toString(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  
  has(key: string): boolean {
    return this.jar.has(key);
  }
  
  get(key: string): string | undefined {
    return this.jar.get(key);
  }
  
  clear(): void {
    this.jar.clear();
  }
}

// ─── Anti-Captcha hCaptcha solver ─────────────────────────────────────────────

async function solveHcaptchaViaAntiCaptcha(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  logPrefix = '[vowint-captcha]'
): Promise<string | null> {
  const createRes = await fetch('https://api.anti-captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type: 'HCaptchaTaskProxyless', websiteURL: pageUrl, websiteKey: siteKey },
    }),
  });
  const createData = await createRes.json() as { errorId: number; errorCode?: string; taskId?: number };
  if (createData.errorId !== 0 || !createData.taskId) {
    console.error(`${logPrefix} createTask error: ${createData.errorCode ?? createData.errorId}`);
    return null;
  }
  const taskId = createData.taskId;
  console.log(`${logPrefix} Task ${taskId} — polling...`);
  
  for (let i = 0; i < ANTI_CAPTCHA_MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, ANTI_CAPTCHA_POLL_INTERVAL_MS));
    const pollRes = await fetch('https://api.anti-captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const pd = await pollRes.json() as {
      errorId: number; status: string;
      solution?: { gRecaptchaResponse?: string }; errorCode?: string;
    };
    if (pd.errorId !== 0) {
      console.error(`${logPrefix} poll error: ${pd.errorCode ?? pd.errorId}`);
      return null;
    }
    if (pd.status === 'ready' && pd.solution?.gRecaptchaResponse) {
      console.log(`${logPrefix} Solved in ${i + 1} poll(s), token length=${pd.solution.gRecaptchaResponse.length}`);
      return pd.solution.gRecaptchaResponse;
    }
    console.log(`${logPrefix} [${i + 1}/${ANTI_CAPTCHA_MAX_POLLS}] still processing...`);
  }
  console.error(`${logPrefix} Timeout after ${ANTI_CAPTCHA_MAX_POLLS} polls`);
  return null;
}

// ─── VowintApi ────────────────────────────────────────────────────────────────

export class VowintApi {
  private cookies = new CookieJar();
  private csrfToken = '';
  
  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly antiCaptchaKey: string = process.env.ANTICAPTCHA_API_KEY ?? '',
  ) {}
  
  // ── HTTP helpers ────────────────────────────────────────────────────────────
  
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      'Cookie': this.cookies.toString(),
      ...extra,
    };
  }
  
  private async get(path: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const res = await fetch(`${VOWINT_BASE}${path}`, {
      headers: this.headers(extraHeaders),
      redirect: 'follow',
    });
    this.cookies.parse(res.headers);
    return res;
  }
  
  private async post(
    path: string,
    body: string,
    extraHeaders: Record<string, string> = {},
    redirect: RequestRedirect = 'follow',
  ): Promise<Response> {
    const res = await fetch(`${VOWINT_BASE}${path}`, {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/x-www-form-urlencoded',
        ...extraHeaders,
      }),
      body,
      redirect,
    });
    this.cookies.parse(res.headers);
    return res;
  }
  
  private async getJson<T>(path: string, params?: Record<string, string | number>, referer?: string): Promise<T> {
    const url = new URL(`${VOWINT_BASE}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), {
      headers: this.headers({
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, */*; q=0.01',
        ...(referer ? { Referer: referer } : {}),
      }),
    });
    this.cookies.parse(res.headers);
    return res.json();
  }
  
  private extractCsrf(html: string): string {
    return html.match(/name="__RequestVerificationToken"[^>]+value="([^"]+)"/)?.[1] ?? '';
  }
  
  private extractAppId(html: string): string | null {
    return html.match(/app\.value\s*\(\s*["']AppId["']\s*,\s*["']([^"']+)["']\s*\)/)?.[1] ?? null;
  }
  
  // ── Public API ──────────────────────────────────────────────────────────────
  
  /**
   * Authentification VOWINT.
   * Remplit le cookie jar avec `OSOnline` (session auth).
   * Doit être appelé avant toute autre opération.
   */
  async login(): Promise<void> {
    // 1. Charger la page login pour récupérer le token CSRF
    const loginPage = await this.get('/en/Account/Login');
    const loginHtml = await loginPage.text();
    const csrfLogin = this.extractCsrf(loginHtml);
    
    // 2. POST login — redirect:manual pour capturer OSOnline dans le 302
    const loginPost = await this.post(
      '/en/Account/Login',
      new URLSearchParams({
        UserName: this.email,
        Password: this.password,
        __RequestVerificationToken: csrfLogin,
        RememberMe: 'false',
      }).toString(),
      { Origin: VOWINT_BASE, Referer: `${VOWINT_BASE}/en/Account/Login` },
      'manual',
    );
    
    // 3. Suivre la redirection
    const loc = loginPost.headers.get('location') ?? '/en/VisaApplication/IndexByUserId';
    const landingUrl = loc.startsWith('http') ? loc : `${VOWINT_BASE}${loc}`;
    const landingPage = await fetch(landingUrl, { headers: this.headers(), redirect: 'follow' });
    this.cookies.parse(landingPage.headers);
    const landingHtml = await landingPage.text();
    this.csrfToken = this.extractCsrf(landingHtml) || csrfLogin;
    
    if (!this.cookies.has('OSOnline')) {
      throw new Error('Login VOWINT échoué — cookie OSOnline absent. Vérifier les credentials.');
    }
    console.log(`[vowint] Login OK — OSOnline=${this.cookies.get('OSOnline')?.slice(0, 10)}...`);
  }
  
  /**
   * Crée un nouveau dossier VOWINT via le flux GDPR.
   * Résout le hCaptcha automatiquement via Anti-Captcha.
   * Retourne le VACoreId (GUID) du dossier créé.
   *
   * ⚠️ La création génère un vrai dossier VOWINT — à supprimer manuellement si test.
   */
  async createApplication(): Promise<VowintCreateResult> {
    if (!this.antiCaptchaKey) {
      throw new Error('ANTICAPTCHA_API_KEY requis pour créer un dossier (résolution hCaptcha GDPR).');
    }
    
    // 1. Résoudre le hCaptcha GDPR en parallèle du chargement de page
    console.log('[vowint] Résolution hCaptcha GDPR via Anti-Captcha...');
    const [hcToken, gdprPage] = await Promise.all([
      solveHcaptchaViaAntiCaptcha(this.antiCaptchaKey, GDPR_HCAPTCHA_SITEKEY, GDPR_PAGE_URL),
      this.get('/en/VisaApplication/Gdpr'),
    ]);
    
    if (!hcToken) {
      throw new Error('Résolution hCaptcha GDPR échouée — vérifier ANTICAPTCHA_API_KEY et solde.');
    }
    
    const gdprHtml = await gdprPage.text();
    const csrfGdpr = this.extractCsrf(gdprHtml) || this.csrfToken;
    
    // 2. Créer le dossier
    const createRes = await this.post(
      '/en/VisaApplication/CreateGdprNewWithAutoNumber',
      new URLSearchParams({
        Approval: '1',
        RecaptchaResponse: hcToken,
        __RequestVerificationToken: csrfGdpr,
      }).toString(),
      {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, */*',
        'Referer': `${VOWINT_BASE}/en/VisaApplication/Gdpr`,
      },
    );
    
    const result = await createRes.json() as VowintCreateResult;
    if (result.Success) {
      console.log(`[vowint] Dossier créé: ${result.VACoreId}`);
    } else {
      console.error(`[vowint] Création échouée: ${result.ErrorMessage}`);
    }
    return result;
  }
  
  /**
   * Charge un dossier existant par son VACoreId (GUID).
   * Retourne l'objet VA complet + toutes les listes de référence.
   */
  async loadApplication(vacoreId: string): Promise<VowintLoadResult> {
    // Charger la page Edit pour établir le contexte de session
    const editPage = await this.get(`/en/VisaApplication/Edit/${vacoreId}`);
    if (editPage.status === 500) {
      throw new Error(`Dossier ${vacoreId} non accessible depuis ce compte (HTTP 500). Vérifier que le dossier appartient bien au compte ${this.email}.`);
    }
    const editHtml = await editPage.text();
    this.csrfToken = this.extractCsrf(editHtml) || this.csrfToken;
    
    // Vérifier que AppId est bien dans la page
    const appId = this.extractAppId(editHtml);
    if (!appId) {
      throw new Error(`AppId GUID introuvable dans la page Edit/${vacoreId}. La page n'a peut-être pas chargé correctement.`);
    }
    
    // Appeler getVisaApplication pour obtenir VA + Lists
    const result = await this.getJson<VowintLoadResult>(
      '/en/common/getVisaApplication',
      { AppId: vacoreId },
      `${VOWINT_BASE}/en/VisaApplication/Edit/${vacoreId}`,
    );
    
    if (!result.Success) {
      throw new Error(`getVisaApplication échoué pour ${vacoreId}`);
    }
    
    console.log(`[vowint] Dossier chargé: ${result.VA.VOWId} (AppId=${result.VA.AppId})`);
    return result;
  }
  
  /**
   * Sauvegarde le dossier (bouton "Save" du formulaire VOWINT).
   * Envoie l'objet VA complet via POST /VisaApplication/Save (form-urlencoded $.param).
   *
   * Recommandé : d'abord `loadApplication()`, modifier les champs VA retournés,
   * puis appeler `saveApplication(va)` avec l'objet VA complet.
   *
   * @param va Objet VA complet (tel que retourné par loadApplication + modifications)
   */
  async saveApplication(va: VowintVA): Promise<VowintSaveResult> {
    const referer = `${VOWINT_BASE}/en/VisaApplication/Edit/${va.AppId}`;
    const body = jQueryParam(va);
    
    const res = await this.post(
      '/VisaApplication/Save',
      body,
      {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, */*',
        'Referer': referer,
      },
    );
    
    const result = await res.json() as VowintSaveResult;
    if (result.Success) {
      console.log(`[vowint] Save OK — ${result.SuccessMessage ?? ''}`);
    } else {
      const errors = result.ModelErrors?.map(e => `${e.Key}: ${e.Value.join(', ')}`).join(' | ') ?? 'unknown';
      console.warn(`[vowint] Save échec — ${errors}`);
    }
    return result;
  }
  
  /**
   * Soumet le dossier (bouton "Submit" du formulaire VOWINT).
   * Passe le statut en "To be verified" (StatusId=2).
   *
   * ⚠️ Une fois soumis, le dossier ne peut plus être modifié par le demandeur.
   *    Appeler uniquement quand tous les champs sont complets et validés.
   */
  async submitApplication(va: VowintVA): Promise<VowintSaveResult> {
    const referer = `${VOWINT_BASE}/en/VisaApplication/Edit/${va.AppId}`;
    const body = jQueryParam(va);
    
    const res = await this.post(
      '/VisaApplication/Submit',
      body,
      {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, */*',
        'Referer': referer,
      },
    );
    
    const result = await res.json() as VowintSaveResult;
    if (result.Success) {
      console.log(`[vowint] Submit OK — dossier soumis, statut → "To be verified"`);
    } else {
      const errors = result.ModelErrors?.map(e => `${e.Key}: ${e.Value.join(', ')}`).join(' | ') ?? 'unknown';
      console.warn(`[vowint] Submit échec — ${errors}`);
    }
    return result;
  }
  
  /**
   * Raccourci pour remplir et sauvegarder un dossier en une seule opération.
   *
   * Charge le dossier, applique les champs de la fiche, sauvegarde.
   * Retourne le VA mis à jour.
   *
   * @param vacoreId VACoreId du dossier (GUID)
   * @param fields   Champs à remplir (sous-ensemble de VowintVA)
   */
  async fillAndSave(vacoreId: string, fields: Partial<VowintVA>): Promise<VowintSaveResult> {
    const loaded = await this.loadApplication(vacoreId);
    const va: VowintVA = { ...loaded.VA, ...fields };
    return this.saveApplication(va);
  }
  
  /**
   * Vérifie si la session est active (cookie OSOnline présent).
   */
  isLoggedIn(): boolean {
    return this.cookies.has('OSOnline');
  }
}

// ─── Helpers de mapping (formulaire visuel → champs VA) ──────────────────────

/**
 * Mapping des champs du formulaire visuel VOWINT vers les propriétés VowintVA.
 * Utile pour générer de la documentation ou pour l'IA.
 */
export const FORM_FIELD_MAP: Record<string, keyof VowintVA | string> = {
  // Informations de base
  'language_notification':     'Application_LanguageForDossierId',  // LanguageForDossierTypes
  'location_vac':              'VacId',
  'eu_family_member':          'Application_FreeMovement',
  
  // Données personnelles
  '1_surname':                 'Personal_Data_LastName',
  '2_surname_birth':           'Personal_Data_BirthLastName',
  '3_first_name':              'Personal_Data_FirstName',
  '4_date_birth':              'Personal_Data_BirthDate',          // "YYYY-MM-DD"
  '4_extended_minor':          'Personal_Data_ExtendedMinor',
  '5_place_birth':             'Personal_Data_BirthCity',
  '6_country_birth':           'Personal_Data_BirthCountryId',     // countryId
  '7_nationality_current':     'Personal_Data_NationalityId',      // nationalityId (116=DRC)
  '7_nationality_birth':       'Personal_Data_BirthNationalityId',
  '8_sex':                     'Personal_Data_GenderId',           // 1=Male, 2=Female, 3=Unidentified
  '9_marital_status':          'Personal_Data_CivilStateId',       // CivilStateTypes
  '11_national_id':            'Personal_Data_PersonNumber',
  
  // Document de voyage
  '12_document_type':          'TravelDocument_DocumentTypeId',    // 1=Ordinary passport
  '13_document_number':        'TravelDocument_DocumentNumber',
  '14_date_issue':             'TravelDocument_DateOfIssue',       // "YYYY-MM-DD"
  '15_valid_until':            'TravelDocument_ValidUntil',        // "YYYY-MM-DD"
  '16_issued_by':              'TravelDocument_IssuingAuthorityPlace',
  '16_issuing_country':        'TravelDocument_IssuingAuthorityCountryId',
  
  // Adresse personnelle (19)
  '19_street':                 'Personal_Data_Address.Street',
  '19_house_number':           'Personal_Data_Address.HouseNumber',
  '19_postal_code':            'Personal_Data_Address.PostalCode',
  '19_city':                   'Personal_Data_Address.City',
  '19_country':                'Personal_Data_Address.CountryId',
  '19_phone':                  'Personal_Data_Telephonenumber',
  '19_mobile':                 'Personal_Data_Mobilenumber',
  '19_email':                  'Personal_Data_Email',
  
  // Profession (21)
  '21_occupation':             'Personal_Data_OccupationId',       // OccupationTypes (28 types)
  
  // Informations voyage
  'visa_type':                 'Application_VisaTypeRequestedId',  // 1=A, 2=C, 3=D
  '23_purpose_category':       'Application_PurposeOfTravelCategoryId',
  '23_purpose':                'Application_PurposeOfTravelId',    // PurposeOfTravelTypes
  '24_purpose_info':           'Application_PurposeOfTravelInfo',
  '25_destination_state':      'Application_MemberStateOfDestinationId', // 32=Belgium
  '26_first_entry_state':      'Application_MemberStateOfFirstEntryId',
  '27_entries_requested':      'Application_NumberOfEntriesRequestedId', // 1=One,2=Two,3=Multiple
  '25_duration_days':          'Application_DurationOfIntendedStay',
  '27_arrival_date':           'Application_IntendedDateOfArrival',
  '27_departure_date':         'Application_IntendedDateOfDeparture',
  'transport_means':           'Application_MainTransportationId', // MainTransportationTypes
  
  // Voyage en groupe
  'group_travel':              'IsTravellerGroupQuestion',          // 0=None,1=Alone,2=Group,3=Family
  
  // Visa Schengen précédent
  'prev_visa_number':          'PreviousSchengenVisa_VisaNumber',
  'prev_visa_issue':           'PreviousSchengenVisa_DateOfIssue',
  'prev_visa_until':           'PreviousSchengenVisa_ValidUntil',
  'prev_visa_country':         'PreviousSchengenVisa_DeliveredByCountryId',
  
  // Empreintes précédentes
  'prev_fingerprint':          'PreviousFingerPrint',
  'prev_fingerprint_date':     'PreviousFingerprint_CaptureDate',
  'prev_fingerprint_visa':     'PreviousFingerprint_VisaNumber',
};

// ─── Export utilitaire ────────────────────────────────────────────────────────

export { jQueryParam };
