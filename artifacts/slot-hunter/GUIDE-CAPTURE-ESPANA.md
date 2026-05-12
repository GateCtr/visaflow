# Guide de Capture API España

## 📋 Objectif
Capturer toutes les requêtes réseau du widget Bookitit España pour analyser l'API et construire un client automatisé.

## 🚀 Comment lancer la capture

### Option 1: Via npm script (recommandé)
```bash
cd artifacts/slot-hunter
pnpm run spain:capture
```

### Option 2: Directement avec tsx
```bash
cd artifacts/slot-hunter
npx tsx scripts/spain-manual-capture.ts
```

## 📝 Étapes à suivre MANUELLEMENT

1. **Le navigateur s'ouvre automatiquement** sur:
   ```
   https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5
   ```

2. **Passer le challenge Cloudflare**:
   - Cochez la case "Je ne suis pas un robot"
   - Attendez la vérification

3. **Cliquer sur l'alerte "Welcome / Bienvenido"**:
   - Une alerte native du navigateur apparaît
   - Cliquez sur OK

4. **Cliquer sur "continuer/continuar"**:
   - Une page blanche avec le message apparaît
   - Cliquez sur le bouton "continuer/continuar"

5. **Attendre le spinner et la redirection**:
   - Un spinner de chargement apparaît
   - L'URL change avec `#services` à la fin

6. **Voir le message final**:
   - "No hay horas disponibles. Inténtelo de nuevo dentro de unos días."

7. **Fermer le navigateur**:
   - Quand vous avez terminé, fermez simplement le navigateur
   - Les données seront sauvegardées automatiquement

## 📊 Données capturées

Le script capture **TOUTES** les interactions réseau:

### Fichiers générés:
- `captured/spain/capture-[timestamp].json` - Données complètes
- `captured/spain/api-summary-[timestamp].json` - Résumé des APIs

### Données incluses:
- ✅ **Toutes les requêtes HTTP/HTTPS**
- ✅ **Toutes les réponses** (corps, headers, status)
- ✅ **Cookies** à chaque étape
- ✅ **Pages HTML** complètes
- ✅ **Logs console** JavaScript
- ✅ **Timing** de chaque requête
- ✅ **Appels API Bookitit** spécifiques

### Points d'intérêt particuliers:
- Requêtes vers `api.bookitit.com`
- Requêtes vers `bookitit.com`
- Fichiers JavaScript du widget
- Tokens d'authentification
- Paramètres d'initialisation

## 🔍 Analyse après capture

Une fois la capture terminée:

1. **Examinez `api-summary-[timestamp].json`** pour:
   - Liste de tous les endpoints API
   - Méthodes HTTP utilisées
   - Domaines appelés

2. **Cherchez les patterns**:
   - URLs d'API: `getservices/`, `getagendas/`, `datetime/`, etc.
   - Paramètres: `publickey`, `widget_id`, `lang`
   - Tokens: `bktToken`, `cf_clearance`

3. **Vérifiez les réponses JSON**:
   - Structure des services
   - Format des créneaux (slots)
   - Données client

## 🛠️ Prochaines étapes

Après la capture réussie:

1. **Analyser les données capturées**
2. **Identifier l'URL exacte de l'API Bookitit**
3. **Comprendre le format des requêtes/réponses**
4. **Créer un client API TypeScript**
5. **Implémenter le polling automatique**

## ⚠️ Notes importantes

- **Ne fermez pas le terminal** pendant la capture
- **Laissez le navigateur ouvert** pendant votre navigation manuelle
- **Attendez que toutes les étapes soient terminées** avant de fermer
- **Vérifiez que le dossier `captured/spain/`** contient les fichiers

## 🔧 Dépannage

### Problème: "Cannot accept dialog which is already handled!"
- Solution: Le script gère déjà les alertes automatiquement
- Ignorez cette erreur, elle est sans conséquence

### Problème: Le navigateur ne s'ouvre pas
- Vérifiez que Playwright est installé: `pnpm install`
- Essayez de réinstaller Chromium: `npx playwright install chromium`

### Problème: Capture vide
- Assurez-vous de naviguer MANUELLEMENT comme décrit
- Vérifiez que vous passez bien le challenge Cloudflare
- Attendez que toutes les redirections soient terminées

---

**💡 Astuce:** Pendant la capture, regardez la console du terminal pour voir en temps réel les requêtes capturées. Les appels API Bookitit seront marqués avec `🔍 API CALL:`.

**🎯 Objectif final:** Obtenir suffisamment de données pour reconstruire l'API Bookitit et créer un bot de réservation automatisé.