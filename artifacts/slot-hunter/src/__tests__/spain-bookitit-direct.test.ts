import { describe, expect, it } from "vitest";
import {
  callDirect,
  parseDirectJsonp,
  type DynamicSession,
} from "../spain-bookitit-direct.js";
import { parseSetCookies } from "../spain-cookie-parser.js";

function jsonp(payload: unknown): string {
  return `jQuery123(${JSON.stringify(payload)});`;
}

describe("callDirect — propagation PHPSESSID", () => {
  it("préserve les virgules dans PHPSESSID et sépare les cookies joints", () => {
    const parsed = parseSetCookies(
      "PHPSESSID=Gn0w,I8x,part-3; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/, " +
      "cf_clearance=\"clear,ance\"; Path=/; HttpOnly\n" +
      "foo=bar; Path=/",
    );

    expect(parsed).toEqual({
      PHPSESSID: "Gn0w,I8x,part-3",
      cf_clearance: "\"clear,ance\"",
      foo: "bar",
    });
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
});