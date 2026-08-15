import test from "node:test";
import assert from "node:assert/strict";
import {
  stripAccents,
  inferQuestionFocus,
  buildQuestionFocusBlock,
} from "../artifacts/joventy/convex/victorIntent.js";

test("stripAccents removes diacritics", () => {
  assert.equal(stripAccents("rendez-vous immédiat"), "rendez-vous immediat");
});

test("detects appointment price as appointment-focused", () => {
  assert.equal(inferQuestionFocus("Combien coûte un rendez-vous ?"), "appointment_price");
  assert.match(
    buildQuestionFocusBlock("Combien coûte un rendez-vous ?"),
    /rendez-vous concerné/i
  );
});

test("detects document and timeline questions precisely", () => {
  assert.equal(inferQuestionFocus("Quel document dois-je fournir ?"), "document");
  assert.equal(inferQuestionFocus("Quel est le délai pour le visa ?"), "timeline");
});

test("detects fine-grained mixed questions", () => {
  assert.equal(inferQuestionFocus("Combien coûte un document ?"), "document_price");
  assert.equal(inferQuestionFocus("Quel est le délai pour un rendez-vous ?"), "appointment_timeline");
});

test("detects payment timing questions", () => {
  assert.equal(
    inferQuestionFocus("Le paiement se fait avant ou après ?"),
    "payment_terms"
  );
  assert.match(
    buildQuestionFocusBlock("Le paiement se fait avant ou après ?"),
    /moment du paiement/i
  );
});

test("detects rendez-vous payment timing questions", () => {
  assert.equal(
    inferQuestionFocus("Combien de temps avant le rendez-vous faut-il payer ?"),
    "appointment_payment_terms"
  );
  assert.match(
    buildQuestionFocusBlock("Combien de temps avant le rendez-vous faut-il payer ?"),
    /paiement lié au rendez-vous/i
  );
});

test("detects payment structure questions", () => {
  assert.equal(
    inferQuestionFocus("Le paiement est partiel ou total ?"),
    "payment_structure"
  );
  assert.match(
    buildQuestionFocusBlock("Le paiement est partiel ou total ?"),
    /structure du paiement/i
  );
});

test("detects destination-scoped appointment pricing", () => {
  assert.equal(
    inferQuestionFocus("Combien coûte un rendez-vous Schengen ?"),
    "appointment_price"
  );
  assert.match(
    buildQuestionFocusBlock("Combien coûte un rendez-vous Schengen ?"),
    /service de rendez-vous concerné/i
  );
});

test("detects document delay situations", () => {
  assert.equal(
    inferQuestionFocus("Quel est le délai pour un document manquant ?"),
    "document_timeline"
  );
  assert.match(
    buildQuestionFocusBlock("Quel est le délai pour un document manquant ?"),
    /délai lié à ce document/i
  );
});

test("flags vague mixed topics", () => {
  assert.equal(
    inferQuestionFocus("Je veux le prix, le délai et le document."),
    "mixed_multi"
  );
  assert.match(
    buildQuestionFocusBlock("Je veux le prix, le délai et le document."),
    /question mélange plusieurs sujets/i
  );
});

test("flags other mixed terrain examples", () => {
  assert.equal(
    inferQuestionFocus("Prix du rendez-vous, délai du document et pièce à fournir"),
    "mixed_multi"
  );
  assert.match(
    buildQuestionFocusBlock("Prix du rendez-vous, délai du document et pièce à fournir"),
    /premier sujet cité/i
  );
});

test("detects timing for payments around a rendez-vous", () => {
  assert.equal(
    inferQuestionFocus("Le paiement d'un rendez-vous se fait avant ou après ?"),
    "appointment_payment_terms"
  );
});

test("detects explicit full service only when asked", () => {
  assert.equal(inferQuestionFocus("Je veux un service complet."), "full_service");
  assert.match(
    buildQuestionFocusBlock("Je veux un service complet."),
    /prise en charge complète/i
  );
});
