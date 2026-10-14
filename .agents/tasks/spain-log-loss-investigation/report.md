# Investigation — pertes de traces des workers Espagne

## Résumé

**Cause principale prouvée : les cycles `not_found` ne sont pas tous envoyés à Convex.** Le worker actif écrit chaque cycle dans Railway avec `log(...)`, mais il n'appelle l'API d'historique Espagne qu'une fois par minute et par worker. Le throttle est explicite : `WATCHER_NOTFOUND_THROTTLE_MS = 60_000` dans `artifacts/slot-hunter/src/spain-dossier-worker.ts:2674-2681`, puis l'appel à `reportSpainWatcherScan` n'est exécuté que si 60 secondes se sont écoulées (`artifacts/slot-hunter/src/spain-dossier-worker.ts:3059-3070`). Les cycles intermédiaires ne sont donc ni retardés ni masqués par React : **aucune ligne n'est créée pour eux**.

L'hypothèse initiale centrée sur `botLog()` ne correspond pas au chemin actif de l'historique Espagne. `spain-worker-orchestrator.ts` lance `runDossierWorker()` (`artifacts/slot-hunter/src/spain-worker-orchestrator.ts:493-517`), et ce worker ne contient aucun appel à `botLog`. Il utilise le canal séparé `reportSpainWatcherScan()` → `/hunter/spain-watcher/scan-result` → `spainWatcherScans`. Dans l'onglet « Espagne », le frontend masque même la liste générique `botLogs` et rend `SpainWatcherTab` (`artifacts/joventy/src/pages/admin/BotLogs.tsx:571-576`).

Il existe toutefois deux facteurs secondaires capables de supprimer encore des lignes effectivement envoyées : (1) l'appel worker est détaché avec `void`, tandis que les erreurs sont absorbées ; (2) la mutation Spain lit puis peut modifier le singleton partagé `spainWatcher`, créant une dépendance OCC commune à tous les workers. Le code documente lui-même des erreurs OCC 422 et des pertes de télémétrie antérieures (`artifacts/joventy/convex/spainWatcher.ts:8-24`). Enfin, l'historique est plafonné globalement aux 200 scans les plus récents avant filtrage par dossier (`artifacts/joventy/convex/spainWatcher.ts:5-6,97-109`) et les lignes plus anciennes sont réellement supprimées (`artifacts/joventy/convex/spainWatcher.ts:296-307`).

**Verdict : perte au stockage, principalement par omission volontaire côté worker.** Pour les cycles `not_found` sautés par le throttle, la requête HTTP n'existe jamais ; ils ne peuvent donc pas être présents dans Convex. La pagination frontend (20 lignes/page) n'explique pas des lignes absentes du compteur, mais la fenêtre globale de 200 lignes peut masquer puis supprimer rapidement les lignes d'un dossier dans une flotte active.

## 1. Chemins exacts des logs

### 1.1 Chemin générique `botLog` (ce n'est pas le chemin des cycles Spain actifs)

1. **Émission worker.** `botLog(payload)` construit `${CONVEX_SITE_URL}/hunter/log`, lance un `fetch` POST puis ne conserve que `.catch(...)`; la réponse HTTP n'est ni attendue ni inspectée (`artifacts/slot-hunter/src/convexClient.ts:426-447`).
2. **Route HTTP Convex.** `/hunter/log` valide la clé et les trois champs, ignore silencieusement les IDs `system`/courts, puis appelle `internal.botLogs.add` (`artifacts/joventy/convex/http.ts:942-987`). Toute exception devient HTTP 422 (`artifacts/joventy/convex/http.ts:990-997`).
3. **Mutation.** `internal.botLogs.add` effectue directement `ctx.db.insert("botLogs", ...)` (`artifacts/joventy/convex/botLogs.ts:6-21`).
4. **Table.** `botLogs` contient une ligne par événement, indexée par `applicationId` et `ts` (`artifacts/joventy/convex/schema.ts:334-343`).
5. **Frontend global.** La route `/admin/bot-logs` monte `AdminBotLogs` (`artifacts/joventy/src/App.tsx:275-277`). Le composant appelle `api.botLogs.listPaginated` avec 500 éléments initiaux (`artifacts/joventy/src/pages/admin/BotLogs.tsx:342-350`); la requête Convex utilise `.paginate(...)`, puis applique les filtres de statut/step à la page (`artifacts/joventy/convex/botLogs.ts:73-105`).
6. **Frontend dossier.** La page active est `pages/admin/application-detail/index.tsx`, importée dans `App.tsx:62` et routée à `App.tsx:248-250`. Elle appelle `api.botLogs.listByApplication` (`artifacts/joventy/src/pages/admin/application-detail/index.tsx:41-50`), qui prend les 1 000 dernières lignes (`artifacts/joventy/convex/botLogs.ts:23-35`), puis les transmet à `BotLogTimeline` (`artifacts/joventy/src/pages/admin/application-detail/index.tsx:353-355`). Le composant masque seulement les doublons `login` et les filtres choisis par l'admin (`artifacts/joventy/src/pages/admin/application-detail/BotLogTimeline.tsx:29-43`); la déduplication ne concerne que `step === "login"` dans une fenêtre de 5 s (`artifacts/joventy/src/lib/bot-log-labels.ts:972-1003`).

### 1.2 Chemin réellement utilisé par les cycles Spain

1. **Orchestration.** `startSpainWorkerOrchestrator` lance un `runDossierWorker` par dossier actif (`artifacts/slot-hunter/src/spain-worker-orchestrator.ts:493-517`).
2. **Logs Railway de chaque cycle.** La boucle incrémente `cycleCount` à chaque passage (`artifacts/slot-hunter/src/spain-dossier-worker.ts:2694-2697`) et écrit notamment :
   - l'en-tête `Cycle N` (`:2747-2750`),
   - le statut de scan (`:2771`),
   - « aucun créneau » pour un `not_found` (`:3040-3042`),
   - puis le réveil/front de grille (`:4065-4075`).
   Ces messages console ne sont pas automatiquement répliqués dans Convex.
3. **Émission Convex.** Pour un `not_found`, le worker appelle `reportSpainWatcherScan` uniquement sous la garde 60 s (`artifacts/slot-hunter/src/spain-dossier-worker.ts:3059-3070`). Pour un résultat `found`, il envoie une ligne sans ce throttle après filtrage des créneaux éligibles (`artifacts/slot-hunter/src/spain-dossier-worker.ts:3175-3190`). Les deux appels sont détachés avec `void ... .catch(() => {})`.
4. **Client HTTP.** `reportSpainWatcherScan` POSTe vers `/hunter/spain-watcher/scan-result` au moyen de `fetchWithRetry` (`artifacts/slot-hunter/src/convexClient.ts:930-957`). `fetchWithRetry` tente trois fois les erreurs réseau et les statuts 429/500/502/503/504, mais pas 422 (`artifacts/slot-hunter/src/convexClient.ts:144-176`). La fonction absorbe ensuite toute erreur après un `console.warn`.
5. **Route HTTP Convex.** `/hunter/spain-watcher/scan-result` valide `status`, puis appelle `internal.spainWatcher.internalRecordScan` (`artifacts/joventy/convex/http.ts:1170-1213`). Toute exception est transformée en HTTP 422 (`:1218-1225`).
6. **Mutation/table.** `internalRecordScan` insère une ligne dans `spainWatcherScans` (`artifacts/joventy/convex/spainWatcher.ts:223-259`). Le schéma est défini et indexé par `ts` et `applicationId` dans `artifacts/joventy/convex/schema.ts:465-484`.
7. **Requête frontend Espagne.** `SpainWatcherTab` appelle `api.spainWatcher.getWatcherPaginated` avec `pageSize: 20`, et les éventuels filtres statut/dossier (`artifacts/joventy/src/pages/admin/BotLogs.tsx:1438-1452`). La requête prend d'abord les 200 lignes globales les plus récentes, filtre ensuite, puis découpe la page (`artifacts/joventy/convex/spainWatcher.ts:77-130`). Le composant rend directement `data.scans` (`artifacts/joventy/src/pages/admin/BotLogs.tsx:1455-1460,1577-1635`).

## 2. Cause principale : échantillonnage client à 60 secondes

Le code contient exactement la politique qui transforme plusieurs cycles Railway en une seule ligne Convex :

```ts
// artifacts/slot-hunter/src/spain-dossier-worker.ts:2674-2681
// Throttle client du report `not_found` à Convex...
const WATCHER_NOTFOUND_THROTTLE_MS = 60_000;
let lastNotFoundReportAtMs = 0;
```

```ts
// artifacts/slot-hunter/src/spain-dossier-worker.ts:3059-3070
const nowReport = Date.now();
if (nowReport - lastNotFoundReportAtMs >= WATCHER_NOTFOUND_THROTTLE_MS) {
  lastNotFoundReportAtMs = nowReport;
  void reportSpainWatcherScan({
    status: "not_found",
    applicationId: config.applicationId,
    dossierName: config.applicantName,
    scanTrace: JSON.stringify(workerTrace),
  }).catch(() => {});
}
```

Tous les `not_found` intermédiaires sortent du bloc sans appel réseau. `lastNotFoundReportAtMs` est en outre avancé **avant** de savoir si l'envoi a réussi : un envoi perdu interdit tout nouveau rapport pendant 60 s.

La cadence active est la grille, pas l'ancienne fonction adaptative. `getAdaptiveScanInterval` n'a aucun appel et est donc du code mort (`spain-dossier-worker.ts:280-293`). La grille charge par défaut un tick de chasse de 6 s et un tick tardif de 60 s (`artifacts/slot-hunter/src/spain/spain-grid-config.ts:42-55,103-119`); `effectiveTickMs` utilise 6 s sauf en phase tardive sans slot déjà vu (`artifacts/slot-hunter/src/spain/spain-wallclock-grid.ts:145-155`). En phase de chasse, environ un `not_found` sur dix seulement peut donc produire une ligne Convex. Le rapport observé « 15 cycles Railway, 6 lignes frontend » dépend de la durée réelle, des phases, du nombre de workers et d'éventuels `found`, mais le mécanisme qui rend les deux comptes différents est déterministe.

**Nombre d'émissions par cycle actif :**

- `botLog(...)` : **0** dans `spain-dossier-worker.ts` et **0** dans `spain-worker-orchestrator.ts`.
- `reportSpainWatcherScan(...)` : **0 ou 1** par cycle normal.
  - `not_found` : 1 seulement si le dernier rapport date d'au moins 60 s, sinon 0.
  - `found` avec `scan.slots.length > 0` : 1, avec statut final `found` ou `not_found` si tous les slots sont hors fenêtre.
  - plusieurs branches d'erreur/récupération quittent ou recommencent le cycle sans ligne `spainWatcherScans`.
- `sendHeartbeat(...)` : un appel après le chemin normal (`spain-dossier-worker.ts:4010-4016`), mais il patche `applications.hunterConfig`; il n'alimente ni `botLogs` ni `spainWatcherScans` (`artifacts/joventy/convex/http.ts:535-575`, `artifacts/joventy/convex/hunter.ts:532-577`).

## 3. Déduplication, throttling et skips aux couches Convex

### `/hunter/log` générique

Il n'y a ni déduplication, ni sampling, ni limite de fréquence dans la mutation `botLogs.add`; chaque appel accepté fait un insert indépendant (`artifacts/joventy/convex/botLogs.ts:6-21`). La seule suppression conditionnelle à l'ingestion est celle des IDs non applicatifs :

```ts
// artifacts/joventy/convex/http.ts:967-975
if (!appId || appId === "system" || appId.length < 10) {
  return new Response(JSON.stringify({ ok: true, skipped: "invalid_application_id" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
```

Cette route n'est toutefois pas appelée par la boucle Spain active.

### `/hunter/spain-watcher/scan-result`

La route n'a aucune déduplication ni condition de skip (`artifacts/joventy/convex/http.ts:1170-1225`). `internalRecordScan` insère la ligne d'historique de manière inconditionnelle avant son traitement du singleton (`artifacts/joventy/convex/spainWatcher.ts:237-259`). Le throttle Convex de 5 s ne saute explicitement que le **patch du singleton**, pas l'insert historique (`artifacts/joventy/convex/spainWatcher.ts:261-278`). Le sampling qui explique les cycles absents se trouve donc en amont, dans le worker, à 60 s.

## 4. Concurrence et risque OCC secondaire

### `botLogs.add`

Aucun document partagé n'est lu, patché ou complété par read-modify-write. Chaque mutation insère seulement un nouveau document (`artifacts/joventy/convex/botLogs.ts:14-20`). Il n'y a donc pas de conflit OCC logique sur une ligne commune dans ce chemin.

Le client générique reste peu fiable : `botLog` est totalement fire-and-forget, ne vérifie jamais `res.ok`, n'utilise pas `fetchWithRetry` et ne séquence rien (`artifacts/slot-hunter/src/convexClient.ts:426-447`). Les rejets HTTP 4xx/5xx ne déclenchent pas le `.catch`, car `fetch` résout normalement sa Promise même sur une réponse d'erreur. Ils sont donc silencieux côté worker.

### `spainWatcherScans/internalRecordScan`

Le scan est inséré comme document unique, mais la même transaction commence par lire le singleton partagé `spainWatcher` (`artifacts/joventy/convex/spainWatcher.ts:237-243`) et peut le patcher (`:265-295`). Puisque les mutations Convex sont transactionnelles, l'insert n'est pas un commit isolé : si la transaction échoue définitivement après un conflit sur le singleton, la ligne de scan n'est pas conservée.

Le commentaire source confirme l'historique du problème :

```ts
// artifacts/joventy/convex/spainWatcher.ts:12-17
// internalRecordScan à chaque cycle et patchait le MÊME document singleton
// ... conflits OCC (« Documents ... changed while this mutation was being run »)
// que Convex ne peut pas résoudre par retry → erreurs 422 + perte de télémétrie.
```

Le patch est maintenant limité à une fois toutes les 5 s selon la valeur `watcher.updatedAt`, ce qui réduit les conflits (`spainWatcher.ts:24,265-278`). Mais tous les appels lisent encore le singleton, et des workers synchronisés peuvent tous décider `shouldPatchTelemetry === true` à partir de la même version. Convex peut réessayer automatiquement la mutation, mais si elle échoue finalement, la route convertit l'erreur en 422 (`http.ts:1218-1225`). Or `fetchWithRetry` ne retente pas 422 (`convexClient.ts:144-176`) et `reportSpainWatcherScan` absorbe l'échec (`convexClient.ts:952-957`). Cela constitue un second mécanisme plausible de perte au stockage pendant les bursts multi-workers.

## 5. Limites et filtres frontend

### Onglet Espagne

Il n'existe **aucune whitelist de noms `step`** pour l'onglet Espagne : ses objets n'ont pas de champ `step`, seulement un `status` (`found`, `not_found`, `error`). Les seuls filtres sont ceux choisis dans l'UI (`statusFilter` et `applicationId`) à `BotLogs.tsx:1439-1451`, appliqués par la requête à `spainWatcher.ts:103-109`.

Les limites sont en revanche importantes :

```ts
// artifacts/joventy/convex/spainWatcher.ts:5-6,97-109
const MAX_SCANS = 200;
const allScans = await ctx.db
  .query("spainWatcherScans")
  .withIndex("by_ts")
  .order("desc")
  .take(MAX_SCANS);
// filtres appliqués seulement après le take(200)
```

- L'UI montre 20 lignes par page (`BotLogs.tsx:1445-1451`) mais expose `totalPages`; ce découpage n'est pas une perte si l'utilisateur navigue entre les pages.
- Le « total » n'est que le total des 200 dernières lignes globales, pas le total stocké (`spainWatcher.ts:97-130`).
- Le filtre dossier intervient après la limite globale de 200. Dans une flotte de nombreux workers, une ligne du dossier peut encore exister mais être hors de cette fenêtre de requête : c'est alors une perte d'affichage.
- Lorsqu'un patch télémétrique a lieu, la mutation supprime réellement les scans au-delà des 200 plus récents (`spainWatcher.ts:296-307`) : cela devient une perte de stockage par politique de rétention.

### Logs génériques

`listPaginated` utilise une vraie pagination mais filtre chaque page après pagination (`artifacts/joventy/convex/botLogs.ts:73-105`). Un filtre peut donc produire une page clairsemée même si des correspondances existent plus loin. Cela n'affecte pas l'onglet Espagne, qui a sa propre requête. Dans le détail dossier, `listByApplication.take(1000)` impose un plafond (`botLogs.ts:23-35`) et `BotLogTimeline` masque seulement les doublons de login et les filtres administrateur (`BotLogTimeline.tsx:29-43`).

## 6. STORAGE ou DISPLAY ?

### Verdict pour les cycles Spain manquants : STORAGE (avant ingestion)

Le code permet de conclure sans dashboard pour le mécanisme principal : chaque cycle est imprimé dans Railway, mais les `not_found` ne franchissant pas la garde 60 s ne déclenchent jamais `reportSpainWatcherScan`. Aucune ligne n'est donc écrite dans `spainWatcherScans`. Ce n'est pas une whitelist frontend et ce n'est pas la pagination 20/page.

### Vérification production recommandée pour quantifier les causes secondaires

Pour une fenêtre et un dossier précis :

1. Dans Railway, relever le nombre et les timestamps des lignes `🔍 Cycle N` pour le dossier.
2. Dans Convex Data, interroger `spainWatcherScans` sur le même `applicationId` et le même intervalle `ts`; les lignes normales devraient être espacées d'environ 60 s malgré les cycles Railway espacés d'environ 6 s.
3. Dans les logs de fonctions Convex, chercher sur le même intervalle `spain-watcher/scan-result error`, `Documents ... changed while this mutation was being run`, et les réponses 422/500.
4. Dans Railway, chercher `[convexClient] reportSpainWatcherScan failed:` et `[convexClient] reportSpainWatcherScan error:`. Une réponse 422 prouve une perte supplémentaire après émission.
5. Vérifier si plus de 200 scans tous dossiers confondus ont été produits depuis les lignes recherchées. Si oui, le plafond/prune global peut expliquer l'absence de lignes plus anciennes.

Sans numéro de cycle envoyé, il est impossible de distinguer a posteriori un cycle volontairement échantillonné d'un POST perdu. C'est précisément pourquoi un `cycleNumber`/`windowId` est nécessaire.

## 7. Correctifs recommandés, classés par impact

1. **Conserver tous les cycles sans recréer la contention : remplacer le sampling 60 s par un buffer/batch.** Accumuler chaque résultat de cycle avec `cycleNumber`, `windowId`, `dossierId`, timestamps début/fin et trace, puis envoyer périodiquement un batch attendu. Une mutation dédiée doit insérer toutes les lignes sans lire ni patcher le singleton. Cela restaure le rapport 1 cycle Railway = 1 enregistrement Convex avec beaucoup moins de requêtes HTTP.
2. **Séparer totalement l'historique du singleton.** Faire de la mutation d'historique un chemin insert-only sur `spainWatcherScans`; mettre à jour `spainWatcher` dans une autre mutation agrégée/throttlée. Ainsi, un conflit OCC de télémétrie ne peut jamais annuler l'insert d'historique.
3. **Rendre la livraison fiable et observable.** Remplacer les appels `void` par une file asynchrone bornée, avec flush avant la fin du worker, timeout, backoff et métriques `queued/sent/retried/failed`. Ne pas avancer le timestamp de throttle avant succès. Pour le canal générique, faire évoluer `botLog` de la même façon, car il ignore actuellement toutes les réponses HTTP non-2xx.
4. **Ajouter idempotence et séquence.** Envoyer un identifiant stable `${windowId}:${applicationId}:${cycleNumber}` et créer un index correspondant pour permettre les retries sans doublon. Le frontend pourra afficher explicitement les trous de séquence plutôt que donner l'impression d'un historique complet.
5. **Corriger la sémantique d'erreur HTTP.** Ne pas transformer tous les échecs mutationnels en 422. Réserver 422 aux payloads invalides; retourner un statut transitoire 503/409 approprié pour les conflits épuisés afin que le client les retente. Journaliser le dossier, le `windowId` et le numéro de cycle sans données sensibles.
6. **Corriger la requête/rétention Spain.** Paginer par curseur sur `spainWatcherScans`, utiliser l'index `by_application` lorsque le filtre dossier est actif, et appliquer les filtres dans la requête plutôt qu'après un `take(200)` global. Remplacer le prune global à 200 par une rétention explicite (âge ou quota par dossier) et afficher dans l'UI si l'historique est tronqué.
7. **Clarifier l'interface.** Tant que le sampling reste en place, renommer « Historique scans » en « Échantillons de scans (max. 1/min/worker) » et afficher `reportedCycles / executedCycles`; sinon l'UI promet implicitement une exhaustivité que le backend ne reçoit pas.

## Conclusion

Le décalage 15 cycles Railway contre 6 entrées frontend n'est pas principalement une perte mystérieuse dans React ou une déduplication Convex. La boucle active journalise tous les cycles localement mais **échantillonne volontairement les `not_found` à 60 secondes avant tout POST**. Les entrées omises ne peuvent donc jamais apparaître. La conception actuelle ajoute ensuite deux risques : transaction Spain couplée à un singleton OCC partagé et historique global plafonné/pruné à 200 lignes. Le correctif robuste consiste à envoyer tous les cycles par batch idempotent vers une mutation insert-only, puis à maintenir le singleton et la rétention dans des chemins séparés.
