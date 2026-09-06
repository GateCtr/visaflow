import { CRENEAUX_PAGES } from "@/data/creneaux-seo";
import { CreneauxLanding } from "./CreneauxLanding";

const data = CRENEAUX_PAGES.find((p) => p.slug === "creneaux-visa-belgique-long-sejour-kinshasa")!;

export default function CreneauxBelgiqueLongSejour() {
  return <CreneauxLanding data={data} />;
}