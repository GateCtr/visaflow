import { describe, expect, it } from "vitest";
import {
  callDirect,
  CALL_DIRECT_HTTP_OVERLOAD,
  parseDirectJsonp,
  type DynamicSession,
} from "../spain-bookitit-direct.js";
import {
  inspectSetCookieHeader,
  parseSetCookies,
} from "../spain-cookie-parser.js";

function jsonp(payload: unknown): string {
  return `jQuery123(${JSON.stringify(payload)});`;
}

describe("callDirect — propagation PHPSESSID", () => {
  it("préserve les virgules dans PHPSESSID et sépare les cookies joints", () => {
    const raw = (
      "PHPSESSID=Gn0w,I8x,part-3; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/, " +
      "cf_clearance=\"clear,ance\"; Path=/; HttpOnly\n" +
      "foo=bar; Path=/"
    );
    const parsed = parseSetCookies(raw);
    const diagnostic = inspectSetCookieHeader(raw);

    expect(parsed).toEqual({
      PHPSESSID: "Gn0w,I8x,part-3",
      cf_clearance: "\"clear,ance\"",
      foo: "bar",
    });
    expect(diagnostic.segmentCount).toBe(3);
    expect(diagnostic.invalidSegmentCount).toBe(0);
    expect(diagnostic.duplicateNames).toEqual([]);
    expect(diagnostic.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "PHPSESSID", length: 15, literalCommas: 2 }),
        expect.objectContaining({ name: "cf_clearance", literalCommas: 1 }),
      ]),
    );
  });

  it("accepte les formes JSONP observées sans confondre BOM et callback-prefix", () => {
    expect(parseDirectJsonp("\uFEFFcallback=jQuery123({\"ok\":true});")).toEqual({ ok: true });
    expect(parseDirectJsonp("{\"ok\":true}")).toEqual({ ok: true });
  });

  it("réutilise le PHPSESSID reçu par getsigninfields/ pour signin/", async () => {
    const seenCookies: string[] = [];
    const responses = [
      new Response(jsonp({ CustomFields: { login: {} } }), {
        status: 200,
        headers: { "set-cookie": "PHPSESSID=rotated-by-gsf; Path=/; HttpOnly" },
      }),
      new Response(jsonp({
        Client: {
          errors: [{ field: "login", message: "Usuario o contraseña incorrectos" }],
        },
      }), { status: 200 }),
    ];

    const session = {
      cfClearance: "cf",
      cfDomain: ".citaconsular.es",
      soaxProxyUrl: "http://proxy",
      userAgent: "Mozilla/5.0",
      createdAt: 0,
      expiresAt: 1,
      allCookies: [{ name: "PHPSESSID", value: "initial" }],
      extraHeaders: {},
      bookititState: {
        jqCallback: "jQuery123",
        reqCounter: 1,
        srvsrc: "https://www.citaconsular.es",
        version: "4",
        widgetUrl: "https://www.citaconsular.es/widget/",
        publickey: "publickey",
        bookititBase: "https://www.citaconsular.es/onlinebookings",
      },
    } as any;
    const ds: DynamicSession = {
      impit: {
        fetch: async (_url: string, options: { headers: Record<string, string> }) => {
          seenCookies.push(options.headers.Cookie);
          return responses.shift()!;
        },
      },
      jar: { PHPSESSID: "initial" },
      userAgent: "Mozilla/5.0",
      jqCallback: "jQuery123",
      reqCounter: 1,
      publickey: "publickey",
      version: "4",
      widgetUrl: "https://www.citaconsular.es/widget/",
      srvsrc: "https://www.citaconsular.es",
      bookititBase: "https://www.citaconsular.es/onlinebookings",
      session,
    } as any;

    const gsf = await callDirect(ds, "getsigninfields/", {
      "services[]": "service",
      "agendas[]": "agenda",
      date: "2026-10-13",
      time: "09:00",
      selectedPeople: "1",
    });
    const signin = await callDirect(ds, "signin/", {
      "services[]": "service",
      "agendas[]": "agenda",
      date: "2026-10-13",
      time: "09:00",
      selectedPeople: "1",
      logintype: "document",
      login: "fake",
      password: "fake",
      comments: "",
    });

    expect(gsf).toEqual({ CustomFields: { login: {} } });
    expect(signin).toEqual({
      Client: {
        errors: [{ field: "login", message: "Usuario o contraseña incorrectos" }],
      },
    });
    expect(seenCookies[0]).toContain("PHPSESSID=initial");
    expect(seenCookies[1]).toContain("PHPSESSID=rotated-by-gsf");
    expect(session.allCookies).toEqual(
      expect.arrayContaining([{ name: "PHPSESSID", value: "rotated-by-gsf" }]),
    );
  });

  it("rafraîchit les paramètres avant un retry HTTP 504", async () => {
    const seenUrls: string[] = [];
    const responses = [
      new Response("<html>gateway timeout</html>", {
        status: 504,
        headers: { "retry-after": "0" },
      }),
      new Response("<html>gateway timeout</html>", {
        status: 504,
        headers: { "retry-after": "0" },
      }),
      new Response(jsonp({ Access: { bktToken: "server-token" } }), { status: 200 }),
    ];
    const ds = {
      impit: {
        fetch: async (url: string) => {
          seenUrls.push(url);
          return responses.shift()!;
        },
      },
      jar: { PHPSESSID: "session" },
      userAgent: "Mozilla/5.0",
      jqCallback: "jQuery123",
      reqCounter: 1,
      publickey: "publickey",
      version: "4",
      widgetUrl: "https://www.citaconsular.es/widget/",
      srvsrc: "https://www.citaconsular.es",
      bookititBase: "https://www.citaconsular.es/onlinebookings",
    } as any as DynamicSession;

    let refreshCount = 0;
    const result = await callDirect(ds, "signin/", { gct: "old-token", login: "fake" }, undefined, {
      refreshParamsForRetry: async ({ extra }) => {
        refreshCount += 1;
        return { ...extra, gct: `fresh-token-${refreshCount}` };
      },
    });

    expect(result).toEqual({ Access: { bktToken: "server-token" } });
    expect(seenUrls).toHaveLength(3);
    expect(seenUrls[0]).toContain("gct=old-token");
    expect(seenUrls[1]).toContain("gct=fresh-token-1");
    expect(seenUrls[2]).toContain("gct=fresh-token-2");
    expect(refreshCount).toBe(2);
  });

  it("retourne le sentinel HTTP après épuisement des retries", async () => {
    const ds = {
      impit: {
        fetch: async () => new Response("<html>gateway timeout</html>", {
          status: 504,
          headers: { "retry-after": "0" },
        }),
      },
      jar: { PHPSESSID: "session" },
      userAgent: "Mozilla/5.0",
      jqCallback: "jQuery123",
      reqCounter: 1,
      publickey: "publickey",
      version: "4",
      widgetUrl: "https://www.citaconsular.es/widget/",
      srvsrc: "https://www.citaconsular.es",
      bookititBase: "https://www.citaconsular.es/onlinebookings",
    } as any as DynamicSession;

    const result = await callDirect(ds, "signin/", { gct: "token" });
    expect(result).toBe(CALL_DIRECT_HTTP_OVERLOAD);
  });
});