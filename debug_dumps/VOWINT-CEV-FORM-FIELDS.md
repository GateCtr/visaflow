# VOWINT — Champs du formulaire de dossier CEV
> Extrait par rétro-ingénierie du bundle `visaApplicationController.js` (204KB)
> Source: `https://visaonweb.diplomatie.be`
> Capturé: 2026-06-08 via HAR Playwright  
> Analysé: 2026-06-09

---

## Architecture applicative

| Couche | Technologie | Détail |
|--------|------------|--------|
| Framework | AngularJS 1.x | Module `osOnline` |
| UI | Bootstrap 3 + CleanZone theme | |
| Tables | ng-table | DataTables-style |
| Sélecteurs | ui-select (Select2) | Dropdowns enrichis |
| Dates | bootstrap-datetimepicker | |
| Multi-select | angular-multi-select | Nationalités multiples |
| Masques | ui.mask | Formats passport, dates |
| Upload | blueimp.fileupload | Documents scannés |
| Graphes | angular-flot | |
| Internationalisation | Côté serveur (URLs `/en/`, `/fr/`, `/nl/`) | |

### Modules chargés (app.js)
```
ngTable, ngResource, blueimp.fileupload, multi-select,
angular-flot, ui.select, ngSanitize, ui.bootstrap, ui.mask
```

### Headers HTTP injectés globalement (app.js)
```
X-Requested-With: XMLHttpRequest   ← tous les appels AngularJS $http
If-Modified-Since: 0               ← anti-cache IE
```

---

## Modèle de données — `n.VA` (VisaApplication object)

Le formulaire manipule un objet `VA` (VisaApplication) sur `$scope`. Tous les champs sont envoyés/reçus dans cet objet.

### Groupe `Personal_Data` — Données personnelles du demandeur

| Champ `VA.*` | Type | Description |
|---|---|---|
| `Personal_Data_FirstName` | string | Prénom |
| `Personal_Data_LastName` | string | Nom de famille |
| `Personal_Data_BirthDate` | date (DD/MM/YYYY) | Date de naissance |
| `Personal_Data_GenderId` | int | Sexe (cf. `/Common/GetAllSexTypes`) |
| `Personal_Data_NationalityId` | int | Nationalité principale (cf. `/Common/GetAllNationalityTypes`) |
| `Personal_Data_Other_Nationalities` | array | Autres nationalités |
| `Personal_Data_Email` | string | Email du demandeur |
| `Personal_Data_OccupationId` | int | Profession |
| `Personal_Data_Sponsor` | string | Sponsor/garant |
| `Personal_Data_ExtendedMinor` | bool | Mineur étendu (tutelle) |
| `Personal_Data_Address` | object | Adresse (partial `../Address`) |

### Groupe `TravelDocument` — Document de voyage

| Champ `VA.*` | Type | Description |
|---|---|---|
| `TravelDocument_DocumentTypeId` | int | Type de document (passeport, titre séjour…) |
| `TravelDocument_DocumentNumber` | string | Numéro du document |
| `TravelDocument_DateOfIssue` | date | Date d'émission |
| `TravelDocument_ValidUntil` | date | Date d'expiration |
| `TravelDocument_IssuingAuthorityCountryId` | int | Pays émetteur (cf. `/Common/GetAllCountryTypes`) |

### Groupe `Application` — Paramètres de la demande de visa

| Champ `VA.*` | Type | Description |
|---|---|---|
| `Application_VisaTypeRequestedId` | int | **Type de visa demandé** — champ central |
| `Application_PurposeOfTravelCategoryId` | int | Catégorie du motif de voyage |
| `Application_PurposeOfTravelId` | int | Motif précis (cf. `/Common/GetPurposeOfTravelByCategoryAndVisa`) |
| `Application_MemberStateOfDestinationId` | int | État membre Schengen de destination |
| `Application_IntendedDateOfArrival` | date | Date d'arrivée prévue |
| `Application_IntendedDateOfDeparture` | date | Date de départ prévue |
| `Application_DurationOfIntendedStay` | int | Durée du séjour (jours) |
| `Application_NumberOfEntriesRequestedId` | int | Nombre d'entrées (1, 2, multiple) |
| `Application_FingerprintExemptionId` | int | Exemption biométrique |
| `Application_FingerprintExemptionReason_Mandatory` | bool | Raison exemption obligatoire |
| `Application_FreeMovement` | bool | Libre circulation UE |
| `Application_GratuityId` | int | Gratuité (enfant < 6 ans, etc.) — IDs 9 et 16 = mineurs |
| `Application_Fee` | decimal | Frais de visa |
| `Application_Currency` | string | Devise |
| `Application_CurrencyCode` | string | Code devise |
| `Application_Rate` | decimal | Taux de change |
| `Application_Comment` | string | Commentaire interne |

### Groupe `MRZ` — Zone de lecture machine (passeport)

| Champ `VA.*` | Type | Description |
|---|---|---|
| `Mrz_LastName` | string | Nom (depuis MRZ) |
| `Mrz_FirstName` | string | Prénom (depuis MRZ) |
| `Mrz_BirthDate` | date | Date de naissance MRZ |
| `Mrz_GenderId` | int | Genre MRZ |
| `Mrz_NationalityId` | int | Nationalité MRZ |
| `Mrz_IssuingAuthorityCountryId` | int | Pays émetteur MRZ |
| `Mrz_DocumentNumber` | string | Numéro document MRZ |
| `Mrz_ValidUntil` | date | Expiration MRZ |

### Groupe `CSS` — Validation croisée CSS/MRZ

Champs de comparaison entre données saisies manuellement et MRZ pour détection d'incohérences.

| Champ | Usage |
|---|---|
| `Css_FirstName`, `Css_LastName` | Comparaison MRZ vs saisi |
| `Css_BirthDate` | Comparaison date |
| `Css_Gender`, `Css_Nationality` | Comparaison |
| `Css_DocumentNumber`, `Css_ValidUntil` | Comparaison |
| `Css_IssuingAuthorityCountry` | Comparaison pays |

### Groupe `PreviousSchengenVisa` — Visas Schengen précédents

| Champ `VA.*` | Type | Description |
|---|---|---|
| `PreviousSchengenVisa_VisaNumber` | string | Numéro visa précédent |
| `PreviousSchengenVisa_DateOfIssue` | date | Date d'émission |
| `PreviousSchengenVisa_ValidUntil` | date | Date d'expiration |
| `PreviousSchengenVisa_DeliveredByCountryId` | int | Pays émetteur du visa précédent |

### Groupe `PermitFor` — Titre de séjour (si applicable)

| Champ `VA.*` | Type | Description |
|---|---|---|
| `PermitForDestinationCountry_PermitValidFrom` | date | Validité début (pays de destination) |
| `PermitForDestinationCountry_PermitValidUntil` | date | Validité fin |
| `PermitForResidenceCountry_PermitValidUntil` | date | Validité fin (pays de résidence) |
| `PermitForDestinationRequired` | bool | Requis pour destination |
| `PermitForResidenceRequired` | bool | Requis pour résidence |

### Groupe `Guardian` — Tuteur légal (mineurs)

| Champ `VA.*` | Type | Description |
|---|---|---|
| `Guardian_Parent1` | object | Tuteur 1 (partial `../Guardian`) |
| `Guardian_Parent2` | object | Tuteur 2 |
| `ShowParent2` | bool | Afficher tuteur 2 |

### Groupe `Biométrie`

| Champ `VA.*` | Type | Description |
|---|---|---|
| `HasFingerprints` | bool | Empreintes déjà enregistrées |
| `PreviousFingerPrint` | bool | Empreintes dans système précédent |
| `PreviousFingerprint_CaptureDate` | date | Date capture précédente |
| `PreviousFingerprint_VisaNumber` | string | Visa référence |

### Champs système / workflow

| Champ `VA.*` | Type | Description |
|---|---|---|
| `AppId` | GUID | ID de l'application (Convex: `applicationId`) |
| `VOWId` | string | Référence VOWINT (ex: `VOWINT6115499`) |
| `VacId` | string | ID dans système VAC |
| `OSId` | string | ID OutSystems (ex: `MSHKIN006115499`) |
| `StatusId` | int | Statut actuel |
| `SubGroupId` | GUID | ID sous-groupe RDV |
| `GroupId` | string | ID groupe (ou "NA") |
| `CompanyPrefix` | string | Préfixe opérateur (ex: "MSH", "BEL") |
| `DateOfApplication` | date | Date de soumission |
| `EUFamilyMember` | bool | Membre famille UE |
| `OSUniqueId` | string | ID unique OutSystems |
| `GdprApproval` | bool | Consentement RGPD |
| `AppointmentTaken` | bool | RDV pris |

---

## Endpoints API (visaApplicationController.js)

### Données de référence (listes dropdown)

| Méthode | Endpoint | Retour |
|---------|----------|--------|
| GET | `/Common/GetAllCountryTypes` | `[{Value, Text}]` — liste des pays |
| GET | `/Common/GetAllNationalityTypes` | `[{Value, Text}]` — nationalités |
| GET | `/Common/GetAllSexTypes` | `[{Value, Text}]` — sexes |
| GET | `/Common/GetAllVisaStatusTypes` | `[{Value, Text}]` — statuts |
| GET | `/Common/GetApplicationFee` | Frais de visa |
| GET | `/Common/GetExemptionsByVisaType` | Exemptions par type visa |
| GET | `/Common/GetPurposeOfTravelByCategory` | Motifs par catégorie |
| GET | `/Common/GetPurposeOfTravelByCategoryAndVisa` | Motifs par catégorie + type visa |
| GET | `/Common/GetPurposeOfTravelCategoryByVisaTypeId` | Catégories par type visa |
| GET | `/Common/GetPurposeOfTravelTypesByVisaType` | Types motifs par visa |
| GET | `/Common/GetNationalityPaymentExceptionByNationalityId` | Exceptions paiement |
| GET | `/Common/GetVacCurrencies` | Devises VAC |
| GET | `/Common/GetVacCurrency` | Devise courante |
| GET | `/Common/GetBiometricsFromBioMod` | Données biométriques |
| GET | `/Common/GetCountryIdByIso2` | Pays par code ISO2 |
| GET | `/Common/GetNewGuidAsync` | Nouveau GUID |
| GET | `/Common/GetOsUniqueId` | ID unique OutSystems |
| GET | `/Common/getSchoolAsync` | Recherche établissement scolaire |

### Gestion des applications

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/VisaApplication/DataTables` | Config DataTables (traductions) |
| GET | `/VisaApplication/MyList` | Liste des dossiers de l'utilisateur connecté |
| GET | `/VisaApplication/ListOfApplications` | Liste complète |
| POST | `/VisaApplication/CreateRdv` | **Créer un RDV** — payload: `{Id: AppId}` |
| POST | `/VisaApplication/ManageRdv` | Gérer RDV existant |
| POST | `/VisaApplication/ManageRdvTakeDoc` | RDV + prise de documents |
| GET | `/common/getVisaApplication` | Détails complet d'un dossier |
| GET | `/common/GetJsonGroupBySubGroupId` | Groupe par sous-groupe |
| GET | `/common/ListOfApplicationByGroupId` | Applications par groupe |
| GET | `/common/AddApplicationToAppointmentSystem` | Ajouter au système RDV |
| GET | `/Common/GetEAppointmentUrl` | **URL CEV** — `?id={AppId}` → `{url: "https://appointment.cloud.diplomatie.be/Integration/VOW/..."}` |

### Documents

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/ReceiveDocument/Save` | Sauvegarder document |
| POST | `/ReceiveDocument/SaveDecisionReady` | Document décision |
| POST | `/ReceiveDocument/Scan` | Scan biométrique |
| GET | `/common/GetListOfDocumentByVacoreId` | Liste documents |
| GET | `/VisaApplication/GetEncryptedJsonByVacoreId` | JSON chiffré dossier |

---

## Structure de réponse — `/VisaApplication/MyList`

```json
{
  "draw": 1,
  "data": [{
    "Id":        "d9c54635-715e-f111-a3ae-00505691de06",  // AppId → GetEAppointmentUrl
    "VOWId":     "VOWINT6115499",                          // Référence formulaire
    "OSId":      "MSHKIN006115499",                        // Référence OutSystems
    "AppNum":    null,                                     // Numéro dossier (après soumission)
    "FName":     "ONYEME",
    "LName":     "RACHEL",
    "St":        "Submitted",                              // Statut texte
    "StId":      2,                                        // Statut ID
    "Hb":        false,                                    // Has biometrics
    "Vac":       "CEV Kinshasa",                          // Centre visa
    "GroupId":   "NA",                                     // Groupe RDV ("NA" = aucun)
    "SubGroupId": "7df28958-...",                          // Sous-groupe RDV
    "EAppointmentReady": true,                             // RDV électronique possible
    "EappointmentUrl":   "ExistEappointmentUrl",          // "ExistEappointmentUrl" ou URL
    "ShowAppointementSystemOutsourcerUrl": true,
    "AppointementSystemOutsourcerUrl": "cloud",           // "cloud" = appointment.cloud.diplomatie.be
    "CompanyPrefix": "MSH"                                 // Opérateur
  }]
}
```

---

## Flux CEV — Point d'entrée depuis VOWINT

```
GET /Common/GetEAppointmentUrl?id={AppId}
  → { "url": "https://appointment.cloud.diplomatie.be/Integration/VOW/{orgId}/{appId}/{sessionGuid}/{tokenGuid}/en-US" }

GET {integrationUrl}
  → 302 → /Captcha  (ASP.NET_SessionId assigné)

GET /Captcha → 200 (page hCaptcha)
  [résolution hCaptcha via Anti-Captcha]

POST /Captcha/SetCaptchaToken
  body: captcha={token}
  → 200 { captchaSolved: true, validUntil: "...", redirectUrl: "/Integration/VOW/..." }

GET {redirectUrl}
  → 302 → /Integration/VOW/SelectSlot     (créneaux disponibles)
  → 302 → /Integration/Error/NoAvailability (pas de créneaux)
```

---

## Templates partiels AngularJS

Ces partials sont chargés dynamiquement selon le type de demandeur :

| Template | Usage |
|---|---|
| `../Address` | Bloc adresse complète |
| `../Person` | Informations personnelles complètes |
| `../MinimalPerson` | Infos minimales (sponsor, tuteur) |
| `../Organisation` | Données entreprise/organisation |
| `../MinimalOrganisation` | Organisation simplifiée |
| `../Guardian` | Tuteur légal (mineur) |

---

## Statuts de visa (GetAllVisaStatusTypes)

| Value | Text |
|---|---|
| 5 | Imported |
| 6 | To be verified |
| 10 | Decision ready |

---

## Bundles capturés

| Fichier | Taille | Rôle |
|---|---|---|
| `bundles-visaApplicationController.js` | 204KB | **Controller principal** — form, validation, API calls |
| `bundles-angularjs.js` | 216KB | Framework AngularJS + plugins |
| `Scripts-js.js` | 305KB | jQuery + Bootstrap + utilitaires |
| `Content-css.css` | 311KB | CSS principal app authentifiée |
| `AngularJs-app.js` | 9KB | Module definition + routes + config |
| `AngularJs-Services-mask.js` | 34KB | Masques de saisie (ui.mask) |
| `AngularJs-Services-accentRemoveService.js` | 9KB | Normalisation accents |
| `Scripts-ng-multi-select-angular-multi-select.js` | 47KB | Multi-select nationalités |
| `Scripts-flot-jquery.flot.js` | 107KB | Graphes |
| `Scripts-ng-table-ng-table.js` | 29KB | Tables paginées |
