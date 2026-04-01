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
import type * as constants from "../constants.js";
import type * as documents from "../documents.js";
import type * as emails from "../emails.js";
import type * as http from "../http.js";
import type * as hunter from "../hunter.js";
import type * as messages from "../messages.js";
import type * as reviews from "../reviews.js";
import type * as slotFoundHelper from "../slotFoundHelper.js";
import type * as users from "../users.js";
import type * as visaDocuments from "../visaDocuments.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  applications: typeof applications;
  constants: typeof constants;
  documents: typeof documents;
  emails: typeof emails;
  http: typeof http;
  hunter: typeof hunter;
  messages: typeof messages;
  reviews: typeof reviews;
  slotFoundHelper: typeof slotFoundHelper;
  users: typeof users;
  visaDocuments: typeof visaDocuments;
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
