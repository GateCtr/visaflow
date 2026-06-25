# Captures Burp Suite — Chrome 146 réel — citaconsular.es
# Date: 2026-06-25
# Source: Burp Embedded Browser (Chromium 146)

## GET /es/hosteds/widgetdefault/25028fcd.../ (page initiale)
```
Sec-Ch-Ua: "Not-A.Brand";v="24", "Chromium";v="146"
Sec-Ch-Ua-Mobile: ?0
Sec-Ch-Ua-Platform: "Windows"
Sec-Ch-Ua-Full-Version: ""
Sec-Ch-Ua-Arch: ""
Sec-Ch-Ua-Platform-Version: ""
Sec-Ch-Ua-Model: ""
Sec-Ch-Ua-Bitness: ""
Sec-Ch-Ua-Full-Version-List: (empty)
Accept-Language: fr-FR,fr;q=0.9
Upgrade-Insecure-Requests: 1
User-Agent: Chrome/146.0.0.0
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7
Sec-Fetch-Site: none
Sec-Fetch-Mode: navigate
Sec-Fetch-User: ?1
Sec-Fetch-Dest: document
Accept-Encoding: gzip, deflate, br
Priority: u=0, i
```

## GET /onlinebookings/main/ (JSONP — requête principale du widget)
```
Sec-Ch-Ua: "Not-A.Brand";v="24", "Chromium";v="146"
Sec-Ch-Ua-Mobile: ?0
Sec-Ch-Ua-Platform: "Windows"
Sec-Ch-Ua-Full-Version: ""
Sec-Ch-Ua-Arch: ""
Sec-Ch-Ua-Platform-Version: ""
Sec-Ch-Ua-Model: ""
Sec-Ch-Ua-Bitness: ""
Sec-Ch-Ua-Full-Version-List: (empty)
Accept-Language: fr-FR,fr;q=0.9
X-Requested-With: XMLHttpRequest
Accept: text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors          ← bot envoie no-cors (BUG)
Sec-Fetch-Dest: empty         ← bot envoie script (BUG)
Referer: https://www.citaconsular.es/es/hosteds/widgetdefault/.../
Accept-Encoding: gzip, deflate, br
Priority: u=1, i
```

## GET /onlinebookings/getwidgetconfigurations/ (JSONP)
Mêmes headers que /main/ — cors/empty/jQuery Accept

## GET /onlinebookings/getservices/ (JSONP)
Mêmes headers que /main/ — cors/empty/jQuery Accept

## Observations clés
- Cloudflare envoie Accept-CH qui demande TOUS les high-entropy hints
- Chrome répond avec valeurs vides "" mais les ENVOIE (bot ne les envoie pas du tout = fingerprint hole)
- JSONP via jQuery $.ajax = XHR (cors/empty), PAS script tag (no-cors/script)
- Accept JSONP = jQuery AJAX default pour dataType="jsonp"
