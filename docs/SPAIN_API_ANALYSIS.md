# Analyse API Portail Espagne (Citaconsular)

## Vue d'ensemble

Le portail de réservation de rendez-vous pour l'ambassade d'Espagne à Kinshasa utilise **Bookitit**, une plateforme SaaS espagnole de gestion de rendez-vous. Ce document détaille l'architecture API découverte via l'analyse du bundle JavaScript.

---

## Architecture Technique

### Stack Frontend
- **Framework**: Backbone.js v1.x
- **Loader**: RequireJS 2.1.14
- **UI**: jQuery 2.1.1 + jQuery UI 1.12.1
- **Transport**: JSONP (cross-origin)

### Plateforme Backend
- **Provider**: Bookitit.com
- **Type**: API REST JSONP
- **Protection**: Cloudflare Managed Challenge sur le widget HTML

---

## Endpoints API

### URL de Base
```
https://api.bookitit.com/api/v3/
```

> Note: L'URL exacte est construite dynamiquement via `Utils.get_server_url()`

### Endpoints Identifiés

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `getserverurl/` | GET | Configuration initiale du widget |
| `getservices/` | GET | Liste des services (types de visa) |
| `getagendas/` | GET | Liste des agendas (consulats/centres) |
| `datetime/` | GET | Créneaux disponibles pour une date |
| `signup/` | POST | Inscription nouveau client |
| `signin/` | POST | Connexion client existant |
| `signedin/` | POST | Validation session active |
| `signoutaccount/` | POST | Déconnexion |
| `summary/` | POST | Créer/récapituler une réservation |
| `confirmclient/` | POST | Confirmation identité client |
| `signupfirstappointment/` | POST | Premier rendez-vous (nouveau demandeur) |
| `signupsecondappointment/` | POST | Second rendez-vous (renouvellement) |
| `recoverpassword/` | POST | Récupération mot de passe |
| `changepassword/` | POST | Changement mot de passe |
| `geteventhistory/` | GET | Historique des rendez-vous |
| `deleteeventhistory/` | POST | Annulation de rendez-vous |
| `waitinglist/` | POST | Inscription liste d'attente |
| `creditcardcapture/` | POST | Paiement carte bancaire |
| `paypalcreatepayment/` | POST | Création paiement PayPal |
| `paypalexecutepayment/` | POST | Exécution paiement PayPal |
| `niubizcreatepayment/` | POST | Création paiement Niubiz |
| `niubizexecutedpayment/` | POST | Exécution paiement Niubiz |
| `freetempevent/` | POST | Libération créneau temporaire |

---

## Paramètres d'Initialisation

### Objet `bkt_init_widget`

```javascript
bkt_init_widget = {
    publickey: "23d9b76923b741cb4165cb7fadba48129",  // Clé publique widget
    lang: "fr",                                       // Langue (fr, es, en, pt...)
    widget_id: "25028fcd7126544630b8da0c6e60722b5",  // ID widget
    theme: "default",                                 // Thème visuel
    timezone: "Africa/Kinshasa",                      // Fuseau horaire
    // ... autres paramètres de configuration
}
```

### Variables Globales Client

```javascript
oClientValues_248295 = {
    widgetconfiguration: {...},  // Configuration du widget
    widgetlabel: {...},          // Labels traduits
    widgetcustom: {...},         // Personnalisation
    bktToken: "xxx",             // Token de session
    signedInData: {...},         // Données utilisateur connecté
    selectedServices: [...],     // Services sélectionnés
    selectedAgendas: [...],      // Agendas sélectionnés
    selectedDate: "2025-01-15",  // Date sélectionnée
    selectedTime: "09:00",       // Heure sélectionnée
    selectedPeople: 1,           // Nombre de personnes
    max: 30,                     // Jours max ouverture
}
```

---

## Flux de Réservation

### Diagramme de Séquence

```
┌─────────┐     ┌──────────┐     ┌─────────────┐
│  Client │     │  Widget  │     │  Bookitit   │
└────┬────┘     └────┬─────┘     └──────┬──────┘
     │               │                   │
     │  1. Charger   │                   │
     │──────────────▶│                   │
     │               │  getservices/     │
     │               │──────────────────▶│
     │               │  Services[]       │
     │               │◀──────────────────│
     │               │  getagendas/      │
     │               │──────────────────▶│
     │               │  Agendas[]        │
     │               │◀──────────────────│
     │               │                   │
     │  2. Sélectionner service          │
     │──────────────▶│                   │
     │               │                   │
     │  3. Sélectionner agenda           │
     │──────────────▶│                   │
     │               │                   │
     │  4. Consulter créneaux            │
     │──────────────▶│                   │
     │               │  datetime/?date=  │
     │               │──────────────────▶│
     │               │  Slots[]          │
     │               │◀──────────────────│
     │               │                   │
     │  5. Sélectionner créneau          │
     │──────────────▶│                   │
     │               │                   │
     │  6. Authentification              │
     │──────────────▶│                   │
     │               │  signin/          │
     │               │──────────────────▶│
     │               │  Client{}         │
     │               │◀──────────────────│
     │               │                   │
     │  7. Confirmer                     │
     │──────────────▶│                   │
     │               │  confirmclient/   │
     │               │──────────────────▶│
     │               │  ✓                │
     │               │◀──────────────────│
     │               │                   │
     │               │  summary/         │
     │               │──────────────────▶│
     │               │  Event{}          │
     │               │◀──────────────────│
     │               │                   │
     │  Confirmation │                   │
     │◀──────────────│                   │
     │               │                   │
```

---

## Formats de Réponse

### Services

```json
{
    "Services": [
        {
            "id": "bkt291456",
            "name": "Visa Schengen Court Séjour",
            "description": "Visa C - séjour jusqu'à 90 jours",
            "duration": 30,
            "price": 0,
            "prepay": 0,
            "symbol": "€"
        },
        {
            "id": "bkt348084",
            "name": "Visa Long Séjour",
            "description": "Visa D - séjour plus de 90 jours",
            "duration": 45,
            "price": 0,
            "prepay": 0,
            "symbol": "€"
        }
    ],
    "Agendas": {
        "bkt291456": [
            {
                "id": "agenda-001",
                "name": "Ambassade d'Espagne - Kinshasa"
            }
        ]
    },
    "ExtraServices": {},
    "AllowAppointment": {}
}
```

### Créneaux (Slots)

```json
{
    "Slots": [
        {
            "datetime": 1705312800000,
            "date": "2025-01-15T09:00:00.000Z",
            "agenda": "agenda-001",
            "available": true,
            "slots": 5
        },
        {
            "datetime": 1705314600000,
            "date": "2025-01-15T09:30:00.000Z",
            "agenda": "agenda-001",
            "available": true,
            "slots": 3
        }
    ],
    "maxDays": 30
}
```

### Client / Authentification

```json
{
    "Client": {
        "id": "client-123",
        "name": "Jean Dupont",
        "email": "jean.dupont@example.com",
        "phone": "+243812345678",
        "login": "jdupont",
        "event_created": false
    },
    "bktToken": "eyJhbGciOiJIUzI1NiIs...",
    "signedInData": {
        "name": "Jean Dupont",
        "signedin": true
    }
}
```

### Erreur

```json
{
    "Exception": {
        "code": "SLOT_NOT_AVAILABLE",
        "message": "Le créneau n'est plus disponible",
        "status": 409
    }
}
```

---

## Reconstruction API-First

### Feasabilité

| Aspect | Statut | Notes |
|--------|--------|-------|
| API publique | ✅ Oui | JSONP accessible |
| Authentification | ✅ Oui | Token JWT standard |
| Cloudflare | ⚠️ Partiel | Protège HTML, pas API |
| Captcha | ❌ Non | Pas de captcha détecté sur l'API |
| Rate limiting | ⚠️ Inconnu | À tester |

### Architecture Recommandée

```
┌─────────────────────────────────────────────────────────────────────┐
│                         JOVENTY PLATFORM                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐     ┌─────────────────┐     ┌─────────────────┐   │
│  │   React     │     │    Convex       │     │   Bookitit      │   │
│  │   Frontend  │────▶│    Backend      │────▶│   API           │   │
│  │             │     │                 │     │                 │   │
│  │ - Dashboard │     │ - Proxy API     │     │ - getservices   │   │
│  │ - Sessions  │     │ - Cache slots   │     │ - getagendas    │   │
│  │ - Alerts    │     │ - Auth manager  │     │ - datetime      │   │
│  └─────────────┘     │ - Bot scheduler │     │ - signin        │   │
│                      └────────┬────────┘     │ - summary       │   │
│                               │              └─────────────────┘   │
│                      ┌────────▼────────┐                           │
│                      │   Bot Worker    │                           │
│                      │   (slot-hunter) │                           │
│                      │                 │                           │
│                      │ - Polling slots │                           │
│                      │ - Auto-book     │                           │
│                      │ - OTP intercept │                           │
│                      └─────────────────┘                           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Module API España (Proposition)

```typescript
// lib/spain/api.ts

const BOOKITIT_BASE = "https://api.bookitit.com/api/v3";
const WIDGET_ID = "25028fcd7126544630b8da0c6e60722b5";
const PUBLIC_KEY = "23d9b76923b741cb4165cb7fadba48129";

interface BookititConfig {
  publickey: string;
  widget_id: string;
  lang: string;
}

interface Service {
  id: string;
  name: string;
  duration: number;
  price: number;
}

interface Slot {
  datetime: number;
  agenda: string;
  available: boolean;
  slots: number;
}

interface Client {
  id: string;
  name: string;
  email: string;
  login: string;
}

// Services
async function getServices(config: BookititConfig): Promise<Service[]>

// Agendas (consulats)
async function getAgendas(serviceId: string): Promise<Agenda[]>

// Créneaux disponibles
async function getSlots(date: string, agenda: string): Promise<Slot[]>

// Authentification
async function signIn(login: string, password: string): Promise<{ client: Client; token: string }>

// Réservation
async function bookSlot(slot: Slot, client: Client): Promise<Event>

// Annulation
async function cancelEvent(eventId: string): Promise<boolean>
```

---

## Considérations Techniques

### 1. JSONP → JSON

Les appels API utilisent JSONP. Pour une utilisation moderne :

```javascript
// Option 1: CORS Proxy
const proxy = "https://corsproxy.io/?";
const url = `${proxy}${encodeURIComponent(bookititUrl)}`;

// Option 2: Backend proxy (recommandé)
// Convex HTTP action qui fait le call et retourne JSON
```

### 2. Cloudflare Bypass

Le widget HTML est protégé par Cloudflare Managed Challenge, mais l'API est accessible directement.

```javascript
// ❌ Bloqué par Cloudflare
fetch("https://www.citaconsular.es/es/hosteds/widgetdefault/...")

// ✅ API accessible
fetch("https://api.bookitit.com/api/v3/datetime/?...")
```

### 3. Gestion des Sessions

```javascript
// Stocker le token
localStorage.setItem("bktToken", response.bktToken);

// Inclure dans les requêtes
headers: {
  "Authorization": `Bearer ${bktToken}`,
  "X-Bkt-Token": bktToken
}
```

### 4. Timezone

```javascript
// Les créneaux sont en UTC
const localTime = new Date(slot.datetime).toLocaleString("fr-CD", {
  timeZone: "Africa/Kinshasa"
});
```

---

## Détection de Créneaux (Bot)

### Algorithme de Polling

```typescript
async function pollSpainSlots(config: WatcherConfig): Promise<ScanResult> {
  // 1. Récupérer les services
  const services = await getServices(config);
  
  // 2. Pour chaque service configuré
  for (const serviceId of config.services) {
    const agendas = await getAgendas(serviceId);
    
    // 3. Pour chaque agenda
    for (const agenda of agendas) {
      // 4. Vérifier les 30 prochains jours
      for (let day = 0; day < 30; day++) {
        const date = formatDate(addDays(new Date(), day));
        const slots = await getSlots(date, agenda.id);
        
        // 5. Si créneau disponible → Alerte
        if (slots.some(s => s.available && s.slots > 0)) {
          return {
            status: "found",
            slotInfo: `${date} - ${agenda.name}`,
            slots: slots.filter(s => s.available)
          };
        }
      }
    }
  }
  
  return { status: "not_found" };
}
```

### Intervalle Recommandé

| Période | Intervalle | Raison |
|---------|------------|--------|
| Normal | 15-30 min | Pas d'urgence |
| Haute demande | 5-10 min | Période de rentrée |
| Alerte activée | 1-2 min | Créneau détecté |

---

## Fichiers Source Analysés

```
citaconsular_bundle/
├── js/
│   ├── widgets/
│   │   └── default/
│   │       ├── app.js              # Point d'entrée
│   │       ├── router.js           # Routing SPA
│   │       ├── collections/
│   │       │   ├── services.js     # Collection services
│   │       │   ├── agendas.js      # Collection agendas
│   │       │   ├── slots.js        # Collection créneaux
│   │       │   └── events.js       # Collection événements
│   │       ├── models/
│   │       │   ├── client.js       # Modèle client
│   │       │   ├── service.js      # Modèle service
│   │       │   ├── agenda.js       # Modèle agenda
│   │       │   ├── slot.js         # Modèle créneau
│   │       │   ├── event.js        # Modèle événement
│   │       │   └── validate.js     # Validation
│   │       └── views/
│   │           ├── services.js     # Vue services
│   │           ├── agendas.js      # Vue agendas
│   │           ├── datetime.js     # Vue calendrier
│   │           ├── signin.js       # Vue connexion
│   │           ├── signup.js       # Vue inscription
│   │           └── summary.js      # Vue récapitulatif
│   └── ...
└── css/
```

---

## Prochaines Étapes

1. **Implémenter le module API España** dans `lib/spain/api.ts`
2. **Créer le proxy Convex** pour les appels Bookitit
3. **Intégrer le polling** dans le bot slot-hunter
4. **Ajouter l'auto-réservation** avec gestion OTP
5. **Tester en conditions réelles** avec les identifiants ambassade

---

## Références

- Portail: https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5
- Bookitit API: https://api.bookitit.com (non documentée publiquement)
- Email ambassade: emb.kinshasa.citasvis@maec.es

---

*Document généré le 11 janvier 2025 - Analyse du bundle citaconsular v1.0*
