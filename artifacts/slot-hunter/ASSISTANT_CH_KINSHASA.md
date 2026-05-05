# Système d'assistance visa Suisse — Ambassade de Kinshasa
**Portail :** swiss-visa.ch/ivis2 · `landCode: 0050` · `vertretungsCode: 4658`
**RDV :** Email uniquement → `kinshasa.rdz.visa@eda.admin.ch`
**Délai actuel :** 4–5 semaines (haute saison)

---

## Architecture du système

```
Client Joventy              Bot Joventy                  Ambassade CH Kinshasa
──────────────              ───────────                  ─────────────────────
Crée un dossier   →    1. Remplit ivis2            →    Formulaire soumis
Fournit ses données     2. Récupère Online-ID            ↓
                        3. Compose email RDV        →    kinshasa.rdz.visa@eda.admin.ch
                        4. Envoie pièces jointes          ↓
                        5. Surveille boîte IMAP     ←    Invitation Outlook reçue
                        6. Alerte client            →    Notification SMS/email/dashboard
```

---

## Phase 1 — Soumission du formulaire ivis2

### 1.1 Pré-requis collectés dans le dossier Joventy
```typescript
interface DossierSuisse {
  // Identité
  nom: string
  postnom: string
  prenoms: string
  dateNaissance: string        // DD.MM.YYYY
  lieuNaissance: string
  nationalite: string          // code pays
  genre: 'M' | 'F'
  etatCivil: string
  
  // Contact
  email: string
  telephone: string
  adresse: string
  
  // Voyage
  dateDepart: string           // prévue
  motifVoyage: string          // tourisme, affaires, famille, etc.
  dureeSejourPrevue: number    // jours
  
  // Documents
  numeroPasseport: string
  dateExpirationPasseport: string
  scanPasseport: File          // requis pour email RDV
  
  // ZAV config (pré-rempli Kinshasa)
  zavId: number                // 293
  landCode: string             // "0050"
  vertretungsCode: string      // "4658"
  ambassadeEmail: string       // "kinshasa.rdz.visa@eda.admin.ch"
}
```

### 1.2 Flux Playwright pour ivis2
```typescript
// Étapes automatisées
const steps = [
  // STEP 1 : GET /ivis2/ → récupérer XSRF cookie
  'GET https://www.swiss-visa.ch/ivis2/',
  
  // STEP 2 : Sélection pays (i210)
  // GET rest/zav/getZAVbyLandCode/0050 → ZAV Kinshasa
  
  // STEP 3 : Sélection représentation (i230)
  // Choisir ZAV id=293 (Kinshasa)
  
  // STEP 4 : Choix communication (i240)
  // internetTerminVerwaltung=false → affiche message email RDV
  // Cliquer "Demande en ligne" (internetAntrag=true)
  
  // STEP 5 : Inscription (i250) ← CAPTCHA ICI
  // GET rest/captcha/create/{sessionId}/{timestamp} → image
  // → OCR ou solver humain
  // POST rest/benutzer/session/create/{sessionId}/{btoa(captcha)}
  // body: BenutzerSessionDto
  
  // STEP 6 : Confirmation email envoyé (i260)
  // → Surveiller boîte email pour lien de connexion
  
  // STEP 7 : Login via lien email (i410)
  // GET /ivis2/#/login/login.action?id={benutzerSessionId}
  
  // STEP 8–14 : Remplissage formulaire complet
  // i440 personendaten, i450 représentant légal, i460 doc voyage,
  // i470 emploi, i480 voyage prévu, i490 hébergement, i500 frais
  
  // STEP 15 : Soumission finale (i560)
  // PUT rest/antrag/validate/antrag
  // POST rest/antrag/create/{lang}
  
  // STEP 16 : Récupérer Online-ID depuis le PDF généré
  // GET rest/report/generate/summary/{token}/{lang}
]
```

### 1.3 Gestion du captcha (i250)
```typescript
// Option A — OCR local (Tesseract)
const captchaUrl = `/ivis2/rest/captcha/create/${sessionId}/${Date.now()}`
const imageBuffer = await fetch(captchaUrl)
const text = await tesseract.recognize(imageBuffer)
const captchaBase64 = btoa(text.trim())

// Option B — Solver externe (2captcha / Anti-Captcha)
const taskId = await anticaptcha.createImageTask(imageBuffer)
const solution = await anticaptcha.waitForResult(taskId)
const captchaBase64 = btoa(solution)

// Option C — Semi-manuel (recommandé au départ)
// Afficher l'image au client Joventy via dashboard
// Client tape la réponse → bot continue
```

---

## Phase 2 — Envoi de la demande de RDV par email

### 2.1 Template email vers l'ambassade
```typescript
const emailRDV = {
  to: 'kinshasa.rdz.visa@eda.admin.ch',
  subject: `Demande de rendez-vous visa Schengen — ${dossier.nom} ${dossier.prenoms} — Online-ID: ${onlineId}`,
  
  body: `
Madame, Monsieur,

Je souhaite prendre rendez-vous pour le dépôt de ma demande de visa Schengen.

**Online-ID :** ${onlineId}
**Nom :** ${dossier.nom}
**Postnom :** ${dossier.postnom}
**Prénom(s) :** ${dossier.prenoms}
**Date de naissance :** ${dossier.dateNaissance}
**Numéro de téléphone :** ${dossier.telephone}
**Motif du voyage :** ${dossier.motifVoyage}
**Date prévue du départ :** ${dossier.dateDepart}

Je joins à ce courriel une copie de mon passeport.

Je reste à votre disposition pour tout renseignement complémentaire.

Cordialement,
${dossier.prenoms} ${dossier.nom}
  `,
  
  attachments: [
    { filename: `passeport_${dossier.nom}.pdf`, content: dossier.scanPasseport }
  ]
}
```

### 2.2 Implémentation Nodemailer / Resend
```typescript
// Via Resend (recommandé — déjà dans l'écosystème Joventy si configuré)
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

await resend.emails.send({
  from: `Joventy Bot <noreply@joventy.cd>`,
  replyTo: dossier.email,  // réponse de l'ambassade va au client
  to: 'kinshasa.rdz.visa@eda.admin.ch',
  ...emailRDV
})
```

**Important :** Le `replyTo` doit être l'email du client pour que la réponse de l'ambassade lui parvienne directement.

---

## Phase 3 — Surveillance de la boîte email (IMAP polling)

### 3.1 Détection de l'invitation Outlook
```typescript
import Imap from 'imap'
import { simpleParser } from 'mailparser'

interface TerminConfig {
  host: string          // imap.gmail.com, outlook.live.com, etc.
  user: string          // email du client
  password: string      // mot de passe app ou OAuth token
  tls: boolean
}

async function pollForAppointment(config: TerminConfig, dossierId: string) {
  const imap = new Imap({
    host: config.host,
    user: config.user,
    password: config.password,
    tls: config.tls,
    tlsOptions: { rejectUnauthorized: false }
  })
  
  return new Promise((resolve) => {
    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        // Chercher emails de l'ambassade non lus
        imap.search([
          'UNSEEN',
          ['FROM', 'eda.admin.ch'],
        ], (err, uids) => {
          if (uids.length > 0) {
            // Extraire et parser l'invitation .ics (Outlook)
            const fetch = imap.fetch(uids, { bodies: '' })
            fetch.on('message', async (msg) => {
              const parsed = await simpleParser(msg)
              const icsAttachment = parsed.attachments
                .find(a => a.contentType === 'text/calendar')
              
              if (icsAttachment) {
                const appointmentData = parseICS(icsAttachment.content)
                await notifyClient(dossierId, appointmentData)
                resolve(appointmentData)
              }
            })
          }
        })
      })
    })
    imap.connect()
  })
}
```

### 3.2 Parser ICS (invitation Outlook)
```typescript
interface AppointmentData {
  dateTime: Date           // DTSTART
  duration: number         // minutes
  location: string         // adresse ambassade
  subject: string          // objet du RDV
  organizer: string        // email ambassade
  uid: string              // identifiant unique du RDV
}

function parseICS(icsContent: Buffer): AppointmentData {
  const ical = require('node-ical')
  const events = ical.parseICS(icsContent.toString())
  const event = Object.values(events)[0] as any
  
  return {
    dateTime: new Date(event.start),
    duration: (new Date(event.end) - new Date(event.start)) / 60000,
    location: event.location || 'Ambassade de Suisse, Kinshasa',
    subject: event.summary,
    organizer: event.organizer?.val,
    uid: event.uid
  }
}
```

---

## Phase 4 — Notification client

### 4.1 Notification email au client
```typescript
await resend.emails.send({
  from: 'Joventy <notifications@joventy.cd>',
  to: dossier.email,
  subject: `✅ Rendez-vous confirmé — Ambassade Suisse Kinshasa`,
  html: `
    <h2>Votre rendez-vous est confirmé !</h2>
    <p><strong>Date :</strong> ${formatDate(appointment.dateTime)}</p>
    <p><strong>Heure :</strong> ${formatTime(appointment.dateTime)}</p>
    <p><strong>Lieu :</strong> ${appointment.location}</p>
    <p><strong>Online-ID :</strong> ${onlineId}</p>
    <hr/>
    <p>N'oubliez pas d'apporter :</p>
    <ul>
      <li>Formulaire de demande signé (PDF imprimé)</li>
      <li>Passeport original</li>
      <li>Tous les documents requis</li>
    </ul>
  `
})
```

### 4.2 Mise à jour dashboard Joventy (Convex)
```typescript
// convex/mutations/dossier.ts
export const updateAppointment = mutation({
  args: {
    dossierId: v.id('dossiers'),
    appointment: v.object({
      dateTime: v.string(),
      location: v.string(),
      uid: v.string(),
    })
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.dossierId, {
      status: 'appointment_confirmed',
      appointment: args.appointment,
      appointmentConfirmedAt: Date.now(),
    })
  }
})
```

---

## Schéma Convex — Extension dossier Suisse

```typescript
// Ajout au schema.ts existant
dossiers: defineTable({
  // ... champs existants ...
  
  // Spécifique Suisse/Kinshasa
  suisse: v.optional(v.object({
    onlineId: v.optional(v.string()),
    benutzerSessionId: v.optional(v.string()),
    ivis2Status: v.optional(v.string()),  // SessionStatusType
    rdvEmailSentAt: v.optional(v.number()),
    rdvEmailMessageId: v.optional(v.string()),
    
    // Config IMAP client (chiffrée)
    imapConfig: v.optional(v.object({
      host: v.string(),
      user: v.string(),
      passwordEncrypted: v.string(),  // AES-256 chiffré
    })),
    
    // RDV obtenu
    appointment: v.optional(v.object({
      dateTime: v.string(),
      location: v.string(),
      uid: v.string(),
      confirmedAt: v.number(),
    })),
    
    // Captcha (semi-manuel)
    captchaPending: v.optional(v.boolean()),
    captchaImageUrl: v.optional(v.string()),
  }))
})
```

---

## Workflow Convex (Cron job)

```typescript
// convex/crons.ts
crons.interval('poll-imap-kinshasa', { minutes: 15 }, async (ctx) => {
  // Récupérer tous les dossiers Suisse en attente de RDV
  const dossiers = await ctx.db
    .query('dossiers')
    .filter(q => q.eq(q.field('suisse.ivis2Status'), 'rdv_email_sent'))
    .collect()
  
  for (const dossier of dossiers) {
    if (dossier.suisse?.imapConfig) {
      await ctx.scheduler.runAfter(0, internal.imap.pollForAppointment, {
        dossierId: dossier._id,
        imapConfig: dossier.suisse.imapConfig
      })
    }
  }
})
```

---

## Sécurité — Credentials IMAP

Les mots de passe IMAP ne doivent jamais être stockés en clair.

```typescript
// Chiffrement AES-256-GCM avant stockage Convex
import { createCipheriv, randomBytes } from 'crypto'

const ENCRYPTION_KEY = Buffer.from(process.env.IMAP_ENCRYPTION_KEY!, 'hex') // 32 bytes

function encryptPassword(password: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv)
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`
}

function decryptPassword(encrypted: string): string {
  const [ivHex, encHex, tagHex] = encrypted.split(':')
  const decipher = createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8')
}
```

---

## Checklist d'implémentation

### Backend (Convex)
- [ ] Étendre schema `dossiers` avec champs `suisse`
- [ ] Mutation `updateIvisStatus`
- [ ] Mutation `updateAppointment`
- [ ] Action `submitIvis2Form` (Playwright headless)
- [ ] Action `sendRdvEmail` (Resend)
- [ ] Action `pollImapForAppointment`
- [ ] Cron job toutes les 15 min
- [ ] Chiffrement/déchiffrement credentials IMAP

### Frontend (React)
- [ ] Section "Visa Suisse" dans création dossier
- [ ] Widget configuration IMAP (email + app password)
- [ ] Affichage captcha semi-manuel (image + input)
- [ ] Timeline de statut (formulaire → email RDV → RDV confirmé)
- [ ] Affichage carte RDV dans dashboard
- [ ] Notification in-app quand RDV obtenu

### Captcha
- [ ] Intégration Anti-Captcha ou 2captcha (option A)
- [ ] OU widget semi-manuel client (option B, plus simple au départ)

---

## Variables d'environnement requises

```env
IMAP_ENCRYPTION_KEY=<32 bytes hex>     # pour chiffrer mots de passe IMAP
RESEND_API_KEY=<key>                   # pour envoyer emails
ANTICAPTCHA_KEY=<key>                  # si solver automatique captcha
PLAYWRIGHT_HEADLESS=true
```

---

*Document créé le 05/05/2026 — Basé sur reverse-engineering swiss-visa.ch/ivis2 + confirmation API ZAV*
