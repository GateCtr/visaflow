import { CRENEAUX_PAGES } from "@/data/creneaux-seo";
import { CreneauxLanding } from "./CreneauxLanding";

const data = CRENEAUX_PAGES.find((p) => p.slug === "creneaux-visa-france-long-sejour-kinshasa")!;

export default function CreneauxFranceLongSejour() {
  return <CreneauxLanding data={data} />;
}