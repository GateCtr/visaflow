# Plan d'intégration — Automatisation VOWINT + CEV avec IA
> Version: 1.1 — 2026-06-09 (MàJ : flux GDPR → CreateGdprNewWithAutoNumber → Edit/{VACoreId} confirmé)
> Contexte: Bot slot-hunter (Railway) — HTTP pure + Playwright fallback

---

## Vue d'ensemble

```
┌─────────────────────────────────────────────────────────────────┐
│                    WORKFLOW COMPLET                              │
│                                                                 │
│  Client (Joventy)                                               │
│      ↓ soumet dossier via dashboard                             │
│  Convex DB ─── données passeport + voyage ──────────────────►  │
│                                                            IA   │
│                                                       (remplir) │
│                                                            ↓    │
│  Bot slot-hunter                                                 │
│      1. Login VOWINT (HTTP) ──────────────────────────────────► │
│      2. Vérifier dossier existant (/VisaApplication/MyList) ──► │
│      3. Si nouveau → Créer dossier VOWINT (HTTP + IA)          │
│      4. GetEAppointmentUrl → URL intégration CEV               │
│      5. Solve hCaptcha (Anti-Captcha)                          │
│      6. Poll /Home/AvailableTimeSlots                          │
│      7. Créneau trouvé → Booking                               │
│      8. Notify Convex (markSlotFound)                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 1 — Vérification dossier existant

**Déjà implémenté dans `cevHttpSetup.ts`.**

```typescript
// GET /VisaApplication/MyList → trouver le VOWId du client
const myList = await fetch(`${VOWINT_BASE}/VisaApplication/MyList?...`, {
  headers: getCevBrowserHeaders({
    referer: `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`,
    cookie: cookies,
    xRequestedWith: true,
    accept: "application/json, text/javascript, */*; q=0.01",
    cacheControl: "max-age=0",
    ifModifiedSince: "0",
  }),
});
const { data } = await myList.json();
// → data[].VOWId = "VOWINT6115499"
// → data[].Id    = AppId pour GetEAppointmentUrl
```

**Clé de mapping :** `data[i].Id` (GUID) → utilisé dans `GET /Common/GetEAppointmentUrl?id={Id}`

---

## Phase 2 — Création d'un nouveau dossier VOWINT

> Cette phase n'est pas encore implémentée. Elle est nécessaire quand le client n'a pas encore de dossier VOWINT.

### 2.1 Flux de création (confirmé par capture live 2026-06-09)

```
GET  /en/VisaApplication/IndexByUserId
  → page liste dossiers (DataTables)
  → Bouton "New application" → href="/en/VisaApplication/Gdpr"

GET  /en/VisaApplication/Gdpr
  → Chargement gdprController.js (5KB) + hCaptcha (sitekey: 5f64399c-14a8-415e-ad1a-7ebccdc4943a)
  → Sélect type visa : 1=Court séjour ≤90j, 2=Long séjour >90j
  → Checkbox GDPR approval
  → Résolution hCaptcha si $scope.ActivateCaptcha === true (pas toujours actif)

POST /en/VisaApplication/CreateGdprNewWithAutoNumber
  Content-Type: application/x-www-form-urlencoded
  body: Approval=1&RecaptchaResponse={hcaptcha_token}
  → 200 { Success: true, VACoreId: "d9c54635-...", }   ← GUID du dossier créé
  → 200 { Success: false, ErrorMessage: "Invalid captcha challenge" }

GET  /en/VisaApplication/Edit/{VACoreId}     ← PAGE FORMULAIRE RÉELLE
  → visaApplicationController.js (131KB) + codeTypeService.js (12KB)
  → 80 champs AngularJS (confirmés en live)
  → Appels /Common/* pour popuplate les dropdowns

[user/bot remplit formulaire]
POST /VisaApplication/Save (endpoint exact — à capturer)  ← ENCORE À DOCUMENTER
  → body contient l'objet VA complet + __RequestVerificationToken
```

> **⚠️ Note hCaptcha** : Le flag `ActivateCaptcha` dans `gdprController.js` vient du HTML
> template serveur. En pratique, la capture live a montré `{"Success":false,"ErrorMessage":"Invalid captcha challenge"}`
> ce qui confirme que hCaptcha est **toujours requis** pour la création.
> Solution : Anti-Captcha `HCaptchaTaskProxyless` (CapSolver blacklisté pour ce sitekey depuis 2026-04).

### 2.2 Données requises depuis Convex

Le bot doit lire depuis l'application Convex :

```typescript
interface VowintCreationPayload {
  // Identité
  firstName:         string;   // VA.Personal_Data_FirstName
  lastName:          string;   // VA.Personal_Data_LastName
  birthDate:         string;   // VA.Personal_Data_BirthDate (DD/MM/YYYY)
  genderId:          number;   // VA.Personal_Data_GenderId
  nationalityId:     number;   // VA.Personal_Data_NationalityId (code numérique VOWINT)
  email:             string;   // VA.Personal_Data_Email
  occupationId?:     number;   // VA.Personal_Data_OccupationId

  // Document de voyage
  docTypeId:         number;   // VA.TravelDocument_DocumentTypeId
  passportNumber:    string;   // VA.TravelDocument_DocumentNumber
  passportIssueDate: string;   // VA.TravelDocument_DateOfIssue
  passportExpiry:    string;   // VA.TravelDocument_ValidUntil
  passportCountryId: number;   // VA.TravelDocument_IssuingAuthorityCountryId

  // Demande visa
  visaTypeId:        number;   // VA.Application_VisaTypeRequestedId
  purposeCategoryId: number;   // VA.Application_PurposeOfTravelCategoryId
  purposeId:         number;   // VA.Application_PurposeOfTravelId
  destinationId:     number;   // VA.Application_MemberStateOfDestinationId
  arrivalDate:       string;   // VA.Application_IntendedDateOfArrival
  departureDate:     string;   // VA.Application_IntendedDateOfDeparture
  durationDays:      number;   // VA.Application_DurationOfIntendedStay
  entriesId:         number;   // VA.Application_NumberOfEntriesRequestedId

  // GDPR
  gdprApproval:      boolean;  // VA.GdprApproval
}
```

---

## Phase 3 — Remplissage IA du formulaire

> L'IA comble le fossé entre les données brutes du client (texte libre) et les IDs numériques requis par VOWINT.

### 3.1 Problème : correspondance texte → ID numérique

Le formulaire VOWINT utilise des IDs numériques pour tous les champs clés. Ces IDs sont chargés dynamiquement depuis les endpoints `/Common/Get*`. Le bot doit :
1. Appeler les endpoints de référence pour récupérer les listes
2. Utiliser l'IA pour mapper les données client sur les IDs corrects

### 3.2 Endpoints de référence à appeler en amont

```typescript
// Appeler avant le remplissage du formulaire
const refs = await Promise.all([
  fetch(`${VOWINT_BASE}/Common/GetAllCountryTypes`),       // → [{Value, Text}]
  fetch(`${VOWINT_BASE}/Common/GetAllNationalityTypes`),   // → [{Value, Text}]
  fetch(`${VOWINT_BASE}/Common/GetAllSexTypes`),           // → [{Value, Text}]
]);

const [countries, nationalities, sexTypes] = await Promise.all(refs.map(r => r.json()));
```

### 3.3 Mapping IA — Prompt type

```typescript
async function resolveVowintIds(
  clientData: ApplicationData,    // données brutes Convex
  refs: { countries, nationalities, sexTypes, visaTypes, purposeCategories }
): Promise<VowintCreationPayload> {

  const prompt = `
Tu dois mapper les données d'un demandeur de visa vers les IDs numériques du système VOWINT belge.

DONNÉES CLIENT :
- Prénom: ${clientData.applicantName.split(' ')[0]}
- Nom: ${clientData.applicantName.split(' ').slice(1).join(' ')}
- Passeport: ${clientData.passportNumber}
- Destination: ${clientData.destination}
- Type visa: ${clientData.visaType}
- Date voyage: ${clientData.travelDate}
- Retour: ${clientData.returnDate}
- Motif: ${clientData.purpose}

LISTES DE RÉFÉRENCE :
Pays: ${JSON.stringify(refs.countries.slice(0, 50))}
Nationalités: ${JSON.stringify(refs.nationalities.slice(0, 50))}
Types visa: ${JSON.stringify(refs.visaTypes)}
Catégories motif: ${JSON.stringify(refs.purposeCategories)}

Retourne un JSON avec :
{
  "nationalityId": <number>,
  "visaTypeId": <number>,
  "purposeCategoryId": <number>,
  "purposeId": <number>,
  "destinationCountryId": <number>,
  "genderId": <number>,
  "confidence": <0-1>,
  "notes": "<points d'ambiguïté>"
}
`;

  const response = await callOpenAI(prompt, { model: "gpt-4o-mini", max_tokens: 500 });
  return JSON.parse(response);
}
```

### 3.4 Données pouvant être mappées sans IA

Ces mappings sont déterministes (pas besoin d'IA) :

| Donnée client | Transformation | Champ VOWINT |
|---|---|---|
| Destination `"USA"` | → non pertinent pour CEV Belgique | — |
| Date `travelDate` ISO → `DD/MM/YYYY` | `formatDate()` | `Application_IntendedDateOfArrival` |
| Pays passeport ISO2 → ID | `GET /Common/GetCountryIdByIso2?iso2=CD` | `TravelDocument_IssuingAuthorityCountryId` |
| Genre `"M"` / `"F"` | Lookup dans `GetAllSexTypes` | `Personal_Data_GenderId` |
| Durée = `(returnDate - travelDate).days` | Calcul direct | `Application_DurationOfIntendedStay` |

### 3.5 Champs nécessitant l'IA obligatoirement

| Champ | Pourquoi IA |
|---|---|
| `nationalityId` | Texte libre "Congolais" → ID VOWINT |
| `visaTypeId` | "C" (court séjour) vs "D" (long séjour) → mapping |
| `purposeCategoryId` | "Tourisme", "Famille", "Affaires"… |
| `purposeId` | Sous-catégorie précise selon type visa |
| `destinationId` | "Belgique" → code État membre Schengen |

---

## Phase 4 — Soumission HTTP du formulaire

> Alternative à Playwright : soumission directe via HTTP impit.

### 4.1 Approche hybride recommandée

```
┌──────────────────────────────────────────────────┐
│           DÉCISION ARCHITECTURE                  │
│                                                  │
│  Dossier existant → HTTP pur ✅                  │
│   (déjà implémenté dans cevHttpSetup.ts)         │
│                                                  │
│  Création nouveau dossier → Playwright ⚠️        │
│   (formulaire AngularJS complexe,                │
│    validation côté client difficile à simuler)   │
│                                                  │
│  Alternative création → HTTP pur avec IA ⚡      │
│   (si l'endpoint /VisaApplication/Save est       │
│    documenté — nécessite capture supplémentaire) │
└──────────────────────────────────────────────────┘
```

### 4.2 Capture requise pour HTTP pur

Pour implémenter la création en HTTP pur, il faut capturer :
1. L'URL et le body exact du `POST /VisaApplication/Save` (ou `Submit`) soumission finale
2. Le `__RequestVerificationToken` (anti-CSRF) — généré à chaque page GDPR
3. La résolution hCaptcha avant `POST CreateGdprNewWithAutoNumber`

**✅ FAIT (2026-06-09)** : 
- Flux GDPR → CreateGdprNewWithAutoNumber → Edit/{VACoreId} capturé
- 80 champs formulaire confirmés
- 16 endpoints `/Common/*` documentés (codeTypeService.js)
- Bundles Create/Edit téléchargés (visaApplicationController.js 131KB)

**📌 RESTE À CAPTURER** : Le `POST /VisaApplication/Save` (soumission finale) — body exact + tous les champs.
→ Lancer le sniffer en mode manuel, créer un dossier de test minimal, capturer le POST de soumission dans le HAR.

### 4.3 Approche Playwright recommandée (court terme)

```typescript
async function createVowintApplication(
  page: Page,
  payload: VowintCreationPayload
): Promise<string> {
  // Naviguer vers la création
  await page.goto(`${VOWINT_BASE}/en/VisaApplication/Create`);
  
  // Attendre le chargement AngularJS
  await page.waitForFunction(() => (window as any).angular?.element(document.body)?.injector());
  
  // Injecter les données via AngularJS $scope
  await page.evaluate((data) => {
    const el = document.querySelector('[ng-controller="visaApplicationController"]');
    if (!el) throw new Error("Controller not found");
    const scope = (window as any).angular.element(el).scope();
    
    // Remplir les champs
    scope.VA.Personal_Data_FirstName   = data.firstName;
    scope.VA.Personal_Data_LastName    = data.lastName;
    scope.VA.Personal_Data_BirthDate   = data.birthDate;
    scope.VA.Personal_Data_GenderId    = data.genderId;
    scope.VA.Personal_Data_NationalityId = data.nationalityId;
    scope.VA.Personal_Data_Email       = data.email;
    
    scope.VA.TravelDocument_DocumentNumber = data.passportNumber;
    scope.VA.TravelDocument_ValidUntil     = data.passportExpiry;
    scope.VA.TravelDocument_DateOfIssue    = data.passportIssueDate;
    scope.VA.TravelDocument_IssuingAuthorityCountryId = data.passportCountryId;
    
    scope.VA.Application_VisaTypeRequestedId    = data.visaTypeId;
    scope.VA.Application_PurposeOfTravelCategoryId = data.purposeCategoryId;
    scope.VA.Application_PurposeOfTravelId      = data.purposeId;
    scope.VA.Application_IntendedDateOfArrival  = data.arrivalDate;
    scope.VA.Application_IntendedDateOfDeparture = data.departureDate;
    scope.VA.Application_DurationOfIntendedStay = data.durationDays;
    
    scope.$apply();
  }, payload);
  
  // Soumettre le formulaire
  await page.click('[ng-click*="submit"], [ng-click*="save"], button[type="submit"]');
  await page.waitForNavigation({ waitUntil: "networkidle" });
  
  // Extraire le VOWId créé
  const url = page.url();
  const match = url.match(/VOWINT\d+/);
  return match?.[0] ?? await page.locator('.vow-id').textContent() ?? "";
}
```

---

## Phase 5 — Pipeline complet intégré

### 5.1 Nouveau flux dans `cev-dossier-loop.ts`

```typescript
async function processCevDossier(config: HunterConfig, dossier: DossierSlot) {
  // Étape 1 : Login VOWINT (déjà implémenté)
  const session = await getVowintSession(config.vowintEmail, config.vowintPassword);
  
  // Étape 2 : Vérifier si dossier existe dans MyList
  const myList = await fetchMyList(session);
  let appId = findAppIdByRef(myList, dossier.vowintRef);
  
  // Étape 3 : Si nouveau dossier → créer avec IA
  if (!appId) {
    const convexApp = await fetchConvexApplication(dossier.convexApplicationId);
    const refs      = await fetchVowintReferenceLists(session);
    const payload   = await resolveVowintIds(convexApp, refs); // ← IA ici
    appId = await createVowintApplication(session, payload);
    await updateConvexDossier(dossier.convexApplicationId, { vowintRef: appId });
  }
  
  // Étape 4 : GetEAppointmentUrl → intégration CEV (déjà implémenté)
  const result = await setupCevSessionHttp(session, appId, config);
  
  // Étape 5 : Loguer résultat
  await botLog({ step: "cev_dossier_processed", data: { appId, result } });
}
```

### 5.2 Schéma Convex à étendre

```typescript
// convex/schema.ts — ajouter à applications
vowintAppId: v.optional(v.string()),        // Ex: "d9c54635-..."
vowintRef:   v.optional(v.string()),        // Ex: "VOWINT6115499"
vowintCreatedAt: v.optional(v.number()),    // Timestamp création
vowintPayload: v.optional(v.string()),      // JSON payload soumis (debug)
```

---

## Phase 6 — Polling des créneaux CEV (existant)

**Déjà entièrement implémenté dans `cevHttpSetup.ts` et `cevPolling.ts`.**

```
POST /Home/AvailableTimeSlots
  body: { month: N, year: YYYY }
  → { slots: [...] } ou réponse vide (pas de créneaux)
```

---

## Priorités d'implémentation

| Priorité | Phase | Effort | Impact |
|---|---|---|---|
| 🔴 P0 | Phase 1 — Vérification dossier existant | Fait ✅ | Critique |
| 🔴 P0 | Phase 4-6 — Scan + booking CEV | Fait ✅ | Critique |
| 🟡 P1 | Phase 3 — Mapping IA (IDs VOWINT) | 2-3j | Élevé |
| 🟡 P1 | Phase 2 — Capture POST soumission | 0.5j | Élevé |
| 🟢 P2 | Phase 4 — Création HTTP pure | 3-5j | Moyen |
| 🟢 P2 | Phase 5 — Pipeline complet intégré | 2j | Moyen |

---

## Intégration IA — Recommandations techniques

### Modèle recommandé

- **GPT-4o-mini** pour le mapping IDs (économique, suffisant)
- **GPT-4o** pour les cas ambigus (motif de voyage non standard, nationalité rare)

### Cache des listes de référence

Les listes de référence VOWINT changent rarement. Stratégie de cache :

```typescript
// Cache Redis 24h pour les listes de référence
const REF_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

async function getVowintRefLists(session: VowintSession): Promise<RefLists> {
  const cached = await redis.get("vowint:ref-lists");
  if (cached) return JSON.parse(cached);
  
  const lists = await fetchAllRefLists(session);
  await redis.setex("vowint:ref-lists", 86400, JSON.stringify(lists));
  return lists;
}
```

### Validation avant soumission

```typescript
// Avant de soumettre, valider que les IDs existent dans les listes
function validatePayload(payload: VowintCreationPayload, refs: RefLists): ValidationResult {
  const errors: string[] = [];
  
  if (!refs.nationalities.find(n => n.Value === String(payload.nationalityId))) {
    errors.push(`nationalityId ${payload.nationalityId} non trouvé`);
  }
  if (!refs.visaTypes.find(v => v.Value === String(payload.visaTypeId))) {
    errors.push(`visaTypeId ${payload.visaTypeId} non trouvé`);
  }
  
  return { valid: errors.length === 0, errors };
}
```

### Gestion des erreurs IA

```typescript
// Retry avec modèle plus puissant si confiance < 0.8
if (mapping.confidence < 0.8) {
  await botLog({ step: "ai_low_confidence", data: { confidence: mapping.confidence, notes: mapping.notes } });
  // Retry avec GPT-4o + plus de contexte
  mapping = await resolveVowintIds(clientData, refs, { model: "gpt-4o" });
}

// Si toujours < 0.8 → escalader vers admin
if (mapping.confidence < 0.8) {
  await notifyAdminForManualReview(clientData);
}
```

---

## Actions immédiates requises

### ✅ Terminé

- [x] Capture bundles IndexByUserId (2026-06-08)
- [x] Capture bundles + champs Create/Edit page (2026-06-09) — 70 bundles, 80 champs, 16 endpoints /Common/*
- [x] Flux GDPR → CreateGdprNewWithAutoNumber → Edit/{VACoreId} documenté
- [x] `codeTypeService.js` analysé — 16 endpoints `/Common/*` confirmés
- [x] `gdprController.js` analysé — flow GDPR complet
- [x] `references.js` analysé — directives `<referenceperson>`, `<referenceorganisation>`

### 📌 À faire (par priorité)

1. **[P0] Capturer `POST /VisaApplication/Save`** — Lancer le sniffer en mode manuel (`HEADLESS=false`), aller jusqu'à la soumission d'un dossier de test, capturer le body exact + `__RequestVerificationToken` dans le HAR.

2. **[P1] Récupérer les listes de référence complètes** — Script HTTP authentifié pour appeler `/Common/GetAllNationalityTypes`, `/Common/GetAllCountryTypes`, `/Common/GetAllSexTypes`, `/Common/GetPurposeOfTravelCategoryByVisaTypeId?visaTypeId=1` et sauvegarder les JSONs dans `debug_dumps/reference-lists/`.

3. **[P1] Identifier l'endpoint des types de visa** — Chercher dans `visaApplicationController.js.js` (131KB) l'appel qui charge les types de visa disponibles (pas encore trouvé dans la capture).

4. **[P2] Prototyper le mapping IA** — Créer `test-ai-mapping.ts` qui prend une application Convex et retourne le payload VOWINT complet.

5. **[P2] Implémenter `createVowintApplication()`** dans `cevHttpSetup.ts` — HTTP pur avec hCaptcha Anti-Captcha pour `CreateGdprNewWithAutoNumber`, puis navigation vers `Edit/{VACoreId}`, remplissage $scope via Playwright, et `POST /VisaApplication/Save`.
