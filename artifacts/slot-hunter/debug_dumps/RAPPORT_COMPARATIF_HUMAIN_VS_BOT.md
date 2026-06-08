# Rapport Comparatif Théorique : Navigation Humaine vs Bot CEV

**Date :** 2026-06-08  
**Analyse basée sur :** Code source du bot CEV (cevHttpSetup.ts, cevPolling.ts, cev-shared-impit.ts, cev-dossier-loop.ts)

---

## 📋 Résumé Exécutif

Le bot CEV actuel utilise une approche **HTTP pur** (sans Playwright) pour le polling, ce qui est optimisé pour la performance mais présente plusieurs **points de friction probables** avec les systèmes anti-bot (F5 BIG-IP / Cloudflare). L'analyse du code révèle des différences significatives dans la cinématique réseau par rapport à une navigation humaine réelle.

**Hypothèse principale :** Le "No Availability" systématique est probablement causé par une combinaison de :
1. **Headers incomplets** (absence de certains Sec-Fetch-* dans certaines requêtes)
2. **Timing trop machine** (réponses trop rapides, absence de jitter réaliste)
3. **Fingerprint TLS** (impit est bon mais peut être détecté par F5 avancé)
4. **Cookie F5 manquant ou mal géré** (le cookie TS est capturé via Puppeteer mais pas toujours utilisé correctement)
5. **Absence de comportement de navigation** (pas de chargement de ressources statiques, pas de mouse events)

---

## 🔍 Analyse Détaillée des Différences

### 1. Headers HTTP

#### Bot CEV Actuel (`cev-shared-impit.ts` - `getCevBrowserHeaders`)

```typescript
const headers: Record<string, string> = {
  "Accept": overrides?.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Encoding": _sessionAcceptEnc,  // "gzip, deflate, br, zstd"
  "Accept-Language": _sessionAcceptLang,  // "fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7"
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-CH-UA": chUa,
  "Sec-CH-UA-Arch": _externalSiphonedChUaArch ?? '"x86"',
  "Sec-CH-UA-Bitness": _externalSiphonedChUaBitness ?? '"64"',
  "Sec-CH-UA-Full-Version-List": chUaFullVersionList,
  "Sec-CH-UA-Mobile": chUaMobile,
  "Sec-CH-UA-Platform": chUaPlatform,
  "Sec-CH-UA-Platform-Version": _externalSiphonedChUaPlatformVersion ?? '"10.0"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "User-Agent": overrides?.userAgent ?? _externalSiphonedUa ?? _sessionUa.ua,
};
```

**Points forts :**
- ✅ Headers Sec-CH-UA complets (Client Hints)
- ✅ Sec-Fetch-* présents
- ✅ Accept-Encoding réaliste (gzip, deflate, br, zstd)

**Points faibles probables :**
- ❌ **Ordre des headers** : L'ordre est déterminé par l'objet JavaScript, pas par l'ordre réel du navigateur
- ❌ **Sec-Fetch-Dest incohérent** : Toujours "document" même pour les requêtes AJAX (bien que le code tente de corriger pour contentType/xRequestedWith)
- ❌ **Absence de DNT** : "Do Not Track" header est absent (Chrome l'envoie souvent)
- ❌ **Absence de Sec-Fetch-User** dans les requêtes AJAX (supprimé manuellement dans le code)

#### Navigation Humaine Attendue

Un navigateur Chrome réel enverrait :
- **Ordre précis des headers** : Host, Connection, sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform, User-Agent, Accept, etc.
- **Sec-Fetch-Dest dynamique** : "document" pour navigation, "empty" pour fetch/XHR
- **DNT header** : Souvent "1" ou absent selon les préférences
- **Connection header** : "keep-alive" (souvent absent dans les fetch HTTP)

---

### 2. Timing et Cinématique

#### Bot CEV Actuel (`cev-shared-impit.ts` - `cevImpitFetch`)

```typescript
// Jitter réseau réaliste (30-200ms avant chaque requête)
await new Promise(r => setTimeout(r, 30 + Math.random() * 170));
```

**Points forts :**
- ✅ Jitter réseau présent (30-200ms)
- ✅ Timeout configuré (25s pour proxy)

**Points faibles probables :**
- ❌ **Jitter trop prévisible** : Distribution uniforme, pas de pattern humain
- ❌ **Absence de pauses entre les étapes** : Le bot enchaîne login → GetEAppointmentUrl → captcha → SetCaptchaToken sans pauses "réflexion"
- ❌ **Temps de réponse captcha trop rapide** : Anti-Captcha résout en ~2-5s, un humain prend 10-30s
- ❌ **Pas de simulation de lecture** : Un humain lit la page avant de cliquer

#### Navigation Humaine Attendue

- **Temps de lecture** : 2-5s entre chaque action
- **Temps de résolution captcha** : 10-30s (avec hésitations)
- **Pattern de clics** : Pas parfaitement régulier
- **Scroll events** : Un humain scrolle souvent avant de cliquer

---

### 3. Cookies et Session Management

#### Bot CEV Actuel

**Cookie F5 (TS) :**
- Capturé via Puppeteer dans `captureF5CookieForAccount` (`cev-dossier-loop.ts`)
- Stocké et réutilisé via `F5CookieManager`
- **Problème potentiel** : Le cookie F5 a une durée de vie limitée et peut expirer mid-session

**Cookie ASP.NET_SessionId :**
- Capturé lors du GET integrationUrl
- Réutilisé pour le polling
- **Problème potentiel** : Le cookie peut être invalidé par le serveur si le fingerprint change

**Cache session :**
- Cache à deux couches (auth + appId)
- **Problème potentiel** : Le cache peut devenir stale si le serveur invalide la session

#### Navigation Humaine Attendue

- **Cookie F5** : Généré naturellement par le navigateur, rafraîchi automatiquement
- **Cookie ASP.NET** : Géré par le navigateur avec les flags HttpOnly/Secure corrects
- **Session coherence** : Le navigateur maintient la cohérence TLS + cookies automatiquement

---

### 4. Fingerprint TLS

#### Bot CEV Actuel (`cev-shared-impit.ts`)

```typescript
const impit = new Impit({ browser: "chrome", ignoreTlsErrors: true } as any);
```

**Points forts :**
- ✅ Impit utilise un fingerprint TLS Chrome réaliste (JA3/JA4)
- ✅ Même instance impit partagée entre setup et polling (cohérence TLS)

**Points faibles probables :**
- ❌ **Fingerprint statique** : Même fingerprint pour toutes les sessions
- ❌ **ignoreTlsErrors: true** : Peut être détecté par F5 (comportement anormal)
- ❌ **Pas de variation TLS** : Un vrai navigateur varie légèrement le fingerprint entre sessions

#### Navigation Humaine Attendue

- **Fingerprint TLS naturel** : Variations mineures entre sessions
- **TLS errors gérés normalement** : Pas de ignoreTlsErrors
- **Handshake TLS complet** : Avec toutes les extensions normales

---

### 5. Comportement de Navigation

#### Bot CEV Actuel

**Approche HTTP pur :**
- Aucun chargement de ressources statiques (CSS, JS, images)
- Pas d'exécution JavaScript côté client
- Pas de mouse events, scroll events, keyboard events
- Requêtes ciblées uniquement (login, GetEAppointmentUrl, captcha, polling)

**Points forts :**
- ✅ Extrêmement rapide et efficace
- ✅ Coût minimal (1 captcha par check)

**Points faibles probables :**
- ❌ **Très facilement détectable** : Aucun comportement de navigation
- ❌ **Pas de preuve d'interaction humaine** : F5/Cloudflare peut détecter l'absence de navigation
- ❌ **Absence de telemetry** : Pas de telemetry browser envoyée

#### Navigation Humaine Attendue

- **Chargement complet de la page** : CSS, JS, images, fonts
- **Exécution JavaScript** : Analytics, tracking, telemetry
- **Mouse events** : Mouvements, clics, hovers
- **Scroll events** : Navigation dans la page
- **Keyboard events** : Frappe, navigation clavier
- **Telemetry** : Chrome envoie des données de télémétrie à Google

---

### 6. Gestion du Captcha

#### Bot CEV Actuel (`cevHttpSetup.ts`)

```typescript
const hcaptchaToken = await solveHcaptcha(clientId);
```

- Utilise Anti-Captcha (service externe)
- Token résolu en 2-5s
- **Problème potentiel** : Anti-Captcha peut être blacklisté ou détecté

#### Navigation Humaine Attendue

- Résolution manuelle du captcha
- Temps variable : 10-30s
- Pattern de clics sur le captcha
- Possibles erreurs et re-résolutions

---

## 🎯 Points de Friction Probables (Priorisés)

### 🔴 Critique (Probablement la cause du "No Availability")

1. **Absence de comportement de navigation**
   - Le bot ne charge pas les ressources statiques
   - F5 BIG-IP détecte l'absence de telemetry browser
   - **Solution** : Ajouter un mode "navigation simulée" avec Playwright pour le setup initial

2. **Cookie F5 mal géré**
   - Le cookie F5 est capturé via Puppeteer mais peut expirer
   - Le bot ne rafraîchit pas le cookie F5 mid-session
   - **Solution** : Rafraîchir le cookie F5 périodiquement ou après N échecs

3. **Headers Sec-Fetch incohérents**
   - Sec-Fetch-Dest est parfois incorrect pour les requêtes AJAX
   - L'ordre des headers n'est pas réaliste
   - **Solution** : Corriger l'ordre et la cohérence des headers

### 🟠 Important

4. **Timing trop machine**
   - Jitter réseau trop prévisible
   - Pas de pauses entre les étapes
   - **Solution** : Ajouter des pauses "réflexion" et un jitter plus réaliste

5. **Fingerprint TLS statique**
   - Même fingerprint pour toutes les sessions
   - ignoreTlsErrors: true peut être détecté
   - **Solution** : Varier le fingerprint TLS et supprimer ignoreTlsErrors

6. **Résolution captcha trop rapide**
   - Anti-Captcha résout en 2-5s vs 10-30s humain
   - **Solution** : Ajouter un délai artificiel après résolution captcha

### 🟡 Secondaire

7. **Absence de DNT header**
   - Chrome l'envoie souvent
   - **Solution** : Ajouter DNT: "1" ou "0" de manière cohérente

8. **Cache session stale**
   - Le cache peut devenir stale si le serveur invalide la session
   - **Solution** : Invalider le cache plus agressivement

---

## 📊 Recommandations pour le Script de Capture

Le script `cev-network-sniffer.ts` que nous avons créé permettra de :

1. **Capturer l'ordre exact des headers** humains
2. **Mesurer les temps de réponse réels** (login, captcha, polling)
3. **Identifier les cookies F5/ASP.NET réels** et leur durée de vie
4. **Capturer la cinématique captcha** (chargement iframe, soumission token)
5. **Identifier les requêtes de telemetry** que nous ne faisons pas

**Après exécution du script :**
- Comparer les headers humains vs bot
- Comparer les timings humains vs bot
- Identifier les requêtes manquantes dans le bot
- Ajuster le bot en conséquence

---

## 🔬 Plan d'Action Proposé

### Phase 1 : Capture (Immédiat)
1. Exécuter `npx tsx src/debug/cev-network-sniffer.ts`
2. Naviguer manuellement sur le site CEV
3. Capturer le flow complet
4. Analyser les JSON générés

### Phase 2 : Analyse (Après capture)
1. Comparer les headers (ordre, casse, valeurs)
2. Comparer les timings (login, captcha, polling)
3. Identifier les requêtes manquantes
4. Identifier les cookies F5/ASP.NET réels

### Phase 3 : Correction (Après analyse)
1. Corriger l'ordre des headers
2. Ajouter les pauses "réflexion"
3. Rafraîchir le cookie F5 périodiquement
4. Ajouter un mode "navigation simulée" optionnel
5. Varier le fingerprint TLS

### Phase 4 : Test (Après correction)
1. Tester avec le bot corrigé
2. Comparer les résultats (No Availability vs Slot Found)
3. Ajuster itérativement

---

## 📝 Conclusion

Le bot CEV actuel est **très bien optimisé** pour la performance mais **probablement trop détectable** par les systèmes anti-bot avancés (F5 BIG-IP / Cloudflare). Les points de friction les plus probables sont :

1. **Absence de comportement de navigation** (critique)
2. **Cookie F5 mal géré** (critique)
3. **Headers incohérents** (important)
4. **Timing trop machine** (important)

Le script de capture que nous avons créé permettra de **confirmer ces hypothèses** et de **corriger le bot** de manière ciblée.

---

**Document généré automatiquement par Cascade AI**
**Basé sur l'analyse du code source du bot CEV**
