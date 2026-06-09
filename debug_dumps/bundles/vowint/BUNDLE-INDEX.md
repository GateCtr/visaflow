# VOWINT Bundle Index
> Téléchargés depuis `https://visaonweb.diplomatie.be`
> Date: 2026-06-09  
> Source: HAR Playwright (session authentifiée 2026-06-08T17:14:59) + téléchargement direct

---

## Bundles critiques

| Fichier | Taille | Rôle | Accessible sans auth |
|---|---|---|---|
| `bundles-visaApplicationController.js` | 204KB | **Controller principal** — form, validation, API | ❌ Auth requise |
| `bundles-angularjs.js` | 216KB | Framework AngularJS + plugins | ❌ Auth requise |
| `Scripts-js.js` | 305KB | jQuery 1.x + Bootstrap 3 + utilitaires | ❌ Auth requise |
| `Content-css.css` | 311KB | CSS principal app authentifiée | ❌ Auth requise |
| `AngularJs-app.js` | 9KB | Module definition + config $http | ✅ Public |

## Bundles page de login (publics)

| Fichier | Taille | Rôle |
|---|---|---|
| `minimalcss.css` | 246KB | CSS page de login uniquement |
| `fonts.css` | 28KB | Google Fonts |
| `minimaljs.js` | 110KB | jQuery minimal + Bootstrap pour login |
| `jqueryval.js` | 200KB | jQuery validation |
| `bootstrapcore.js` | 73KB | Bootstrap core JS |

## Bundles AngularJS (publics — statiques)

| Fichier | Taille | Rôle |
|---|---|---|
| `AngularJs-Controllers-commonController.js` | 2KB | Controller commun |
| `AngularJs-Controllers-changePasswordController.js` | 2KB | Controller changement mot de passe |
| `AngularJs-Services-messageService.js` | 1KB | Service messages UI |
| `AngularJs-Directives-loadingContainer.js` | 1KB | Directive loading |
| `AngularJs-Services-accentRemoveService.js` | 9KB | Suppression accents (normalisation) |
| `AngularJs-Services-mask.js` | 34KB | Masques de saisie (ui-mask) |
| `Scripts-ng-multi-select-angular-multi-select.js` | 47KB | Sélection multiple (nationalités) |
| `Scripts-ng-table-ng-table.js` | 29KB | Tables paginées |
| `Scripts-angular-resource.js` | 26KB | $resource AngularJS |
| `Scripts-flot-jquery.flot.js` | 110KB | Graphes Flot |

## Bundles CSS composants

| Fichier | Taille | Rôle |
|---|---|---|
| `Scripts-CleanZone-bootstrap.datetimepicker-css-bootstrap-datetimepicker.css` | 12KB | Date picker |
| `Scripts-CleanZone-bootstrap.daterangepicker-daterangepicker-bs3.css` | 4KB | Date range picker |
| `Scripts-CleanZone-jquery.datatables-bootstrap-dataTables.bootstrap.css` | 7KB | DataTables |
| `Scripts-ng-multi-select-angular-multi-select.css` | 6KB | Multi-select |
| `Scripts-ng-table-ng-table.css` | 3KB | ng-table |
| `Fonts-flaticon-flaticon.css` | 1KB | Icônes Flaticon |

---

## Bundles manquants (à capturer)

Ces bundles sont probablement chargés sur la page de **création** d'application (non encore capturée) :

| Bundle attendu | Raison |
|---|---|
| `/VisaApplication/Create` HTML | Page formulaire création |
| Controller création (si séparé) | Possible `visaApplicationCreateController.js` |
| Templates partials (`/AngularJs/Templates/Person`, `/Guardian`, etc.) | Partials pour sections formulaire |
| `/Common/GetAllNationalityTypes` response | IDs nationalités |
| `/Common/GetAllVisaStatusTypes` + types de visa | IDs types visa |
| POST `/VisaApplication/Save` body | Payload de soumission finale |

## Comment capturer les bundles manquants

```bash
# Lancer le sniffer interactif (browser visible)
pnpm --filter @workspace/slot-hunter exec tsx src/debug/vowint-bundle-sniffer.ts

# Ou en mode auto si VOWINT_EMAIL + VOWINT_PASSWORD sont définis :
VOWINT_EMAIL=screentapinc@gmail.com VOWINT_PASSWORD=xxx \
  pnpm --filter @workspace/slot-hunter exec tsx src/debug/vowint-bundle-sniffer.ts
```

Le sniffer sauvegarde automatiquement dans ce dossier quand la page de création est détectée.
