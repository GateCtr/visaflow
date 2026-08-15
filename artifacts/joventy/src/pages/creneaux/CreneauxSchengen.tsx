import { CRENEAUX_PAGES } from "@/data/creneaux-seo";
import { CreneauxLanding } from "./CreneauxLanding";

const data = CRENEAUX_PAGES.find((p) => p.slug === "creneaux-visa-schengen-belgique-kinshasa")!;

export default function CreneauxSchengen() {
  return <CreneauxLanding data={data} />;
}
