# VOWINT Reference Lists — Captured 2026-06-09

Fetched via authenticated HTTP (script `fetch-reference-lists.ts`).
Auth method: ASP.NET form login → `OSOnline` session cookie.

## ✅ Captured (ready for AI mapping)

| File | Items | Description |
|------|-------|-------------|
| `countries.json` | 243 | All country types — `{Value, Text}`, e.g. `{Value:"58", Text:"CONGO (Rep Dem)"}` |
| `nationalities.json` | 249 | All nationality types — `{Value, Text}`, e.g. `{Value:"116", Text:"CONGO (Rep Dem)"}` |
| `sex-types.json` | 3 | Male(1), Female(2), Unidentified(3) |
| `visa-status-types.json` | 3 | Imported(5), To be verified(6), Decision ready(10) |
| `purpose-of-travel-by-visa-type.json` | visaTypeIds 1–3 | Full `{Value, Text, Description}` per visaTypeId |
| `purpose-of-travel-by-category-and-visa.json` | 52 unique purposes | Combined categoryId×visaTypeId matrix |
| `categories-by-visa-type.json` | visaTypeIds 1–3 | Travel categories: Leisure(1), Academic(2), Family(3), Humanitarian(4), Business(5), Return(6), Transit(7) |
| `vac-currencies.json` | 30 VAC IDs | vacId → `[{Value, Text}]` e.g. vacId=3 → EUR, vacId=3 (Kinshasa) → CDF |
| `vac-currency-default.json` | 30 VAC IDs | Default single currency per VAC |
| `country-id-by-iso2.json` | 30 ISO2 codes | ISO2 → `{Value, Text}` mapping for DRC/EU/Africa/Americas |
| `nationality-payment-exceptions.json` | 1 entry | Cape Verde (121) has payment exception |

## ⚠️ Pending (need real appId from running application)

| File | Reason |
|------|--------|
| `exemptions-by-visa-type.json` | `GetExemptionsByVisaType` requires valid `appId` (AngularJS loads it dynamically) |
| `application-fee-sample.json` | `GetApplicationFee` returns null — needs `appId` from active dossier |
| `purpose-of-travel-by-category.json` | `GetPurposeOfTravelByCategory` returns empty — likely superseded by ByCategoryAndVisa |

## Key IDs (Belgium Schengen context)

| Entity | Value |
|--------|-------|
| Belgium countryId | 32 |
| Belgium nationalityId | 90 |
| DRC (Congo) countryId | 58 |
| DRC nationalityId | 116 |
| France countryId | 86 | 
| USA countryId | 242 |
| visaTypeId=1 | Transit (1 purpose) |
| visaTypeId=2 | Short-stay C (31 purposes) |
| visaTypeId=3 | Long-stay D (38 purposes) |

## Visa Types Confirmed (from purpose-of-travel data)

- **visaTypeId=1** — Transit (Airport, International, Sail/Sea)
- **visaTypeId=2** — Short-stay C Schengen visa (tourism, business, family visit, etc.)
- **visaTypeId=3** — Long-stay D visa (family reunification, work, study, etc.)

## Travel Categories (visaTypeId=2 and 3)

| Value | Text |
|-------|------|
| 1 | Leisure |
| 2 | Academic travel |
| 3 | Family travel |
| 4 | Humanitarian displacement |
| 5 | Business travel |
| 6 | Return |
| 7 | Transit |

## VAC Currencies by Region

| vacId | Currency | Likely location |
|-------|----------|-----------------|
| 3 | CDF | Kinshasa |
| 4 | TND | Tunisia |
| 5 | XOF | West Africa (FCFA) |
| 1, 2, 6+ | EUR | Europe/Belgian embassies |
