// tls-proxy-go — Serveur HTTP local qui exécute des requêtes avec l'empreinte TLS
// EXACTE de Chrome (JA3/JA4 + HTTP2 fingerprint) via bogdanfinn/tls-client.
//
// But : rejouer un cf_clearance obtenu par CapSolver avec un TLS indiscernable d'un
// vrai Chrome — ce que impit (plafonné à chrome142, JA3 approximatif) ne fait pas.
//
// Endpoint POST /fetch  (JSON) :
//   { "url": "...", "proxy": "http://user:pass@host:port", "cookie": "a=b; c=d",
//     "userAgent": "...", "profile": "chrome_131" }
// Réponse JSON : { "status": 200, "body": "...", "setCookie": ["..."], "cfRay": "..." }
package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"

	tlsclient "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	fhttp "github.com/bogdanfinn/fhttp"
)

type fetchReq struct {
	URL       string `json:"url"`
	Proxy     string `json:"proxy"`
	Cookie    string `json:"cookie"`
	UserAgent string `json:"userAgent"`
	Profile   string `json:"profile"`
	Method    string `json:"method"`
}

type fetchResp struct {
	Status    int      `json:"status"`
	Body      string   `json:"body"`
	SetCookie []string `json:"setCookie"`
	CfRay     string   `json:"cfRay"`
	Error     string   `json:"error,omitempty"`
}

var chromeVerRe = regexp.MustCompile(`Chrome/(\d+)`)

func profileByName(name string) profiles.ClientProfile {
	switch name {
	case "chrome_124":
		return profiles.Chrome_124
	case "chrome_131":
		return profiles.Chrome_131
	case "chrome_133":
		return profiles.Chrome_133
	case "chrome_144":
		return profiles.Chrome_144
	case "chrome_146":
		return profiles.Chrome_146
	case "chrome_150":
		return profiles.Chrome_150
	case "chrome_152":
		return profiles.Chrome_152
	default:
		return profiles.Chrome_152
	}
}

func writeErr(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(fetchResp{Error: msg})
}

func handleFetch(w http.ResponseWriter, r *http.Request) {
	var req fetchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, "bad json: "+err.Error())
		return
	}
	if req.URL == "" {
		writeErr(w, "url required")
		return
	}

	opts := []tlsclient.HttpClientOption{
		tlsclient.WithTimeoutSeconds(60),
		tlsclient.WithClientProfile(profileByName(req.Profile)),
		tlsclient.WithNotFollowRedirects(),
	}
	if req.Proxy != "" {
		opts = append(opts, tlsclient.WithProxyUrl(req.Proxy))
	}
	client, err := tlsclient.NewHttpClient(tlsclient.NewNoopLogger(), opts...)
	if err != nil {
		writeErr(w, "client init: "+err.Error())
		return
	}

	method := req.Method
	if method == "" {
		method = "GET"
	}
	hreq, err := fhttp.NewRequest(method, req.URL, nil)
	if err != nil {
		writeErr(w, "req build: "+err.Error())
		return
	}

	ua := req.UserAgent
	if ua == "" {
		ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
	}
	// Déduire la version majeure de Chrome depuis l'UA pour aligner sec-ch-ua (sinon
	// décalage UA/CH = tell de fingerprint pour Cloudflare).
	chromeVer := "151"
	if m := chromeVerRe.FindStringSubmatch(ua); len(m) == 2 {
		chromeVer = m[1]
	}
	secChUa := `"Chromium";v="` + chromeVer + `", "Not(A:Brand";v="24", "Google Chrome";v="` + chromeVer + `"`
	// Headers d'un vrai Chrome, dans l'ordre réaliste (fhttp préserve l'ordre via header-order)
	hreq.Header = fhttp.Header{
		"sec-ch-ua":                 {secChUa},
		"sec-ch-ua-mobile":          {"?0"},
		"sec-ch-ua-platform":        {`"Windows"`},
		"upgrade-insecure-requests": {"1"},
		"user-agent":                {ua},
		"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
		"sec-fetch-site":            {"none"},
		"sec-fetch-mode":            {"navigate"},
		"sec-fetch-user":            {"?1"},
		"sec-fetch-dest":            {"document"},
		"accept-encoding":           {"gzip, deflate, br, zstd"},
		"accept-language":           {"es-ES,es;q=0.9,en;q=0.8"},
		fhttp.HeaderOrderKey: {
			"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests",
			"user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user",
			"sec-fetch-dest", "accept-encoding", "accept-language", "cookie",
		},
	}
	if req.Cookie != "" {
		hreq.Header.Set("cookie", req.Cookie)
	}

	resp, err := client.Do(hreq)
	if err != nil {
		writeErr(w, "do: "+err.Error())
		return
	}
	defer resp.Body.Close()
	bodyBytes, _ := io.ReadAll(resp.Body)

	out := fetchResp{
		Status:    resp.StatusCode,
		Body:      string(bodyBytes),
		SetCookie: resp.Header["Set-Cookie"],
		CfRay:     resp.Header.Get("cf-ray"),
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
	log.Printf("[fetch] %s %s proxy=%v → %d (%dB) ck=%d cf-ray=%s",
		method, trunc(req.URL, 60), req.Proxy != "", out.Status, len(out.Body), len(out.SetCookie), out.CfRay)
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func main() {
	port := os.Getenv("TLS_PROXY_PORT")
	if port == "" {
		port = "8787"
	}
	http.HandleFunc("/fetch", handleFetch)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	addr := "127.0.0.1:" + strings.TrimPrefix(port, ":")
	log.Printf("tls-proxy-go écoute sur http://%s (profils: chrome_124/131/133)", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
