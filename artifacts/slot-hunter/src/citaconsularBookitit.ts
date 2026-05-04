/**
 * Référence API Bookitit extraite du bundle `citaconsular_bundle/`.
 * L’URL de base vient de `Utils.get_server_url()` (injectée côté page hôte, souvent sous `…/onlinebookings/`).
 * Transport : JSONP (`dataType: "jsonp"` dans les collections / modèles).
 *
 * Synthèse rédigée : `Analyse Technique du Système de Rendez-vous - Citaconsular.es.md`
 */

/** Suffixes de chemin après l’URL serveur Bookitit (tels que dans le bundle). */
export const BOOKITIT_API_SUFFIX = {
  getwidgetconfigurations: "getwidgetconfigurations/",
  getservices: "getservices/",
  getagendas: "getagendas/",
  datetime: "datetime/",
  signup: "signup/",
  signupfirstappointment: "signupfirstappointment/",
  signin: "signin/",
  signedin: "signedin/",
  signinaccount: "signinaccount/",
  signoutaccount: "signoutaccount/",
  confirmclient: "confirmclient/",
  summary: "summary/",
  freetempevent: "freetempevent/",
  recoverpassword: "recoverpassword/",
  changepassword: "changepassword/",
  gethistory: "gethistory/",
  geteventhistory: "geteventhistory/",
  deleteeventhistory: "deleteeventhistory/",
  paypalcreatepayment: "paypalcreatepayment/",
  paypalexecutepayment: "paypalexecutepayment/",
  niubizcreatepayment: "niubizcreatepayment/",
  niubizexecutedpayment: "niubizexecutedpayment/",
} as const;

export type BookititApiSuffix = (typeof BOOKITIT_API_SUFFIX)[keyof typeof BOOKITIT_API_SUFFIX];

/** Jeton de session réservation côté widget (voir `app.js` après `getwidgetconfigurations`). */
export const BKT_TOKEN_CLIENT_KEY = "bktToken" as const;
