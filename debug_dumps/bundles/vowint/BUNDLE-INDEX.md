# VOWINT Bundle Index
> Téléchargés depuis `https://visaonweb.diplomatie.be`
> Date: 2026-06-09  
> Source: HAR Playwright (session authentifiée) — capture complète 70 bundles

---

## Bundles page Create/Edit — NOUVEAUX (capturés 2026-06-09)

Ces bundles sont chargés uniquement sur la page `/en/VisaApplication/Edit/{VACoreId}` (= page formulaire de création).

| Fichier | Taille | Rôle |
|---|---|---|
| `visaApplicationController.js.js` | **131KB** | **Controller principal formulaire** — form, validation, API calls, RDV |
| `codeTypeService.js.js` | **12KB** | **Service 16 endpoints /Common/*** — country, nationality, sex, fee, etc. |
| `ngAutoComplete.js.js` | 14KB | Autocomplétion adresse (Google Maps API) |
| `icheck.min.js.js` | 4KB | Checkboxes stylisées (iCheck lib) |
| `autocompleteController.js.js` | 4KB | Controller complément adresse Maps |
| `references.js.js` | 4KB | Directives AngularJS `<referenceperson>`, `<referenceorganisation>` |
| `gdprController.js.js` | 5KB | Flux GDPR (Approval, CreateGdprNewWithAutoNumber) |
| `uiErrorService.js.js` | 2KB | Service affichage erreurs formulaire inline |
| `visaApplicationForm.js.js` | 1KB | Helper formulaire (init, reset) |
| `referenceController.js.js` | 1KB | Controller références (sponsors, tuteurs légaux) |
| `guardian.js.js` | <1KB | Directive `<guardian>` tuteur légal |
| `addressService.js.js` | <1KB | Service adresse Google Maps |
| `scrollSpyRefList.js.js` | 1KB | ScrollSpy pour la liste de références |
| `clearDropdownvalue.js.js` | 1KB | Helper reset valeurs dropdown |
| `blue.css.js` | 2KB | Thème iCheck blue |
| `select2.png.js` | 4KB | Sprite Select2 |

---

## Bundles page IndexByUserId (liste des dossiers)

| Fichier | Taille | Rôle |
|---|---|---|
| `visaApplicationController-gdJF3W7a.bin` | 204KB | Controller IndexByUserId (DataTables + MyList) |
| `dataTables.bootstrap.css.js` | 7KB | CSS DataTables Bootstrap |
| `sort_both.png.js` | 1KB | Icône tri DataTables |
| `sort_desc.png.js` | 1KB | Icône tri desc |
| `glyphicons-halflings-regular.woff.js` | 23KB | Font glyphicons |

---

## Bundles layout authentifié (toutes pages post-login)

| Fichier | Taille | Rôle |
|---|---|---|
| `bundles-angularjs.js` | 217KB | Framework AngularJS + plugins |
| `Scripts-js.js` | 305KB | jQuery 1.x + Bootstrap 3 + utilitaires |
| `Content-css.css` | 311KB | CSS principal app authentifiée |
| `AngularJs-app.js` | 9KB | Module definition + config $http headers |
| `AngularJs-Services-mask.js` | 34KB | Masques de saisie (ui-mask) |
| `AngularJs-Services-accentRemoveService.js` | 9KB | Normalisation accents recherche |
| `Scripts-ng-multi-select-angular-multi-select.js` | 47KB | Multi-select nationalités |
| `Scripts-ng-table-ng-table.js` | 29KB | Tables paginées (ng-table) |
| `Scripts-angular-resource.js` | 26KB | $resource AngularJS |
| `Scripts-flot-jquery.flot.js` | 107KB | Graphes Flot |
| `angular-flot.js.js` | 1KB | Directive angular-flot |
| `AngularJs-Controllers-commonController.js` | 2KB | Controller commun (navigation) |
| `AngularJs-Controllers-changePasswordController.js` | 2KB | Controller changement mot de passe |
| `AngularJs-Services-messageService.js` | 1KB | Service messages UI |
| `AngularJs-Directives-loadingContainer.js` | 1KB | Directive loading spinner |
| `initApp.js.js` | 0KB | Init app AngularJS |

---

## Bundles page de login (publics — sans auth)

| Fichier | Taille | Rôle |
|---|---|---|
| `minimalcss.css` | 246KB | CSS page de login |
| `fonts.css` | 28KB | Google Fonts |
| `minimaljs.js` | 111KB | jQuery minimal + Bootstrap pour login |
| `jqueryval.js` | 200KB | jQuery validation |
| `bootstrapcore.js` | 73KB | Bootstrap core JS |
| `css-J7VZwISN.css` | 28KB | CSS commun |

---

## Bundles CSS composants

| Fichier | Taille | Rôle |
|---|---|---|
| `Scripts-CleanZone-bootstrap.datetimepicker-css-bootstrap-datetimepicker.css` | 12KB | Date picker |
| `Scripts-CleanZone-bootstrap.daterangepicker-daterangepicker-bs3.css` | 5KB | Date range picker |
| `Scripts-CleanZone-jquery.datatables-bootstrap-dataTables.bootstrap.css` | 7KB | DataTables |
| `Scripts-ng-multi-select-angular-multi-select.css` | 6KB | Multi-select |
| `Scripts-ng-table-ng-table.css` | 3KB | ng-table |
| `Fonts-flaticon-flaticon.css` | 1KB | Icônes Flaticon |
| `angular-multi-select.css.js` | 6KB | CSS multi-select (doublon) |

---

## Endpoints API confirmés (extraits des bundles)

### `/Common/*` — Données de référence (codeTypeService.js)

| Endpoint | Paramètres | Rôle |
|---|---|---|
| `GET /Common/GetAllCountryTypes` | — | Tous les pays `[{Value, Text}]` |
| `GET /Common/GetAllNationalityTypes` | — | Toutes les nationalités |
| `GET /Common/GetAllSexTypes` | — | Genres (M/F/X) |
| `GET /Common/GetAllVisaStatusTypes` | — | Statuts de visa |
| `GET /Common/GetCountryIdByIso2` | `iso2` | Pays par code ISO2 |
| `GET /Common/GetNationalityPaymentExceptionByNationalityId` | `nationalityId` | Exception paiement |
| `GET /Common/GetPurposeOfTravelTypesByVisaType` | `visaTypeId, dateOfApplication` | Motifs de voyage |
| `GET /Common/GetPurposeOfTravelCategoryByVisaTypeId` | `visaTypeId, dateOfApplication` | Catégories motifs |
| `GET /Common/GetPurposeOfTravelCategoryByPurposeOfTravelId` | `purposeOfTravelId, visaTypeId, dateOfApplication` | Catégorie d'un motif |
| `GET /Common/GetPurposeOfTravelByCategory` | `categoryId` | Motifs par catégorie |
| `GET /Common/GetPurposeOfTravelByCategoryAndVisa` | `categoryId, visaTypeId, dateOfApplication` | Motifs par catégorie + visa |
| `GET /Common/GetExemptionsByVisaType` | `visaType, birthDate, dateOfApplication, appId, memberStateOfDestinationId` | Exemptions |
| `GET /Common/GetApplicationFee` | `gratuityId, visaTypeId, nationalityId, issuingCountryId, documentTypeId, dateOfApplication, dateOfBirth, memberOfDestinationId` | Frais de visa |
| `GET /Common/GetVacCurrencies` | `vacId` | Devises disponibles au VAC |
| `GET /Common/GetVacCurrency` | `vacId` | Devise principale |
| `GET /Common/GetNewGuidAsync` | — | Nouveau GUID serveur |

### `/VisaApplication/*` — Gestion des dossiers (visaApplicationController.js)

| Endpoint | Méthode | Rôle |
|---|---|---|
| `GET /VisaApplication/DataTables` | GET | Config i18n DataTables |
| `GET /VisaApplication/MyList` | GET+params | Liste dossiers (DataTables) |
| `POST /VisaApplication/CreateRdv` | POST `{Id}` | **Créer un RDV** → déclenche flux CEV |
| `POST /VisaApplication/ManageRdv` | POST | Gérer RDV existant |
| `POST /VisaApplication/ManageRdvTakeDoc` | POST | RDV + prise de documents |
| `GET /Common/GetEAppointmentUrl` | GET `?id={AppId}` | **URL d'intégration CEV** → `{url: "https://appointment.cloud.diplomatie.be/Integration/VOW/..."}` |
| `GET /Common/GetBiometricsFromBioMod` | GET | Données biométriques |
| `POST /ReceiveDocument/SaveDecisionReady` | POST | Document décision visas |
| `POST /RetrieveDocument/SaveRetrieveDocument` | POST | Document restitution |

---

## Flux de création d'application (découvert 2026-06-09)

```
GET  /en/VisaApplication/Gdpr
  → gdprController.js (5KB) + hCaptcha (sitekey: 5f64399c-14a8-415e-ad1a-7ebccdc4943a)
  → Sélect type visa: 1=Court séjour ≤90j, 2=Long séjour >90j

POST /en/VisaApplication/CreateGdprNewWithAutoNumber
  Content-Type: application/x-www-form-urlencoded
  body: Approval=1&RecaptchaResponse={hcaptcha_token}
  → 200 { Success: true, VACoreId: "{uuid}" }   ← ID Convex/AppId
       { Success: false, ErrorMessage: "Invalid captcha challenge" }  ← captcha invalide

GET  /en/VisaApplication/Edit/{VACoreId}
  → Page formulaire réelle (80 champs, 16 endpoints /Common/*)
```

---

## Commande de capture

```bash
VOWINT_EMAIL=screentapinc@gmail.com VOWINT_PASSWORD=xxx \
  pnpm --filter @workspace/slot-hunter exec tsx src/debug/vowint-bundle-sniffer.ts
```
