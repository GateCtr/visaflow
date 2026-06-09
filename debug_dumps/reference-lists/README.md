# VOWINT Reference Lists — Captured 2026-06-09

Compte: `screentapinc@gmail.com` · VAC: 1 (Belgium Brussels)  
Dossier test créé: **`VOWINT6142288`** (VACoreId `0a3b39bb-bd63-f111-a3ae-00505691de06`) — **à supprimer manuellement sur VOWINT**

Auth: ASP.NET form login → `OSOnline` cookie (capture avec `redirect:'manual'` sur le POST).  
**AppId = GUID string** (ex: `0a3b39bb-...`), injecté via `app.value("AppId", '...')` dans la page Edit.

---

## ✅ Capturé — prêt pour AI mapping

### Endpoints Common/ directs

| Fichier | Items | Description |
|---------|-------|-------------|
| `countries.json` | 243 | Pays — `{Value, Text}` · ex: `{58, "CONGO (Rep Dem)"}` |
| `nationalities.json` | 249 | Nationalités — `{Value, Text}` |
| `sex-types.json` | 3 | Male(1), Female(2), Unidentified(3) |
| `visa-status-types.json` | 3 | Imported(5), To be verified(6), Decision ready(10) |
| `purpose-of-travel-by-visa-type.json` | vt 1–3 | `{Value, Text, Description}` par visaTypeId |
| `purpose-of-travel-by-category-and-visa.json` | 52 motifs | Matrice categoryId × visaTypeId |
| `categories-by-visa-type.json` | vt 1–3 | Leisure(1) · Academic(2) · Family(3) · Humanitarian(4) · Business(5) · Return(6) · Transit(7) |
| `vac-currencies.json` | 30 VAC | vacId → `[{Value, Text}]` · VAC Kinshasa=CDF, Europe=EUR |
| `vac-currency-default.json` | 30 VAC | Devise par défaut par VAC |
| `nationality-payment-exceptions.json` | 1 | Cap-Vert (121) — exception paiement |
| `country-id-by-iso2.json` | 30 ISO2 | ISO2 → `{Value, Text}` · DRC, EU, Afrique, Amériques |
| `exemptions-by-visa-type.json` | vt 1–3 | Exemptions empreintes — `{Exemptions: [{Value, Text, ExemptionReasonRequired, CanBeManuallySelected, Age}]}` |

### Listes complètes depuis `getVisaApplication.Lists`

Capturées via `/common/getVisaApplication?AppId={GUID}` (dossier test VOWINT6142288).

| Fichier | Items | Description |
|---------|-------|-------------|
| `lists-actortypes.json` | 7 | Types d'acteur (demandeur, parent, employeur…) |
| `lists-actorsubtypes.json` | 10 | Sous-types d'acteur |
| `lists-relationshiptypes.json` | 2 | Types de relation |
| `lists-eufamilymemberrelationshiptypes.json` | 6 | Relation membre famille UE |
| `lists-familymemberrelationshiptypes.json` | 19 | Relation membre famille (général) |
| `lists-countrytypes.json` | 244 | Pays avec contexte VAC |
| `lists-nationalityeutypes.json` | 32 | Nationalités UE |
| `lists-nationalitynoneutypes.json` | 219 | Nationalités non-UE |
| `lists-nationalitytypes.json` | 250 | Toutes nationalités |
| `lists-nationalitytypesothernationality.json` | 249 | Autre nationalité |
| `lists-countryschengentypes.json` | 30 | Pays Schengen |
| `lists-countrynonschengentypes.json` | 215 | Pays non-Schengen |
| `lists-sextypes.json` | 3 | Sexe |
| `lists-maintransportationtypes.json` | 5 | Mode de transport principal |
| `lists-civilstatetypes.json` | 7 | État civil |
| `lists-traveldocumenttypes.json` | 17 | Types de document de voyage (1=Passport ordinaire, 4=Diplomatique…) |
| `lists-purposeoftraveltypes.json` | 53 | Motifs de voyage |
| `lists-purposeoftravelcategorytypes.json` | 7 | Catégories de voyage |
| `lists-numberofentrytypes.json` | 3 | Nombre d'entrées: One(1), Two(2), Multiple(3) |
| `lists-occupationtypes.json` | 28 | Professions (Farmer, Teacher, Civil servant…) |
| `lists-visatypes.json` | 2 | Types de visa: A=Airport transit(1), C=Short Stay(2) |
| `lists-vaclist.json` | 1 | VAC actif: Belgium Brussels (VacId=1) |
| `lists-gratuitytypes.json` | 16 | Exemptions frais: None(1), Diplomatic(2), Indigence(3), GrantHolder(5), FamilyEU(7)… |
| `lists-fingerprintexemptiontypes.json` | 15 | Exemptions empreintes |
| `lists-languagefordossiertypes.json` | 4 | Langues dossier: EN/FR/NL/DE |
| `lists-travellergroupquestion.json` | 3 | Type de voyage: Alone / Group / Family |
| `lists-vactypes.json` | 142 | Tous les VAC dans le monde |
| `lists-countryschengenvacs.json` | 322 | Pays Schengen × VAC |
| `lists-printlanguage.json` | 3 | Langues impression |
| `lists-vaccountries.json` | 79 | VAC par pays |
| `lists-companylist.json` | 5 | Entreprises associées au compte |

### Données brutes dossier

| Fichier | Description |
|---------|-------------|
| `visa-application-full.json` | Réponse complète `getVisaApplication` — 13 clés: VA, Lists, rights, ownApplication, etc. |

---

## IDs clés (contexte Belgique Schengen)

| Entité | Value | Notes |
|--------|-------|-------|
| DRC nationalityId | **116** | Nationalité congolaise |
| DRC countryId | **58** | Pays d'émission document RDC |
| Belgium countryId | **32** | Destination Schengen / memberStateOfDestinationId |
| Belgium nationalityId | **90** | — |
| France countryId | **86** | — |
| USA countryId | **242** | — |
| visaTypeId=1 | A | Airport transit (1 motif) |
| visaTypeId=2 | C | Court séjour (31 motifs) |
| visaTypeId=3 | D | Long séjour (38 motifs) |
| VAC Belgium Brussels | **1** | VacId=1 · Devise EUR |
| GratuityId=1 | None | Requérant standard (payant) |
| Passport ordinaire | docTypeId=**1** | Ordinary passport |
| Entrée multiple | nbEntries=**3** | Multiple |

---

## Exemptions empreintes (`exemptions-by-visa-type.json`)

| visaType | Nb | Exemptions clés |
|----------|----|-----------------|
| 1 (A) | 4 | Heads of State, Royalty, Physically impossible (temp/perm), Children <12 |
| 2 (C) | 4 | idem |
| 3 (D) | 5 | + Diplomatic/consular staff coming to posting |

Champs: `Value`, `Text`, `ExemptionReasonRequired` (bool), `CanBeManuallySelected` (bool), `Age` (null ou nombre)

---

## Visa Types (visaTypeId 1/2/3)

- **1** — A: Airport transit
- **2** — C: Short Stay (Schengen 90j/180j)
- **3** — D: Long Stay (visa national — long séjour)

> ⚠️ `lists-visatypes.json` ne contient que A(1) et C(2) — le D long séjour est hors périmètre du formulaire standard VOWINT (géré séparément).

---

## Catégories de voyage

| Value | Text |
|-------|------|
| 1 | Leisure |
| 2 | Academic travel |
| 3 | Family travel |
| 4 | Humanitarian displacement |
| 5 | Business travel |
| 6 | Return |
| 7 | Transit |

---

## ⚠️ Non capturé

| Endpoint | Raison | Alternative |
|----------|--------|-------------|
| `GetApplicationFee` | Retourne `null` pour dossier vierge — nécessite VisaTypeId + NationalityId enregistrés dans le VA | Standard Schengen = **80 EUR** (réglementation UE fixe) |
| `GetPurposeOfTravelByCategory` | Endpoint désactivé/déprécié | Utiliser `purpose-of-travel-by-category-and-visa.json` |
| `/VisaApplication/MyList` | POST DataTables 500 — nécessite session avec dossiers actifs | N/A pour mapping |

---

## Notes techniques

- **AppId = GUID** (ex: `0a3b39bb-bd63-f111-a3ae-00505691de06`), pas un entier. Injecté par `app.value("AppId", '...')` dans le HTML de la page Edit.
- **GDPR hCaptcha sitekey**: `1a9c5211-bf1a-4897-a16b-3060d469fb5d` — Anti-Captcha résout `HCaptchaTaskProxyless` en ~20s
- **CapSolver** ne supporte ni la sitekey CEV (`5f64399c...`) ni la sitekey GDPR VOWINT (`1a9c5211...`) — utiliser Anti-Captcha uniquement
- **Session cookie**: `OSOnline` capturé avec `redirect:'manual'` sur le POST login — `redirect:'follow'` perd les Set-Cookie intermédiaires
- **Endpoints sans préfixe langue**: `/Common/GetXxx` s'appellent sans `/en/`
- **getVisaApplication** retourne 29 listes en une seule requête — endpoint prioritaire pour bootstrapper toutes les données de référence
