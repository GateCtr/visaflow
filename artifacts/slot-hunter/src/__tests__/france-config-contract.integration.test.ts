import { describe, expect, it } from "vitest";

import type { HunterJob } from "../convexClient.js";
import { mapJobToFranceConfig } from "../france/france-hunter.js";

const FRANCE_CONSULATE_SLUG = "ambassade-de-france-a-kinshasa";
const FRANCE_SERVICES = [
  {
    id: "6346e242c47b29722d5f5f4e",
    name: "ADF - Demande d'inscription au Registre, de CNI/ passeport/déclaration de vol ou perte de documents",
    motifKey: "ce05f27d741e0918",
    motifs: ["Passeport "],
  },
  {
    id: "6346e242c47b29722d5f5f50",
    name: "ADF - Dépôt des Légalisations",
    motifKey: "",
    motifs: [],
  },
  {
    id: "6346e242c47b29722d5f5f51",
    name: "Etat civil",
    motifKey: "0d70a0061c16b9a4",
    motifs: ["Acte de naissance "],
  },
  {
    id: "6346e242c47b29722d5f5f52",
    name: "Visas",
    motifKey: "fc24d7ef7972e5cb",
    motifs: ["Conjoint de Français - Installation "],
  },
] as const;

const CONTACT = {
  franceContactFirstname: "Marie Claire",
  franceContactLastname: "Test Hunter",
  franceContactEmail: "france-contract-test@example.invalid",
  franceContactMobile: "+243000000000",
  franceBirthMonth: 1,
  franceBirthDay: 29,
  franceBirthYear: 1992,
  franceAutoBook: false,
  franceScanIntervalMs: 45_000,
} as const;

function makeSerializedJob(
  service: (typeof FRANCE_SERVICES)[number],
  motif: string,
): HunterJob {
  const hunterConfig = {
    embassyUsername: "N/A",
    embassyPassword: "N/A",
    isActive: true,
    franceConsulateSlug: FRANCE_CONSULATE_SLUG,
    franceServiceId: service.id,
    franceServiceName: service.name,
    franceMotifKey: service.motifKey,
    franceMotif: motif,
    ...CONTACT,
  };

  const endpointPayload = {
    id: `france-contract-${service.id}`,
    destination: "france",
    visaType: "test_non_client",
    applicantName: "Fixture France non client",
    travelDate: "2027-01-01",
    urgencyTier: "standard",
    slotBookingRefs: null,
    hunterConfig,
    broadcastVisaClass: null,
    portalUrl: null,
    portalName: null,
    portalDashboardUrl: null,
    portalAppointmentUrl: null,
    portalScheduleUrl: null,
    lastCheckAt: null,
    spainOtpConfig: null,
  } satisfies HunterJob;

  return JSON.parse(JSON.stringify(endpointPayload)) as HunterJob;
}

describe("contrat admin France → /hunter/jobs → Slot Hunter", () => {
  it.each(FRANCE_SERVICES)(
    "conserve exactement la configuration du service $name",
    (service) => {
      const motif = service.motifs[0] ?? "";
      const job = makeSerializedJob(service, motif);
      const config = mapJobToFranceConfig(job);

      expect(config).not.toBeNull();
      expect(config).toEqual({
        consulateSlug: FRANCE_CONSULATE_SLUG,
        service: {
          serviceId: service.id,
          serviceName: service.name,
        },
        contact: {
          firstname: CONTACT.franceContactFirstname,
          lastname: CONTACT.franceContactLastname,
          email: CONTACT.franceContactEmail,
          mobile: CONTACT.franceContactMobile,
          birthdate: {
            month: CONTACT.franceBirthMonth,
            day: CONTACT.franceBirthDay,
            year: CONTACT.franceBirthYear,
          },
        },
        motifKey: service.motifKey,
        motif,
        autoBook: false,
        scanIntervalMs: CONTACT.franceScanIntervalMs,
      });
    },
  );

  it("préserve les espaces significatifs du motif après sérialisation", () => {
    const service = FRANCE_SERVICES[0];
    const motif = service.motifs[0];

    expect(motif.endsWith(" ")).toBe(true);
    expect(mapJobToFranceConfig(makeSerializedJob(service, motif))?.motif).toBe(motif);
  });

  it("accepte Légalisations sans motif", () => {
    const service = FRANCE_SERVICES.find((entry) => entry.motifs.length === 0);

    expect(service).toBeDefined();
    expect(mapJobToFranceConfig(makeSerializedJob(service!, ""))).toMatchObject({
      motifKey: "",
      motif: "",
      autoBook: false,
    });
  });
});