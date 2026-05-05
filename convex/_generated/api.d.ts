/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as applications from "../applications.js";
import type * as botLogs from "../botLogs.js";
import type * as cevSessions from "../cevSessions.js";
import type * as constants from "../constants.js";
import type * as crons from "../crons.js";
import type * as documents from "../documents.js";
import type * as emails from "../emails.js";
import type * as http from "../http.js";
import type * as hunter from "../hunter.js";
import type * as messages from "../messages.js";
import type * as notifications from "../notifications.js";
import type * as reviews from "../reviews.js";
import type * as slotFoundHelper from "../slotFoundHelper.js";
import type * as spainOtp from "../spainOtp.js";
import type * as users from "../users.js";
import type * as visaDocuments from "../visaDocuments.js";
import type * as whatsapp from "../whatsapp.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  applications: typeof applications;
  botLogs: typeof botLogs;
  cevSessions: typeof cevSessions;
  constants: typeof constants;
  crons: typeof crons;
  documents: typeof documents;
  emails: typeof emails;
  http: typeof http;
  hunter: typeof hunter;
  messages: typeof messages;
  notifications: typeof notifications;
  reviews: typeof reviews;
  slotFoundHelper: typeof slotFoundHelper;
  spainOtp: typeof spainOtp;
  users: typeof users;
  visaDocuments: typeof visaDocuments;
  whatsapp: typeof whatsapp;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
