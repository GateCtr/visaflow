import { CRENEAUX_PAGES } from "@/data/creneaux-seo";
import { CreneauxLanding } from "./CreneauxLanding";

const data = CRENEAUX_PAGES.find((p) => p.slug === "creneaux-visa-allemagne-kinshasa")!;

export default function CreneauxAllemagne() {
  return <CreneauxLanding data={data} />;
}
