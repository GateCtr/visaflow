# Bundle Analysis — Extraction Automatique

**Bundle :** `main.dc91e3f7b5f67caa.js` (2015 KB)
**Date extraction :** 2026-05-11
**Total sections :** 20

---

## Index des sections

| ID | Section | Méthode | URL | Matches |
|----|---------|---------|-----|---------|
| 01 | login | `POST` | `/identity/user/login` | 50 |
| 02 | verifyMfa | `POST` | `/identity/verifyMfa` | 9 |
| 03 | refreshToken | `POST` | `/identity/refreshToken` | 19 |
| 04 | logout | `POST` | `/identity/logout` | 3 |
| 05 | paymentStatus | `GET` | `/workflow/getUserHistoryApplicantPaymentStatus` | 7 |
| 06 | getApplicationDetails | `GET` | `/appointments/getApplicationDetails?applicationId=&applicantId=` | 61 |
| 07 | getLandingPage | `GET` | `/appointment/getLandingPageDeatils` | 9 |
| 08 | ofcList | `GET` | `/ofcuser/ofclist/{missionId}` | 14 |
| 09 | getFirstAvailableMonth | `POST` | `/modifyslot/getFirstAvailableMonth` | 9 |
| 10 | getSlotDates | `POST` | `/modifyslot/getSlotDates` | 12 |
| 11 | getSlotTime | `POST` | `/modifyslot/getSlotTime` | 22 |
| 12 | bookSlot | `PUT` | `/appointments/schedule` | 33 |
| 13 | rescheduleAppointment | `PUT` | `/appointments/reschedule` | 9 |
| 14 | httpInterceptor | `ALL` | `Intercepteur global` | 12 |
| 15 | sanityCheck | `GET` | `TBD — voir contexte` | 17 |
| 16 | appointmentLetter | `POST` | `/template/appointmentLetter` | 4 |
| 17 | csrfAndCookies | `N/A` | `Mécanique transversale` | 96 |
| 18 | cryptoEncryption | `N/A` | `Bibliothèque interne` | 21 |
| 19 | bookSlotPayloadConstruction | `N/A` | `Construction payload` | 10 |
| 20 | tokenStorage | `N/A` | `SessionStorage interne` | 29 |

---

## [01] login

**Description :** POST /identity/user/login — Authentification initiale avec credentials AES-chiffrés

**Méthode :** `POST`
**URL :** `/identity/user/login`
**Total contextes extraits :** 50

### Appels HTTP trouvés (1)

**Appel #1 — POST**
```js
ew i.WM({uuid:H});return this.http.post(d.N.visaAppPortalURL+"/confirm/signup",{},{headers:I})}getByUserId(H){return this.http.get(d.N.visaAppPortalURL+"/componentAccess/user/{id}?Id="+H)}loginUser(H){window.sessionStorage.clear();const I=new i.WM({"Access-Control-Allow-Origin":"*","Access-Control-Allow-Credentials":"true","Access-Control-Max-Age":"1000","Access-Control-Allow-Headers":"Origin, Content-Type, X-Auth-Token, content-type,-CSRF-Token, Authorization"});let A={authorization:"Basic "+this.cryptoService.encrypt(H.username+":"+H.password)};return this.http.post(`${d.N.authenticationURL}/login`,A,{headers:I,observe:"response"}).pipe((0,e.U)(F=>(200==F.status&&(this.csrfToken=F.headers.get("Csrftoken"),localStorage.setItem("CSRFTOKEN",this.csrfToken),this.token.saveToken(F.headers.get("Authorization")),this.token.setRefreshToken(F.headers.get("refreshtoken")),F.body.userType="APPLICANT",localStorage.setItem("loggedInApplicantUser",JSON.stringify(F.body)),this.setIdleTimeOut()),F))
```

### Contextes clés (3 sur 49)

**Mot-clé :** `loginUser(`
```js
icantSignupDetails(H){return this.http.post(d.N.visaAppPortalURL+"/signup",H)}verifyApplicantByUUID(H){const I=new i.WM({uuid:H});return this.http.post(d.N.visaAppPortalURL+"/confirm/signup",{},{headers:I})}getByUserId(H){return this.http.get(d.N.visaAppPortalURL+"/componentAccess/user/{id}?Id="+H)}loginUser(H){window.sessionStorage.clear();const I=new i.WM({"Access-Control-Allow-Origin":"*","Access-Control-Allow-Credentials":"true","Access-Control-Max-Age":"1000","Access-Control-Allow-Headers":"Origin, Content-Type, X-Auth-Token, content-type,-CSRF-Token, Authorization"});let A={authorization:"Basic "+this.cryptoService.encrypt(H.username+":"+H.password)};return this.http.post(`${d.N.authenticationURL}/login`,A,{headers:I,observe:"response"}).pipe((0,e.U)(F=>(200==F.status&&(this.csrfToke
```

**Mot-clé :** `loginUser(`
```js
clear(),localStorage.removeItem("showedPasswordpopup"),localStorage.removeItem("loggedInApplicantUser"),this.titleService.setTitle("AVITS My Dashboard"),this.doAfterLogout(!0),this.isSubmitted=!0,this.loginForm.valid){const v=this.loginForm.value;this.sharedService.show(),this.authenticationService.loginUser(v).subscribe({next:j=>{this.sharedService.hide(),this.userData=j,1==j.body?.mfa?(this.mfaMsg=j.body?.msg,this.isSuccess=!1,this.closebutton.nativeElement.click()):j.body&&(this.checkPendingAppointment(),j.body?.firstTimeLogin?this.router.navigate(["./resetpassword"]):this.redirectToHome())},error:j=>{this.sharedService.hide(),401===j.status?this.notifierService.notify("PASSWORDEXPIRED"===j.error?.isActive?"Your password has been expired. Please change password to continue":j.error.msg,
```

**Mot-clé :** `authorization:"Basic "+this.cryptoService.encrypt`
```js
{id}?Id="+H)}loginUser(H){window.sessionStorage.clear();const I=new i.WM({"Access-Control-Allow-Origin":"*","Access-Control-Allow-Credentials":"true","Access-Control-Max-Age":"1000","Access-Control-Allow-Headers":"Origin, Content-Type, X-Auth-Token, content-type,-CSRF-Token, Authorization"});let A={authorization:"Basic "+this.cryptoService.encrypt(H.username+":"+H.password)};return this.http.post(`${d.N.authenticationURL}/login`,A,{headers:I,observe:"response"}).pipe((0,e.U)(F=>(200==F.status&&(this.csrfToken=F.headers.get("Csrftoken"),localStorage.setItem("CSRFTOKEN",this.csrfToken),this.token.saveToken(F.headers.get("Authorization")),this.token.setRefreshToken(F.headers.get("refreshtoken")),F.body.userType="APPLICANT",localStorage.setItem("loggedInApplicantUser",JSON.stringify(F.body)),t
```

---

## [02] verifyMfa

**Description :** POST /identity/verifyMfa — Validation OTP pour comptes avec MFA activé

**Méthode :** `POST`
**URL :** `/identity/verifyMfa`
**Total contextes extraits :** 9

### Appels HTTP trouvés (1)

**Appel #1 — POST**
```js
e.getItem("loggedInApplicantUser");let A="";return I&&(A=JSON.parse(I).userName),this.http.post(`${d.N.authenticationURL}/refreshToken`,{refreshToken:H,username:A},{observe:"response"})}resend(H){const I=new i.WM({Authorization:"Basic "+this.cryptoService.encrypt(H.username+":"+H.password),userType:"applicant"});return this.http.post(`${d.N.authenticationURL}/resendmfa`,null,{headers:I,observe:"response"})}varifyMfa(H,I){const A=new i.WM({Authorization:"Basic "+this.cryptoService.encrypt(I.username+":"+I.password),userType:"applicant",mfa:H.mfa});return this.http.post(`${d.N.authenticationURL}/verifyMfa`,null,{headers:A,observe:"response"}).pipe((0,e.U)(F=>(200==F.status&&!F.body?.mfa&&(this.token.saveToken(F.headers.get("Authorization")),this.token.setRefreshToken(F.headers.get("refreshtoken")),localStorage.setItem("loggedInUser",JSON.stringify(F.body)),localStorage.setItem("loggedInApplicantUser",JSON.stringify(F.body)),this.setIdleTimeOut()),F)))}}return k.\u0275fac=function(H){retu
```

### Contextes clés (3 sur 8)

**Mot-clé :** `verifyMfa`
```js
applicant"});return this.http.post(`${d.N.authenticationURL}/resendmfa`,null,{headers:I,observe:"response"})}varifyMfa(H,I){const A=new i.WM({Authorization:"Basic "+this.cryptoService.encrypt(I.username+":"+I.password),userType:"applicant",mfa:H.mfa});return this.http.post(`${d.N.authenticationURL}/verifyMfa`,null,{headers:A,observe:"response"}).pipe((0,e.U)(F=>(200==F.status&&!F.body?.mfa&&(this.token.saveToken(F.headers.get("Authorization")),this.token.setRefreshToken(F.headers.get("refreshtoken")),localStorage.setItem("loggedInUser",JSON.stringify(F.body)),localStorage.setItem("loggedInApplicantUser",JSON.stringify(F.body)),this.setIdleTimeOut()),F)))}}return k.\u0275fac=function(H){return new(H||k)(h.LFG(i.eN),h.LFG(p.i),h.LFG(y.F0),h.LFG(w.l),h.LFG(f.uw),h.LFG(E.$),h.LFG(D.L))},k.\u02
```

**Mot-clé :** `verifyMfa`
```js
this.authService=bt,this.route=Mt,this.sheredSer=Ut,this.refreshingYN=!1}intercept(v,j){return j.handle(v).pipe((0,ms.U)(Ce=>Ce),(0,Xa.K)(Ce=>{if(!Ce||401!==Ce.status||v.url.endsWith("/user/login")||v.url.endsWith("/temporaryPasswordChange")||v.url.endsWith("/forgotPassword")||v.url.endsWith("/user/verifyMfa")||v.url.endsWith("/user/verifyMfa")){if(Ce&&403===Ce.status&&!v.url.includes("/appointments/setDefaultNumericalSlot/"))return this.notifierService.notify("You do not have permission to access this resource.","mat-warn"),this.spinner.hide(),(0,Ls.of)()}else if(!this.refreshingYN){const Ue=sessionStorage.getItem("AuthToken"),bt=yt(Ue);(new Date).getTime()>1e3*bt.exp?this.handle401Error(v,j):(this.refreshingYN=!1,this.authService.forceLogoutUser())}return(0,rl._)(()=>Ce)}))}handle401Erro
```

**Mot-clé :** `verifyMfa`
```js
his.sheredSer=Ut,this.refreshingYN=!1}intercept(v,j){return j.handle(v).pipe((0,ms.U)(Ce=>Ce),(0,Xa.K)(Ce=>{if(!Ce||401!==Ce.status||v.url.endsWith("/user/login")||v.url.endsWith("/temporaryPasswordChange")||v.url.endsWith("/forgotPassword")||v.url.endsWith("/user/verifyMfa")||v.url.endsWith("/user/verifyMfa")){if(Ce&&403===Ce.status&&!v.url.includes("/appointments/setDefaultNumericalSlot/"))return this.notifierService.notify("You do not have permission to access this resource.","mat-warn"),this.spinner.hide(),(0,Ls.of)()}else if(!this.refreshingYN){const Ue=sessionStorage.getItem("AuthToken"),bt=yt(Ue);(new Date).getTime()>1e3*bt.exp?this.handle401Error(v,j):(this.refreshingYN=!1,this.authService.forceLogoutUser())}return(0,rl._)(()=>Ce)}))}handle401Error(v,j){this.refreshingYN=!0;const C
```

---

## [03] refreshToken

**Description :** POST /identity/refreshToken — Renouvellement du JWT

**Méthode :** `POST`
**URL :** `/identity/refreshToken`
**Total contextes extraits :** 19

### Appels HTTP trouvés (1)

**Appel #1 — POST**
```js
Storage.setItem("forceLogoutApplicant",Math.random().toString()),this.forceLogoutUser(),this.setTimerClear()})}setTimerClear(){this.timer&&this.timer.cleanUp()}localStorageCallBack(){window.addEventListener("storage",H=>{H.storageArea==localStorage&&"forceLogoutApplicant"===H.key&&this.forceLogoutUser()})}closeAllOpenDialogues(){try{$(".modal").modal("hide"),$(".modal-backdrop").remove()}catch{}try{this.dialogRef.closeAll()}catch{}}fetchNewRefreshToken(H){const I=localStorage.getItem("loggedInApplicantUser");let A="";return I&&(A=JSON.parse(I).userName),this.http.post(`${d.N.authenticationURL}/refreshToken`,{refreshToken:H,username:A},{observe:"response"})}resend(H){const I=new i.WM({Authorization:"Basic "+this.cryptoService.encrypt(H.username+":"+H.password),userType:"applicant"});return this.http.post(`${d.N.authenticationURL}/resendmfa`,null,{headers:I,observe:"response"})}varifyMfa(H,I){const A=new i.WM({Authorization:"Basic "+this.cryptoService.encrypt(I.username+":"+I.password),u
```

### Contextes clés (3 sur 18)

**Mot-clé :** `refreshToken`
```js
r()})}closeAllOpenDialogues(){try{$(".modal").modal("hide"),$(".modal-backdrop").remove()}catch{}try{this.dialogRef.closeAll()}catch{}}fetchNewRefreshToken(H){const I=localStorage.getItem("loggedInApplicantUser");let A="";return I&&(A=JSON.parse(I).userName),this.http.post(`${d.N.authenticationURL}/refreshToken`,{refreshToken:H,username:A},{observe:"response"})}resend(H){const I=new i.WM({Authorization:"Basic "+this.cryptoService.encrypt(H.username+":"+H.password),userType:"applicant"});return this.http.post(`${d.N.authenticationURL}/resendmfa`,null,{headers:I,observe:"response"})}varifyMfa(H,I){const A=new i.WM({Authorization:"Basic "+this.cryptoService.encrypt(I.username+":"+I.password),userType:"applicant",mfa:H.mfa});return this.http.post(`${d.N.authenticationURL}/verifyMfa`,null,{head
```

**Mot-clé :** `refreshToken`
```js
penDialogues(){try{$(".modal").modal("hide"),$(".modal-backdrop").remove()}catch{}try{this.dialogRef.closeAll()}catch{}}fetchNewRefreshToken(H){const I=localStorage.getItem("loggedInApplicantUser");let A="";return I&&(A=JSON.parse(I).userName),this.http.post(`${d.N.authenticationURL}/refreshToken`,{refreshToken:H,username:A},{observe:"response"})}resend(H){const I=new i.WM({Authorization:"Basic "+this.cryptoService.encrypt(H.username+":"+H.password),userType:"applicant"});return this.http.post(`${d.N.authenticationURL}/resendmfa`,null,{headers:I,observe:"response"})}varifyMfa(H,I){const A=new i.WM({Authorization:"Basic "+this.cryptoService.encrypt(I.username+":"+I.password),userType:"applicant",mfa:H.mfa});return this.http.post(`${d.N.authenticationURL}/verifyMfa`,null,{headers:A,observe:"
```

**Mot-clé :** `refreshToken`
```js
FGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";let j="";for(let Ce=0;Ce<15;Ce++)j+=v.charAt(Math.floor(Math.random()*v.length));return j}intercept(v,j){const Ce=this.tokenStorage.getToken();if(!(null==Ce||v.url.endsWith("/forgotPassword")||v.url.endsWith("/user/login")||v.url.endsWith("/refreshToken")||v.url.includes("/api/supports?filters")))if(v.url.includes("/document/docSave")||v.url.includes("/history/upload")||v.url.includes("/incidentinquirydocuments/docSave")||v.url.includes("incident/saveTicketDetails")||v.url.endsWith("/incidentNote")||v.url.endsWith("/requestSave"))v=v.clone({setHeaders:{Authorization:`Bearer ${Ce}`,Accept:"multipart/form-data,application/json","X-Correlation-key":this.generateCorrelationId()}});else if(!v.url.includes("/changePassword"))if(v.url.inc
```

---

## [04] logout

**Description :** POST /identity/logout — Déconnexion

**Méthode :** `POST`
**URL :** `/identity/logout`
**Total contextes extraits :** 3

### Appels HTTP trouvés (1)

**Appel #1 — POST**
```js
on"});let A={authorization:"Basic "+this.cryptoService.encrypt(H.username+":"+H.password)};return this.http.post(`${d.N.authenticationURL}/login`,A,{headers:I,observe:"response"}).pipe((0,e.U)(F=>(200==F.status&&(this.csrfToken=F.headers.get("Csrftoken"),localStorage.setItem("CSRFTOKEN",this.csrfToken),this.token.saveToken(F.headers.get("Authorization")),this.token.setRefreshToken(F.headers.get("refreshtoken")),F.body.userType="APPLICANT",localStorage.setItem("loggedInApplicantUser",JSON.stringify(F.body)),this.setIdleTimeOut()),F)))}logoutUser(){return this.http.post(`${d.N.authenticationURL}/logout`,null,{responseType:"text"})}get currentUserValue(){let H=localStorage.getItem("loggedInApplicantUser");return H&&(H=JSON.parse(H)),H}forgotPassword(H){const I=d.N.visaAppPortalURL+"/forgotPassword";let A=new i.WM({userName:H});return this.http.post(I,null,{headers:A})}resetPassword(H,I){const A=d.N.visaAppPortalURL+"/resetPassword";let F=new i.WM({confirmationID:I});return this.http.post(
```

### Contextes clés (2 sur 2)

**Mot-clé :** `logoutUser(`
```js
t("Csrftoken"),localStorage.setItem("CSRFTOKEN",this.csrfToken),this.token.saveToken(F.headers.get("Authorization")),this.token.setRefreshToken(F.headers.get("refreshtoken")),F.body.userType="APPLICANT",localStorage.setItem("loggedInApplicantUser",JSON.stringify(F.body)),this.setIdleTimeOut()),F)))}logoutUser(){return this.http.post(`${d.N.authenticationURL}/logout`,null,{responseType:"text"})}get currentUserValue(){let H=localStorage.getItem("loggedInApplicantUser");return H&&(H=JSON.parse(H)),H}forgotPassword(H){const I=d.N.visaAppPortalURL+"/forgotPassword";let A=new i.WM({userName:H});return this.http.post(I,null,{headers:A})}resetPassword(H,I){const A=d.N.visaAppPortalURL+"/resetPassword";let F=new i.WM({confirmationID:I});return this.http.post(A,{password:H},{headers:F})}resetPasswor
```

**Mot-clé :** `/logout`
```js
en),this.token.saveToken(F.headers.get("Authorization")),this.token.setRefreshToken(F.headers.get("refreshtoken")),F.body.userType="APPLICANT",localStorage.setItem("loggedInApplicantUser",JSON.stringify(F.body)),this.setIdleTimeOut()),F)))}logoutUser(){return this.http.post(`${d.N.authenticationURL}/logout`,null,{responseType:"text"})}get currentUserValue(){let H=localStorage.getItem("loggedInApplicantUser");return H&&(H=JSON.parse(H)),H}forgotPassword(H){const I=d.N.visaAppPortalURL+"/forgotPassword";let A=new i.WM({userName:H});return this.http.post(I,null,{headers:A})}resetPassword(H,I){const A=d.N.visaAppPortalURL+"/resetPassword";let F=new i.WM({confirmationID:I});return this.http.post(A,{password:H},{headers:F})}resetPasswordForApp(H,I){let A=d.N.visaAppPortalURL+"/temporaryPasswordC
```

---

## [05] paymentStatus

**Description :** GET /workflow/getUserHistoryApplicantPaymentStatus — Statut paiement & demande RDV

**Méthode :** `GET`
**URL :** `/workflow/getUserHistoryApplicantPaymentStatus`
**Total contextes extraits :** 7

### Appels HTTP trouvés (1)

**Appel #1 — GET**
```js
/${y}`)}checkRequestIdbyAppId(y){return this.http.get(this.visaWorkFlowURL+`/workflow/getApplicationHistory/${y}`,{observe:"response",responseType:"text"})}getSavedhistory(){return this.historyStatus}setData(y){this.historyStatus=y}getAppIdByUserId(y){let w=localStorage.getItem("loggedInApplicantUser");return w=JSON.parse(w),this.http.get("ADMIN"!==w.userType?this.visaWorkFlowURL+"/workflow/getUserHistoryApplicantPaymentStatus":this.visaWorkFlowURL+`/workflow/getUserHistory/${y}`,{observe:"response",responseType:"text"})}getPaymentStatus(y){return this.http.get(this.visaWorkFlowURL+"/workflow/getUserHistoryApplicantPaymentStatus",{observe:"response",responseType:"text"})}getTransformData(y,w){return this.http.get(this.visaWorkFlowURL+`/workflow/getTransformData/${y}`)}getUnclaimedReceiptList(y,w){return this.http.post(this.paymentURL+"/receipt/unclaimedReceiptProcess",y)}removeApplicant(y){return this.http.post(this.applicationApi+"/visaApplication/removeApplicants",y,{responseType:"te
```

### Contextes clés (3 sur 6)

**Mot-clé :** `getUserHistoryApplicantPaymentStatus`
```js
cationHistory/${y}`,{observe:"response",responseType:"text"})}getSavedhistory(){return this.historyStatus}setData(y){this.historyStatus=y}getAppIdByUserId(y){let w=localStorage.getItem("loggedInApplicantUser");return w=JSON.parse(w),this.http.get("ADMIN"!==w.userType?this.visaWorkFlowURL+"/workflow/getUserHistoryApplicantPaymentStatus":this.visaWorkFlowURL+`/workflow/getUserHistory/${y}`,{observe:"response",responseType:"text"})}getPaymentStatus(y){return this.http.get(this.visaWorkFlowURL+"/workflow/getUserHistoryApplicantPaymentStatus",{observe:"response",responseType:"text"})}getTransformData(y,w){return this.http.get(this.visaWorkFlowURL+`/workflow/getTransformData/${y}`)}getUnclaimedReceiptList(y,w){return this.http.post(this.paymentURL+"/receipt/unclaimedReceiptProcess",y)}removeAppl
```

**Mot-clé :** `getUserHistoryApplicantPaymentStatus`
```js
r");return w=JSON.parse(w),this.http.get("ADMIN"!==w.userType?this.visaWorkFlowURL+"/workflow/getUserHistoryApplicantPaymentStatus":this.visaWorkFlowURL+`/workflow/getUserHistory/${y}`,{observe:"response",responseType:"text"})}getPaymentStatus(y){return this.http.get(this.visaWorkFlowURL+"/workflow/getUserHistoryApplicantPaymentStatus",{observe:"response",responseType:"text"})}getTransformData(y,w){return this.http.get(this.visaWorkFlowURL+`/workflow/getTransformData/${y}`)}getUnclaimedReceiptList(y,w){return this.http.post(this.paymentURL+"/receipt/unclaimedReceiptProcess",y)}removeApplicant(y){return this.http.post(this.applicationApi+"/visaApplication/removeApplicants",y,{responseType:"text"})}deleteApplicantById(y,w){return this.http.get(l.N.visaWorkFlowURL+`/workflow/deleteApplicant/$
```

**Mot-clé :** `pendingAppoStatus`
```js
alStorage.setItem("ADMIN_ID",this.adminId),this.route.queryParams.subscribe(j=>{v={token:j.token,userId:j.userId},v.userId&&v.token&&(this.setAuthAndLoginInfo(v,{userID:v.userId}),this.renderService.getAppIdByUserId(v.userId).subscribe({next:Ce=>{if(200===Ce.status&&Ce.body&&0!==JSON.parse(Ce.body).pendingAppoStatus){const Ue=JSON.parse(Ce.body),bt=Math.floor(99*Math.random());localStorage.setItem("RANDOME_ID",bt+""),this.renderService.setCookieByDeleteOld("APP_ID_TOBE",Ue.applicationId),this.renderService.setCookieByDeleteOld("missionId",Ue.missionId),this.router.navigate([`../../principal/${bt}/appointment/create`],{relativeTo:this.route})}else this.notifierService.notify(200===Ce.status?"The Application has been completed succesfully.":"Something went wrong. please try again later.","ma
```

---

## [06] getApplicationDetails

**Description :** GET /appointments/getApplicationDetails — Détails demande (tableau), filtre appointmentStatus=NEW

**Méthode :** `GET`
**URL :** `/appointments/getApplicationDetails?applicationId=&applicantId=`
**Total contextes extraits :** 61

### Appels HTTP trouvés (1)

**Appel #1 — GET**
```js
FlowURL+`/workflow/reset/${y}/${w}`,{},{responseType:"text"})}getStepDataByApplicantionId(y,w=null){return this.http.get(this.visaWorkFlowURL+`/stepdata/application/${y}/${w}`)}getStepDataByApplicantionIdBySearch(y){return this.http.post(l.N.visaAppointment+"/appointments/search",y)}getViewByApplicantionId(y,w){return this.http.get(l.N.viewApplicantURL+`/applicationassociations/getByApplicationsApplicationId/${y}`)}getApplicantListByIdSearch(y){return this.http.post(l.N.visaAdminURL+"/dossier/search",y)}getappointmentByApplicationId(y,w){return this.http.get(l.N.visaAppointment+"/appointments/getApplicationDetails?applicationId="+w+"&applicantId="+y)}getAppointmentByStatus(y,w,f,E){return this.http.get(l.N.visaAdminURL+"/visacat/priority?postId="+f+"&visaCateg="+w+"&visaClass="+y+"&applicantId="+E)}getPrevStepReqIdByCurrentReqId(y){return this.http.get(this.visaWorkFlowURL+`/workflow/getPrevRequestId/${y}`,{observe:"response",responseType:"text"})}getStepDataByRequestId(y){return this.
```

### Contextes clés (3 sur 60)

**Mot-clé :** `getApplicationDetails`
```js
ntionId(y,w){return this.http.get(l.N.viewApplicantURL+`/applicationassociations/getByApplicationsApplicationId/${y}`)}getApplicantListByIdSearch(y){return this.http.post(l.N.visaAdminURL+"/dossier/search",y)}getappointmentByApplicationId(y,w){return this.http.get(l.N.visaAppointment+"/appointments/getApplicationDetails?applicationId="+w+"&applicantId="+y)}getAppointmentByStatus(y,w,f,E){return this.http.get(l.N.visaAdminURL+"/visacat/priority?postId="+f+"&visaCateg="+w+"&visaClass="+y+"&applicantId="+E)}getPrevStepReqIdByCurrentReqId(y){return this.http.get(this.visaWorkFlowURL+`/workflow/getPrevRequestId/${y}`,{observe:"response",responseType:"text"})}getStepDataByRequestId(y){return this.http.get(this.visaWorkFlowURL+`/workflow/getStepData/${y}`)}loadMetaDataByRequestId(y,w){return this
```

**Mot-clé :** `getappointmentByApplicationId`
```js
rch(y){return this.http.post(l.N.visaAppointment+"/appointments/search",y)}getViewByApplicantionId(y,w){return this.http.get(l.N.viewApplicantURL+`/applicationassociations/getByApplicationsApplicationId/${y}`)}getApplicantListByIdSearch(y){return this.http.post(l.N.visaAdminURL+"/dossier/search",y)}getappointmentByApplicationId(y,w){return this.http.get(l.N.visaAppointment+"/appointments/getApplicationDetails?applicationId="+w+"&applicantId="+y)}getAppointmentByStatus(y,w,f,E){return this.http.get(l.N.visaAdminURL+"/visacat/priority?postId="+f+"&visaCateg="+w+"&visaClass="+y+"&applicantId="+E)}getPrevStepReqIdByCurrentReqId(y){return this.http.get(this.visaWorkFlowURL+`/workflow/getPrevRequestId/${y}`,{observe:"response",responseType:"text"})}getStepDataByRequestId(y){return this.http.get(
```

**Mot-clé :** `relatedAppList`
```js
")," "),a.xp6(6),a.hij(" ",a.xi3(13,13,null==De.rescheduleSlots[0]?null:De.rescheduleSlots[0].date,"dd, MMM yyyy")," "),a.xp6(3),a.AsE("",null==De.rescheduleSlots[0]?null:De.rescheduleSlots[0].UItime," - ",null==De.rescheduleSlots[0]?null:De.rescheduleSlots[0].UIEndtime," "),a.xp6(3),a.Oqu(null==De.relatedAppList[0]?null:De.relatedAppList[0].visaType),a.xp6(2),a.Oqu(De.slotVisaClass)}}function re(Pt,Xt){if(1&Pt){const De=a.EpF();a.TgZ(0,"div",31)(1,"div",51)(2,"div",52)(3,"p"),a._uU(4),a.ALo(5,"date"),a.qZA(),a.TgZ(6,"span"),a._uU(7),a.ALo(8,"languageTranslator"),a.qZA()(),a.TgZ(9,"div",53),a.YNc(10,pe,2,4,"button",54),a.qZA()(),a.TgZ(11,"button",55),a.NdJ("debounceClick",function(){a.CHM(De);const Ee=a.oxw(2);return a.KtG(Ee.bookSlotHolder())}),a._uU(12),a.qZA(),a.YNc(13,ye,21,16,"div",56
```

---

## [07] getLandingPage

**Description :** GET /appointment/getLandingPageDeatils — Page d'accueil du portail (warm-up + LanguageId header)

**Méthode :** `GET`
**URL :** `/appointment/getLandingPageDeatils`
**Total contextes extraits :** 9

### Appels HTTP trouvés (2)

**Appel #1 — GET**
```js
dminURL,this.notifiation=e.N.notificationUrl}getAppointmentsList(){return this.http.get(this.visaAppointment+"/getlist")}getTemplate(h){return this.http.get(this.notifiation+"/template/gettemplate/"+h+"/Instruction")}getAllGroupRequest(h){let p=localStorage.getItem("loggedInApplicantUser");p=JSON.parse(p);let y=this.visaAdmin+`/appointmentrequest/getallbyuserid?userId=${h}&type=GROUPREQUEST`;return"ADMIN"!==p.userType&&(y=this.visaAdmin+"/appointmentrequest/getallbyuser?type=GROUPREQUEST"),this.http.get(y)}getAppointmentDashboardDetails(){return this.http.get(e.N.visaAppointment+"/appointment/getLandingPageDeatils")}getIWpaymentDetails(h){return this.http.get(e.N.visaWorkFlowURL+"/workflow/status/complete/"+h)}updateAppointmentInformation(h){return this.http.put(e.N.visaAppointment+"/appointments",h)}downloadAppointment(h){const p=new i.WM({accept:"application/pdf"});return this.http.post(e.N.notificationUrl+"/template/appointmentLetter",h,{headers:p,observe:"response",responseType:"bl
```

**Appel #2 — GET**
```js
LFG(E.$),h.LFG(D.L))},k.\u0275prov=h.Yz7({token:k,factory:k.\u0275fac,providedIn:"root"}),k})()},2783:(Ye,Q,c)=>{"use strict";c.d(Q,{L:()=>d});var i=c(7579),e=c(2340),a=c(4650),l=c(529);let d=(()=>{class _{constructor(p){this.httpClient=p,this.dashboardRefresh=new i.x,this.dashboardRefreshObs$=this.dashboardRefresh.asObservable()}setLandingPageDetails(p){this.resetApplicantDetails(),this.landingPageDetails=p}getLandingPageDetails(){return this.landingPageDetails}getAppointmentDashboardDetails(p){return localStorage.setItem("LanguageId",p),this.httpClient.get(e.N.visaAppointment+"/appointments/getLandingPageDeatils")}getRescheduleButtonDetails(){return this.httpClient.get(e.N.visaAppointment+"/appointments/showRescheduleButton")}cancelAppointment(p){return this.httpClient.put(e.N.visaAppointment+"/appointments",p)}rescheduleAppointment(p){}getScheduledappintmentList(p){return this.httpClient.get(e.N.visaAppointment+"/appointments/scheduledappointmentInfo")}getAllSupportTicketDetailsDeta
```

### Contextes clés (3 sur 7)

**Mot-clé :** `getLandingPageDeatils`
```js
rse(p);let y=this.visaAdmin+`/appointmentrequest/getallbyuserid?userId=${h}&type=GROUPREQUEST`;return"ADMIN"!==p.userType&&(y=this.visaAdmin+"/appointmentrequest/getallbyuser?type=GROUPREQUEST"),this.http.get(y)}getAppointmentDashboardDetails(){return this.http.get(e.N.visaAppointment+"/appointment/getLandingPageDeatils")}getIWpaymentDetails(h){return this.http.get(e.N.visaWorkFlowURL+"/workflow/status/complete/"+h)}updateAppointmentInformation(h){return this.http.put(e.N.visaAppointment+"/appointments",h)}downloadAppointment(h){const p=new i.WM({accept:"application/pdf"});return this.http.post(e.N.notificationUrl+"/template/appointmentLetter",h,{headers:p,observe:"response",responseType:"blob"})}searcApplicationDetails(h){return this.http.post(e.N.visaAppointment+"/appointments/search",h)
```

**Mot-clé :** `getLandingPageDeatils`
```js
dashboardRefresh.asObservable()}setLandingPageDetails(p){this.resetApplicantDetails(),this.landingPageDetails=p}getLandingPageDetails(){return this.landingPageDetails}getAppointmentDashboardDetails(p){return localStorage.setItem("LanguageId",p),this.httpClient.get(e.N.visaAppointment+"/appointments/getLandingPageDeatils")}getRescheduleButtonDetails(){return this.httpClient.get(e.N.visaAppointment+"/appointments/showRescheduleButton")}cancelAppointment(p){return this.httpClient.put(e.N.visaAppointment+"/appointments",p)}rescheduleAppointment(p){}getScheduledappintmentList(p){return this.httpClient.get(e.N.visaAppointment+"/appointments/scheduledappointmentInfo")}getAllSupportTicketDetailsDetails(){const p=localStorage.getItem("loggedInApplicantUser");let y;return p&&(y=JSON.parse(p)),this.h
```

**Mot-clé :** `getLandingPageDeatils`
```js
t/saveTicketDetails")||v.url.endsWith("/incidentNote")||v.url.endsWith("/requestSave"))v=v.clone({setHeaders:{Authorization:`Bearer ${Ce}`,Accept:"multipart/form-data,application/json","X-Correlation-key":this.generateCorrelationId()}});else if(!v.url.includes("/changePassword"))if(v.url.includes("/getLandingPageDeatils")||v.url.includes("/generatewizardtemplate")){let Ue=localStorage.getItem("LanguageId");v=v.clone({setHeaders:{Authorization:`Bearer ${Ce}`,"Content-Type":"application/json",LanguageId:`${Ue}`,"X-Correlation-key":this.generateCorrelationId()}})}else v=v.clone({setHeaders:{Authorization:`Bearer ${Ce}`,"Content-Type":"application/json","X-Correlation-key":this.generateCorrelationId()}});if(v.url.endsWith("/portal/changePassword")){const Ue="XSRF-TOKEN",bt=localStorage.getItem
```

---

## [08] ofcList

**Description :** GET /ofcuser/ofclist/{missionId} ou /lookupcdt/wizard/getpost — Liste des OFCs

**Méthode :** `GET`
**URL :** `/ofcuser/ofclist/{missionId}`
**Total contextes extraits :** 14

### Appels HTTP trouvés (3)

**Appel #1 — GET**
```js
items--rt-fixed[_ngcontent-%COMP%]   a[_ngcontent-%COMP%]   span.right-toggle-active-current[_ngcontent-%COMP%]{width:45px;height:45px;right:4px;line-height:44px;margin-right:10px;background:#4f6895;color:#fff}.nav__items--rt-fixed[_ngcontent-%COMP%]   a[_ngcontent-%COMP%]   span.right-toggle-active-current[_ngcontent-%COMP%]:after{margin-left:21px!important}"]}),y})()},3919:(Ye,Q,c)=>{"use strict";c.d(Q,{l:()=>l});var i=c(2340),e=c(4650),a=c(529);let l=(()=>{class d{constructor(h){this.http=h,this.visaAdminUrl=i.N.visaAdminURL}getOfcListByMissionId(h){return this.http.get(this.visaAdminUrl+`/ofcuser/ofclist/${h}`)}getDeliveryLocationsByMissionId(h){return this.http.get(this.visaAdminUrl+`/deliverymission/config/missionId/${h}`)}getMissionConfigurationsById(h){return this.http.get(this.visaAdminUrl+`/custom/getbymissionid/${h}`)}getPostConfigurationById(h){return this.http.get(this.visaAdminUrl+`/postconfiguration/get/${h}`)}}return d.\u0275fac=function(h){return new(h||d)(e.LFG(a.eN))
```

**Appel #2 — GET**
```js
eApplicant/${y}/${w}`,{observe:"response",responseType:"text"})}setLastLoadedRequestId(y){this.setCookieByDeleteOld("REQUEST_ID_IN_DISP",y)}getLastLoadedRequestId(){return this.getCookieById("REQUEST_ID_IN_DISP")}getLastLoadedScreenYN(){return this._loadLastLoadedScreenYN}setLastLoadedScreenYN(y){this._loadLastLoadedScreenYN=y}getPreApplicationData(y,w){return this.http.get(this.visaWorkFlowURL+`/stepdata/getApplicationMetaData/${y}`)}getLivepayNeeded(y){return this.http.get(this.visaWorkFlowURL+`/workflow/isLivepayAvailable/${y}`)}getAllOfcByMissionId(y){return this.http.get(this.addofcurl+"/ofcuser/ofclist/"+y)}caseIdVerifyByAppId(y){return this.http.post(this.visaWorkFlowURL+"/stepdata/getPaymentReceiptNumber",{},{params:y})}savePreapprovalRequest(y){return this.http.post(this.visaAdminURL+"/appointmentrequest/requestSave",y)}addPreapprovalDocuments(y,w){return this.http.post(this.visaAdminURL+"/document/docSave/"+y,w,{responseType:"text"})}generateWizardTemplateByTemplateName(y){co
```

**Appel #3 — GET**
```js
intment+"/appointments/schedule",h)}bookGroupSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule/group",h)}listSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotDates",h)}getTimeSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotTime",h)}getAllOfc(){return this.http.get(this.visaAdminUrl+"/ofcuser")}rescheduleAppointment(h){return this.http.put(this.visaAppointment+"/appointments/reschedule",h)}receiptDetails(h){return this.http.post(this.paymentURL+"/receipt/details",h)}getFilteredOfcPostList(h){return this.http.get(this.visaAdminUrl+"/lookupcdt/wizard/getpost",{params:h})}getFirstAvailableMonth(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getFirstAvailableMonth",h)}}return d.\u0275fac=function(h){return new(h||d)(e.LFG(a.eN))},d.\u0275prov=e.Yz7({token:d,factory:d.\u0275fac,providedIn:"root"}),d})()},3728:(Ye,Q,c)=>{"use strict";c.d(Q,{o:()=>l});var i=c(529),e=c(2340),a=c(4650);let l=(()=>{class d{constructor(h){this
```

### Contextes clés (3 sur 11)

**Mot-clé :** `ofcuser/ofclist`
```js
-current[_ngcontent-%COMP%]:after{margin-left:21px!important}"]}),y})()},3919:(Ye,Q,c)=>{"use strict";c.d(Q,{l:()=>l});var i=c(2340),e=c(4650),a=c(529);let l=(()=>{class d{constructor(h){this.http=h,this.visaAdminUrl=i.N.visaAdminURL}getOfcListByMissionId(h){return this.http.get(this.visaAdminUrl+`/ofcuser/ofclist/${h}`)}getDeliveryLocationsByMissionId(h){return this.http.get(this.visaAdminUrl+`/deliverymission/config/missionId/${h}`)}getMissionConfigurationsById(h){return this.http.get(this.visaAdminUrl+`/custom/getbymissionid/${h}`)}getPostConfigurationById(h){return this.http.get(this.visaAdminUrl+`/postconfiguration/get/${h}`)}}return d.\u0275fac=function(h){return new(h||d)(e.LFG(a.eN))},d.\u0275prov=e.Yz7({token:d,factory:d.\u0275fac,providedIn:"root"}),d})()},9126:(Ye,Q,c)=>{"use st
```

**Mot-clé :** `ofcuser/ofclist`
```js
is._loadLastLoadedScreenYN=y}getPreApplicationData(y,w){return this.http.get(this.visaWorkFlowURL+`/stepdata/getApplicationMetaData/${y}`)}getLivepayNeeded(y){return this.http.get(this.visaWorkFlowURL+`/workflow/isLivepayAvailable/${y}`)}getAllOfcByMissionId(y){return this.http.get(this.addofcurl+"/ofcuser/ofclist/"+y)}caseIdVerifyByAppId(y){return this.http.post(this.visaWorkFlowURL+"/stepdata/getPaymentReceiptNumber",{},{params:y})}savePreapprovalRequest(y){return this.http.post(this.visaAdminURL+"/appointmentrequest/requestSave",y)}addPreapprovalDocuments(y,w){return this.http.post(this.visaAdminURL+"/document/docSave/"+y,w,{responseType:"text"})}generateWizardTemplateByTemplateName(y){const w=new i.WM({accept:"application/pdf"});return this.http.post(`${this.notificationUrl}/template/g
```

**Mot-clé :** `getFilteredOfcPostList`
```js
d("priority",this.rescheduleYN&&"group"==this.appointmentPriority?"regular":this.appointmentPriority)),this.selectedSlotDetails.missionId&&(De=De.append("missionId",parseInt(this.selectedSlotDetails.missionId))),this.ofcPostSubscription.unsubscribe(),this.ofcPostSubscription=this.slotBookingService.getFilteredOfcPostList(De).subscribe({next:je=>{this.ofcList=je.filter(B=>B.officeType===this.ofcOrPost);let z=localStorage.getItem("loggedInApplicantUser"),S="OFC"===this.ofcOrPost?JSON.parse(z).ofc:JSON.parse(z).post;S?.length>0&&(this.ofcList=this.ofcList?.filter(B=>S?.some(se=>se.postUserId===B.postUserId))),this.listSlot()},error:je=>{this.selectedOfc="",this.setSlotList([])}})}navMenuClick(De){this.activeSlots=[],this.datesToBeHighlighted=[],this.ofcOrPost=De?"OFC":"POST",this.selectedOfc=
```

---

## [09] getFirstAvailableMonth

**Description :** POST /modifyslot/getFirstAvailableMonth — Premier mois avec créneaux disponibles

**Méthode :** `POST`
**URL :** `/modifyslot/getFirstAvailableMonth`
**Total contextes extraits :** 9

### Appels HTTP trouvés (1)

**Appel #1 — POST**
```js
e/group",h)}listSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotDates",h)}getTimeSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotTime",h)}getAllOfc(){return this.http.get(this.visaAdminUrl+"/ofcuser")}rescheduleAppointment(h){return this.http.put(this.visaAppointment+"/appointments/reschedule",h)}receiptDetails(h){return this.http.post(this.paymentURL+"/receipt/details",h)}getFilteredOfcPostList(h){return this.http.get(this.visaAdminUrl+"/lookupcdt/wizard/getpost",{params:h})}getFirstAvailableMonth(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getFirstAvailableMonth",h)}}return d.\u0275fac=function(h){return new(h||d)(e.LFG(a.eN))},d.\u0275prov=e.Yz7({token:d,factory:d.\u0275fac,providedIn:"root"}),d})()},3728:(Ye,Q,c)=>{"use strict";c.d(Q,{o:()=>l});var i=c(529),e=c(2340),a=c(4650);let l=(()=>{class d{constructor(h){this.http=h,this.visaAppointment=e.N.visaAppointment,this.visaAdmin=e.N.visaAdminURL,this.notifiation=e.N.notificationUrl
```

### Contextes clés (3 sur 8)

**Mot-clé :** `getFirstAvailableMonth`
```js
s.selectedSlotDetails.applicantId,visaType:this.relatedAppList[0].visaType,visaClass:this.relatedAppList[0].visaClass,locationType:this.ofcOrPost,applicationId:this.selectedSlotDetails.applicationId},sessionStorage.setItem("applicantId",this.selectedSlotDetails.applicantId)),this.slotBookingService.getFirstAvailableMonth(S).subscribe({next:B=>{if(B.present){if(this.showCal=!0,!(z&&this.todayDate>new Date(B.date))){const we=new Date(B.date);this.todayDate=we,this.todayDate.setHours(0,0,0,0)}let se={fromDate:this.todayDate>new Date(je)?this.datePipe.transform(this.todayDate,"yyyy-MM-dd"):je,toDate:this.todayDate>new Date(je)?this.datePipe.transform(new Date(this.todayDate.getFullYear(),this.todayDate.getMonth()+1,0),"yyyy-MM-dd"):this.setFromOrToDate(0),postUserId:this.selectedOfc,applicantI
```

**Mot-clé :** `getFirstAvailableMonth`
```js
dminUrl+"/ofcuser")}rescheduleAppointment(h){return this.http.put(this.visaAppointment+"/appointments/reschedule",h)}receiptDetails(h){return this.http.post(this.paymentURL+"/receipt/details",h)}getFilteredOfcPostList(h){return this.http.get(this.visaAdminUrl+"/lookupcdt/wizard/getpost",{params:h})}getFirstAvailableMonth(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getFirstAvailableMonth",h)}}return d.\u0275fac=function(h){return new(h||d)(e.LFG(a.eN))},d.\u0275prov=e.Yz7({token:d,factory:d.\u0275fac,providedIn:"root"}),d})()},3728:(Ye,Q,c)=>{"use strict";c.d(Q,{o:()=>l});var i=c(529),e=c(2340),a=c(4650);let l=(()=>{class d{constructor(h){this.http=h,this.visaAppointment=e.N.visaAppointment,this.visaAdmin=e.N.visaAdminURL,this.notifiation=e.N.notificationUrl}getAppointmentsList(
```

**Mot-clé :** `getFirstAvailableMonth`
```js
intment+"/appointments/reschedule",h)}receiptDetails(h){return this.http.post(this.paymentURL+"/receipt/details",h)}getFilteredOfcPostList(h){return this.http.get(this.visaAdminUrl+"/lookupcdt/wizard/getpost",{params:h})}getFirstAvailableMonth(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getFirstAvailableMonth",h)}}return d.\u0275fac=function(h){return new(h||d)(e.LFG(a.eN))},d.\u0275prov=e.Yz7({token:d,factory:d.\u0275fac,providedIn:"root"}),d})()},3728:(Ye,Q,c)=>{"use strict";c.d(Q,{o:()=>l});var i=c(529),e=c(2340),a=c(4650);let l=(()=>{class d{constructor(h){this.http=h,this.visaAppointment=e.N.visaAppointment,this.visaAdmin=e.N.visaAdminURL,this.notifiation=e.N.notificationUrl}getAppointmentsList(){return this.http.get(this.visaAppointment+"/getlist")}getTemplate(h){return t
```

---

## [10] getSlotDates

**Description :** POST /modifyslot/getSlotDates — Liste des dates avec créneaux disponibles

**Méthode :** `POST`
**URL :** `/modifyslot/getSlotDates`
**Total contextes extraits :** 12

### Appels HTTP trouvés (1)

**Appel #1 — POST**
```js
u0275fac=function(h){return new(h||d)(e.LFG(a.eN))},d.\u0275prov=e.Yz7({token:d,factory:d.\u0275fac,providedIn:"root"}),d})()},4167:(Ye,Q,c)=>{"use strict";c.d(Q,{G:()=>l});var i=c(2340),e=c(4650),a=c(529);let l=(()=>{class d{constructor(h){this.http=h,this.visaAppointment=i.N.visaAppointment,this.visaAdminUrl=i.N.visaAdminURL,this.paymentURL=i.N.paymentURL}bookSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule",h)}bookGroupSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule/group",h)}listSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotDates",h)}getTimeSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotTime",h)}getAllOfc(){return this.http.get(this.visaAdminUrl+"/ofcuser")}rescheduleAppointment(h){return this.http.put(this.visaAppointment+"/appointments/reschedule",h)}receiptDetails(h){return this.http.post(this.paymentURL+"/receipt/details",h)}getFilteredOfcPostList(h){return this.http.get(this.visaAdmin
```

### Contextes clés (3 sur 11)

**Mot-clé :** `getSlotDates`
```js
isaAdminUrl=i.N.visaAdminURL,this.paymentURL=i.N.paymentURL}bookSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule",h)}bookGroupSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule/group",h)}listSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotDates",h)}getTimeSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotTime",h)}getAllOfc(){return this.http.get(this.visaAdminUrl+"/ofcuser")}rescheduleAppointment(h){return this.http.put(this.visaAppointment+"/appointments/reschedule",h)}receiptDetails(h){return this.http.post(this.paymentURL+"/receipt/details",h)}getFilteredOfcPostList(h){return this.http.get(this.visaAdminUrl+"/lookupcdt/wizard/getpost",{params:h})}getFirstAvailableMonth(h){return this.http.post(this.vis
```

**Mot-clé :** `listSlot(`
```js
lot(se)}proceedToNext(De={}){this.wizardFlowYN?this.submitBtnClickEmit.emit(De):(setTimeout(()=>{this.notifierService.notify("Appoinment booking successfully completed","mat-primary")},2e3),this.router.navigate(["../../dashboard"],{relativeTo:this.activatedRouter}))}checkAvailSlot(){this.showCal=!1}listSlot(De=!1){let je=this.setFromOrToDate(1);const Ee=new Date;if(Ee.setDate(Ee.getDate()+1),Ee.setHours(0,0,0,0),new Date(je)<Ee&&(je=this.datePipe.transform(Ee,"yyyy-MM-dd")),!this.selectedOfc)return void this.setSlotList([]);let z=this.rescheduleYN&&this.todayDate>Ee&&"POST"==this.reschedProps?.appointmentLocationType;this.listSlotSubscription.unsubscribe(),this.showCal=!1;let S={};this.conuser?S={postUserId:this.selectedOfc,applicantId:sessionStorage.getItem("applicantId"),visaType:this.re
```

**Mot-clé :** `listSlot(`
```js
Id:sessionStorage.getItem("applicantId"),visaType:this.relatedAppList[0].visaType,visaClass:this.relatedAppList[0].visaClass,locationType:this.ofcOrPost,applicationId:this.selectedSlotDetails.applicationId};De&&(this.lastDateSelected=this.todayDate),this.listSlotSubscription=this.slotBookingService.listSlot(se).subscribe({next:we=>{we.length?(this.initJQuery(),this.setSlotList(we,!0)):(this.initJQuery(),this.setSlotList([]))},error:we=>{we.error&&404===we.error.status&&this.notifierService.notify("Currently, there are no appointments available for the selected location.","mat-warn"),this.initJQuery(),this.setSlotList([])}})}else this.notifierService.notify("Currently, there are no appointments available for the selected location.","mat-warn"),this.showCal=!1},error:B=>{B.error&&404===B.err
```

---

## [11] getSlotTime

**Description :** POST /modifyslot/getSlotTime — Liste des horaires pour une date donnée

**Méthode :** `POST`
**URL :** `/modifyslot/getSlotTime`
**Total contextes extraits :** 22

### Appels HTTP trouvés (1)

**Appel #1 — POST**
```js
ry:d.\u0275fac,providedIn:"root"}),d})()},4167:(Ye,Q,c)=>{"use strict";c.d(Q,{G:()=>l});var i=c(2340),e=c(4650),a=c(529);let l=(()=>{class d{constructor(h){this.http=h,this.visaAppointment=i.N.visaAppointment,this.visaAdminUrl=i.N.visaAdminURL,this.paymentURL=i.N.paymentURL}bookSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule",h)}bookGroupSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule/group",h)}listSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotDates",h)}getTimeSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotTime",h)}getAllOfc(){return this.http.get(this.visaAdminUrl+"/ofcuser")}rescheduleAppointment(h){return this.http.put(this.visaAppointment+"/appointments/reschedule",h)}receiptDetails(h){return this.http.post(this.paymentURL+"/receipt/details",h)}getFilteredOfcPostList(h){return this.http.get(this.visaAdminUrl+"/lookupcdt/wizard/getpost",{params:h})}getFirstAvailableMonth(h){return this.htt
```

### Contextes clés (3 sur 21)

**Mot-clé :** `getSlotTime`
```js
ttp.put(this.visaAppointment+"/appointments/schedule",h)}bookGroupSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule/group",h)}listSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotDates",h)}getTimeSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotTime",h)}getAllOfc(){return this.http.get(this.visaAdminUrl+"/ofcuser")}rescheduleAppointment(h){return this.http.put(this.visaAppointment+"/appointments/reschedule",h)}receiptDetails(h){return this.http.post(this.paymentURL+"/receipt/details",h)}getFilteredOfcPostList(h){return this.http.get(this.visaAdminUrl+"/lookupcdt/wizard/getpost",{params:h})}getFirstAvailableMonth(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getFirstAvailableMonth",h)}}return d.\u0275fac=function(h){ret
```

**Mot-clé :** `getTimeSlot(`
```js
d:sessionStorage.getItem("applicantId"),slotDate:je,visaType:this.relatedAppList[0].visaType,visaClass:this.relatedAppList[0].visaClass,applicationId:this.selectedSlotDetails.applicationId};this.spinner.show(),this.timeSlotSubscription.unsubscribe(),this.timeSlotSubscription=this.slotBookingService.getTimeSlot(Oe).subscribe({next:Ne=>{this.spinner.hide(),this.setTimeList(Ne.length?Ne:[])},error:Ne=>{this.spinner.hide(),this.setTimeList([])}})}setTimeList(De){const je=[];let Ee=["date","startTime","endTime"],z=De.filter((S=new Set,B=>{return se=Ee.map(se=>"date"!=se&&B[se]?B[se].split("T")[1]:B[se]).join("|"),B.startTime&&B.endTime&&new Date(B.endTime)>new Date(B.startTime)&&!S.has(se)&&S.add(se);var se}));var S;for(const S of z){let B=S;B.UICount=De.filter(Ne=>Ne.slotDate==B.slotDate&&Ne.s
```

**Mot-clé :** `getTimeSlot(`
```js
isaAdminURL,this.paymentURL=i.N.paymentURL}bookSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule",h)}bookGroupSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule/group",h)}listSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotDates",h)}getTimeSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotTime",h)}getAllOfc(){return this.http.get(this.visaAdminUrl+"/ofcuser")}rescheduleAppointment(h){return this.http.put(this.visaAppointment+"/appointments/reschedule",h)}receiptDetails(h){return this.http.post(this.paymentURL+"/receipt/details",h)}getFilteredOfcPostList(h){return this.http.get(this.visaAdminUrl+"/lookupcdt/wizard/getpost",{params:h})}getFirstAvailableMonth(h){return this.http.post(this.visaAdminUrl+"/modif
```

---

## [12] bookSlot

**Description :** PUT /appointments/schedule — Réservation du créneau (10 champs exacts)

**Méthode :** `PUT`
**URL :** `/appointments/schedule`
**Total contextes extraits :** 33

### Appels HTTP trouvés (3)

**Appel #1 — GET**
```js
)}setLandingPageDetails(p){this.resetApplicantDetails(),this.landingPageDetails=p}getLandingPageDetails(){return this.landingPageDetails}getAppointmentDashboardDetails(p){return localStorage.setItem("LanguageId",p),this.httpClient.get(e.N.visaAppointment+"/appointments/getLandingPageDeatils")}getRescheduleButtonDetails(){return this.httpClient.get(e.N.visaAppointment+"/appointments/showRescheduleButton")}cancelAppointment(p){return this.httpClient.put(e.N.visaAppointment+"/appointments",p)}rescheduleAppointment(p){}getScheduledappintmentList(p){return this.httpClient.get(e.N.visaAppointment+"/appointments/scheduledappointmentInfo")}getAllSupportTicketDetailsDetails(){const p=localStorage.getItem("loggedInApplicantUser");let y;return p&&(y=JSON.parse(p)),this.httpClient.get(e.N.incidentUrl+"/incident/supportticket?email="+y?.userName)}closeTicket(p,y){return this.httpClient.put(e.N.incidentUrl+"/incident/updateTicketDetails/"+p,y)}UpdateCount(p){return this.httpClient.put(e.N.incidentUr
```

**Appel #2 — PUT**
```js
`/mission/getByCountryCode/${h}`)}getAllDynamicMappingMappingLookups(h,p){return this.http.get(this.visaAdmin+`/lookupcategory/lookupcdt/search/parent/${h}?parentCdt=${p}`)}}return d.\u0275fac=function(h){return new(h||d)(e.LFG(a.eN))},d.\u0275prov=e.Yz7({token:d,factory:d.\u0275fac,providedIn:"root"}),d})()},4167:(Ye,Q,c)=>{"use strict";c.d(Q,{G:()=>l});var i=c(2340),e=c(4650),a=c(529);let l=(()=>{class d{constructor(h){this.http=h,this.visaAppointment=i.N.visaAppointment,this.visaAdminUrl=i.N.visaAdminURL,this.paymentURL=i.N.paymentURL}bookSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule",h)}bookGroupSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule/group",h)}listSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotDates",h)}getTimeSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotTime",h)}getAllOfc(){return this.http.get(this.visaAdminUrl+"/ofcuser")}rescheduleAppointment(h){return this.http.put(this.v
```

**Appel #3 — PUT**
```js
ttp.get(this.visaAdmin+`/lookupcategory/lookupcdt/search/parent/${h}?parentCdt=${p}`)}}return d.\u0275fac=function(h){return new(h||d)(e.LFG(a.eN))},d.\u0275prov=e.Yz7({token:d,factory:d.\u0275fac,providedIn:"root"}),d})()},4167:(Ye,Q,c)=>{"use strict";c.d(Q,{G:()=>l});var i=c(2340),e=c(4650),a=c(529);let l=(()=>{class d{constructor(h){this.http=h,this.visaAppointment=i.N.visaAppointment,this.visaAdminUrl=i.N.visaAdminURL,this.paymentURL=i.N.paymentURL}bookSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule",h)}bookGroupSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule/group",h)}listSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotDates",h)}getTimeSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotTime",h)}getAllOfc(){return this.http.get(this.visaAdminUrl+"/ofcuser")}rescheduleAppointment(h){return this.http.put(this.visaAppointment+"/appointments/reschedule",h)}receiptDetails(h){return this.http.post(th
```

### Contextes clés (3 sur 30)

**Mot-clé :** `bookSlot(`
```js
.selectedItems.filter(je=>1==je.isChecked&&(0==je.isDisabled||this.reschedProps&&this.reschedProps.appointmentUUID));0!=De.length?De&&De.length>this.selectedSlot.UICount?this.notifierService.notify("Selected time slots don't have enough availability to book the selected applicant.","mat-warn"):this.bookSlot():this.notifierService.notify("Select a applicant","mat-warn")}bookSlot(){if(!this.selectedSlot)return;const De=this.selectedSlotDetails.appointmentId?this.selectedSlotDetails.appointmentId:sessionStorage.getItem("appointmentId");let Ee=parseInt(De,10);const z=this.selectedSlotDetails.applicantUUID?this.selectedSlotDetails.applicantUUID:sessionStorage.getItem("applicantUUID");let B=parseInt(z,10),se={appointmentId:this.selectedSlotDetails.appointmentId?this.selectedSlotDetails.appointme
```

**Mot-clé :** `bookSlot(`
```js
edProps&&this.reschedProps.appointmentUUID));0!=De.length?De&&De.length>this.selectedSlot.UICount?this.notifierService.notify("Selected time slots don't have enough availability to book the selected applicant.","mat-warn"):this.bookSlot():this.notifierService.notify("Select a applicant","mat-warn")}bookSlot(){if(!this.selectedSlot)return;const De=this.selectedSlotDetails.appointmentId?this.selectedSlotDetails.appointmentId:sessionStorage.getItem("appointmentId");let Ee=parseInt(De,10);const z=this.selectedSlotDetails.applicantUUID?this.selectedSlotDetails.applicantUUID:sessionStorage.getItem("applicantUUID");let B=parseInt(z,10),se={appointmentId:this.selectedSlotDetails.appointmentId?this.selectedSlotDetails.appointmentId:Ee,applicantUUID:this.selectedSlotDetails.applicantUUID?this.select
```

**Mot-clé :** `bookSlot(`
```js
!1,this.conuser||this.showOFAppointmentConfigurableGap()}})}checkReceipt(De){if(De&&De.length>0){let je=De.find(Ee=>"POST"==Ee.appointmentLocationType&&"Active"==Ee.receiptStatus);this.showCalender=!!je,this.showCalenderText=!je}}initScheduleOps(De){this.sharedService.show(),this.slotBookingService.bookSlot(De).subscribe({next:je=>{this.sharedService.hide(),this.isBookSlot=!0,this.savedSlot=je;let Ee="";this.ofcBookingIgnoreYN?(this.lastProcessedBiomtricYN=!0,Ee="POST Appointment booking completed for Applicant"):(this.lastProcessedBiomtricYN=!1,Ee="POST, OFC Appointment booking completed for Applicant"),this.notifierService.notify(Ee,"mat-primary"),this.selectedSlotDetails=null,this.postlimitByConfig=null,this.rescheduleSlots=[],this.appointmentPayload=[],this.lastDateSelected=new Date,th
```

---

## [13] rescheduleAppointment

**Description :** PUT /appointments/reschedule — Reprogrammation d'un RDV existant

**Méthode :** `PUT`
**URL :** `/appointments/reschedule`
**Total contextes extraits :** 9

### Appels HTTP trouvés (1)

**Appel #1 — PUT**
```js
uctor(h){this.http=h,this.visaAppointment=i.N.visaAppointment,this.visaAdminUrl=i.N.visaAdminURL,this.paymentURL=i.N.paymentURL}bookSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule",h)}bookGroupSlot(h){return this.http.put(this.visaAppointment+"/appointments/schedule/group",h)}listSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotDates",h)}getTimeSlot(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getSlotTime",h)}getAllOfc(){return this.http.get(this.visaAdminUrl+"/ofcuser")}rescheduleAppointment(h){return this.http.put(this.visaAppointment+"/appointments/reschedule",h)}receiptDetails(h){return this.http.post(this.paymentURL+"/receipt/details",h)}getFilteredOfcPostList(h){return this.http.get(this.visaAdminUrl+"/lookupcdt/wizard/getpost",{params:h})}getFirstAvailableMonth(h){return this.http.post(this.visaAdminUrl+"/modifyslot/getFirstAvailableMonth",h)}}return d.\u0275fac=function(h){return new(h||d)(e.LFG(a.eN))},d.\u0275prov=e.Yz7(
```

### Contextes clés (3 sur 8)

**Mot-clé :** `rescheduleAppointment`
```js
lectedSlotDetails="",this.allSlots=[],"OFC"===this.reschedProps.appointmentLocationType&&"POST"===this.ofcOrPost?(this.relatedAppList.shift(),this.slotDetailsAndShowSlotsandTab()):this.initRescheduleAPI(this.appointmentPayload)}initRescheduleAPI(De){this.sharedService.show(),this.slotBookingService.rescheduleAppointment(De).subscribe({next:je=>{this.sharedService.hide(),this.isBookSlot=!0,this.savedSlot=je,je&&je.length>0&&this.notifierService.notify(je[0].responseMsg,"mat-primary"),this.router.navigate(["../../dashboard"],{relativeTo:this.activatedRouter}),this.conuser=!1},error:je=>{this.sharedService.hide(),this.savedSlot=null,this.isBookSlot=!1,502===je.status&&je.error?(this.notifierService.notify(je.error.responseMessage,"mat-warn"),this.appointmentPayload=[]):409===je.status&&je.err
```

**Mot-clé :** `rescheduleAppointment`
```js
ed=!0,B.isDisabled=!0)}),this.selectedItems&&this.reschedProps&&this.reschedProps.appointmentUUID){let B=this.selectedItems.find(se=>""!=se.appointmentUUID);B&&(this.applicantData=this.applicantData.filter(se=>se.applicantId==B.applicantId),this.selectedItems=[B])}Ee.length>0?this.rescheduleYN?this.rescheduleAppointmentFlow(Ee):"IV"===this.relatedAppList[0].visaType?this.checkForUpdationFlag||"NO"!==this.metaData.keepOriginalAppointmentkey?this.resetFieldsAndInitFlow(Ee):(this.checkForUpdationFlag=!0,this.ivAppointmentSubscription.unsubscribe(),this.ivAppointmentSubscription=this.appointmentService.checkForIVAppointmentUpdation(this.applicationId).subscribe({next:B=>{"Successfully updated"===B.message?this.loadApplicationDetails(De):this.resetFieldsAndInitFlow(Ee)},error:B=>{this.resetFiel
```

**Mot-clé :** `rescheduleAppointment`
```js
ate=null,this.conuser=!0,this.notifierService.notify(je.error.responseMessage,"mat-warn"),this.appointmentPayload=[],this.onChangeSlotSelection(sessionStorage.getItem("postOfc"))):(this.notifierService.notify("Something went wrong. please try again later.","mat-warn"),this.appointmentPayload=[])}})}rescheduleAppointmentFlow(De){if("OFC"===this.reschedProps.appointmentLocationType){const je={...De[0]};je.appointmentLocationType="POST",this.relatedAppList=[je].concat(De)}else this.relatedAppList=De;this.slotDetailsAndShowSlotsandTab()}onClickTab(De){if("POST"===De&&"OFC"===this.ofcOrPost){const Ee={title:"Confirmation",message:this.langPipe.transform("The selected slot details will be cleared. Do you want to continue.?",this.wizardCommonLangProperties,"The selected slot details will be clear
```

---

## [14] httpInterceptor

**Description :** Intercepteur Angular — headers ajoutés automatiquement sur toutes les requêtes authentifiées

**Méthode :** `ALL`
**URL :** `Intercepteur global`
**Total contextes extraits :** 12

### Contextes clés (3 sur 12)

**Mot-clé :** `tokenStorage.getToken()`
```js
50),l=c(284);let d=(()=>{class _{constructor(p,y){this.http=p,this.tokenStorage=y,this.profileUrl=e.N.visaAppPortalURL,this.appuser=e.N.visaApplicantUser,this.lookupCode=e.N.visaAdminURL,this.visaWorkFlow=e.N.visaWorkFlowURL,this.visaApplication=e.N.visaApplicationURL}changepassword(p){const y=this.tokenStorage.getToken();let w=new i.WM({Authorization:`Bearer ${y}`});return this.http.put(this.profileUrl+"/changePassword",{password:btoa(p)},{headers:w})}getAppliUser(p){return this.http.get(this.appuser+"getByLoginUser/"+p)}getApplicantUser(p){return this.http.get(this.appuser+"getByUserId/"+p)}getApplication(p){return this.http.post(this.lookupCode+"/dossier/search/new",p)}changefullName(p,y){return this.http.put(this.profileUrl+"/profile",p)}getprivacy(p){return this.http.get(this.profileU
```

**Mot-clé :** `tokenStorage.getToken()`
```js
tor(v,j,Ce,Ue){this.tokenStorage=v,this.spinner=j,this._router=Ce,this.sheredSer=Ue}generateCorrelationId(){const v="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";let j="";for(let Ce=0;Ce<15;Ce++)j+=v.charAt(Math.floor(Math.random()*v.length));return j}intercept(v,j){const Ce=this.tokenStorage.getToken();if(!(null==Ce||v.url.endsWith("/forgotPassword")||v.url.endsWith("/user/login")||v.url.endsWith("/refreshToken")||v.url.includes("/api/supports?filters")))if(v.url.includes("/document/docSave")||v.url.includes("/history/upload")||v.url.includes("/incidentinquirydocuments/docSave")||v.url.includes("incident/saveTicketDetails")||v.url.endsWith("/incidentNote")||v.url.endsWith("/requestSave"))v=v.clone({setHeaders:{Authorization:`Bearer ${Ce}`,Accept:"multipart/form-data,app
```

**Mot-clé :** `Bearer ${Ce}`
```js
api/supports?filters")))if(v.url.includes("/document/docSave")||v.url.includes("/history/upload")||v.url.includes("/incidentinquirydocuments/docSave")||v.url.includes("incident/saveTicketDetails")||v.url.endsWith("/incidentNote")||v.url.endsWith("/requestSave"))v=v.clone({setHeaders:{Authorization:`Bearer ${Ce}`,Accept:"multipart/form-data,application/json","X-Correlation-key":this.generateCorrelationId()}});else if(!v.url.includes("/changePassword"))if(v.url.includes("/getLandingPageDeatils")||v.url.includes("/generatewizardtemplate")){let Ue=localStorage.getItem("LanguageId");v=v.clone({setHeaders:{Authorization:`Bearer ${Ce}`,"Content-Type":"application/json",LanguageId:`${Ue}`,"X-Correlation-key":this.generateCorrelationId()}})}else v=v.clone({setHeaders:{Authorization:`Bearer ${Ce}`,"
```

---

## [15] sanityCheck

**Description :** GET — Vérification état du workflow (FCS payment check) avant réservation

**Méthode :** `GET`
**URL :** `TBD — voir contexte`
**Total contextes extraits :** 17

### Appels HTTP trouvés (2)

**Appel #1 — GET**
```js
xt"})}deleteApplicantById(y,w){return this.http.get(l.N.visaWorkFlowURL+`/workflow/deleteApplicant/${y}/${w}`,{observe:"response",responseType:"text"})}setLastLoadedRequestId(y){this.setCookieByDeleteOld("REQUEST_ID_IN_DISP",y)}getLastLoadedRequestId(){return this.getCookieById("REQUEST_ID_IN_DISP")}getLastLoadedScreenYN(){return this._loadLastLoadedScreenYN}setLastLoadedScreenYN(y){this._loadLastLoadedScreenYN=y}getPreApplicationData(y,w){return this.http.get(this.visaWorkFlowURL+`/stepdata/getApplicationMetaData/${y}`)}getLivepayNeeded(y){return this.http.get(this.visaWorkFlowURL+`/workflow/isLivepayAvailable/${y}`)}getAllOfcByMissionId(y){return this.http.get(this.addofcurl+"/ofcuser/ofclist/"+y)}caseIdVerifyByAppId(y){return this.http.post(this.visaWorkFlowURL+"/stepdata/getPaymentReceiptNumber",{},{params:y})}savePreapprovalRequest(y){return this.http.post(this.visaAdminURL+"/appointmentrequest/requestSave",y)}addPreapprovalDocuments(y,w){return this.http.post(this.visaAdminURL+"/
```

**Appel #2 — DELETE**
```js
tificationUrl}/template/generatewizardtemplate`,y,{headers:w,observe:"response",responseType:"blob"})}generateWizardOTP(y){return this.http.post(`${this.roleUrl}/mfa/mfacreate`,{},{params:y})}validateeWizardOTP(y){return this.http.post(`${this.roleUrl}/mfa/verifymfa`,{},{params:y})}verifyapplicantage(y){return this.http.post(`${this.visaWorkFlowURL}/stepdata/verifyapplicantage`,y,{observe:"response",responseType:"text"})}setCookieByDeleteOld(y,w,f=1){this.cookieService.set(y,w,f,l.N.baseHref)}getCookieById(y){return this.cookieService.get(y)}removeCookie(y){return this.cookieService.delete(y)}checkForPendingAppointmentApplicant(y){return this.http.post(l.N.viewApplicantURL+"/applicationassociations/getapplicantappointmentstatus",y)}getkeepOriginalAppointment(y,w){return this.http.get(l.N.visaAppointment+"/appointments/setDefaultNumericalSlot/"+y)}getFieldConfig(y){return this.http.get(`${l.N.getConfig}${y}`)}validate(y,w){return this.http.post(`${l.N.ds160Validate}${y}`,{ceac:w})}}retu
```

### Contextes clés (3 sur 15)

**Mot-clé :** `checkForPendingAppointmentApplicant`
```js
e(y){return this.http.post(`${this.visaWorkFlowURL}/stepdata/verifyapplicantage`,y,{observe:"response",responseType:"text"})}setCookieByDeleteOld(y,w,f=1){this.cookieService.set(y,w,f,l.N.baseHref)}getCookieById(y){return this.cookieService.get(y)}removeCookie(y){return this.cookieService.delete(y)}checkForPendingAppointmentApplicant(y){return this.http.post(l.N.viewApplicantURL+"/applicationassociations/getapplicantappointmentstatus",y)}getkeepOriginalAppointment(y,w){return this.http.get(l.N.visaAppointment+"/appointments/setDefaultNumericalSlot/"+y)}getFieldConfig(y){return this.http.get(`${l.N.getConfig}${y}`)}validate(y,w){return this.http.post(`${l.N.ds160Validate}${y}`,{ceac:w})}}return h.\u0275fac=function(y){return new(y||h)(e.LFG(i.eN),e.LFG(d.N))},h.\u0275prov=e.Yz7({token:h,fac
```

**Mot-clé :** `checkForPendingAppointmentApplicant`
```js
OfBirth:oe.dateOfBirth,countryOfBirth:oe.countryOfBirth?.key,dsConfirmationNumber:oe.dsConfirmationNumber,pptNum:oe.passportNumber,applicationId:this.appRenderService.getCookieById("APP_ID_TOBE"),visaCategory:this.appDetails.visaCategorykey,missionId:this.appDetails.missionId};this.appRenderService.checkForPendingAppointmentApplicant(Se).subscribe({next:Ge=>{"duplicate"===Ge.status?(this.router.navigate(["../../dashboard"],{relativeTo:this.route}),this.notifierService.notify(Ge.message?Ge.message:"You already have a scheduled appointment for the future.","mat-warn")):this.submitBtnClickEmit.emit({data:T})},error:Ge=>{}})}ngOnChanges(T){if(!T.metaDataDetails?.previousValue&&T.metaDataDetails?.currentValue&&!this.stepFormValue){var oe=localStorage.getItem("display_requestId")??"";this.loadFo
```

**Mot-clé :** `slotBooking`
```js
l",De.sectionsDetails[0])("fieldsList",De.sectionsDetails[0].fields)("stepDetails",De.stepDetails)("formType",De.formType)("stepFormValue",De.stepFormValue)("wizardCommonLangProperties",De.wizardCommonLangProperties)}}let Tt=(()=>{class Pt{constructor(De,je,Ee,z,S,B,se,we,Le,Oe,Ne,lt,Et,Wt,dt){this.slotBookingService=De,this.renderer=je,this.appointmentService=Ee,this.router=z,this.activatedRouter=S,this.notifierService=B,this.spinner=se,this.adminServie=we,this.dialog=Le,this.datePipe=Oe,this.renderService=Ne,this.sidebarLangService=lt,this.sharedLanguageCodeService=Et,this.langPipe=Wt,this.sharedService=dt,this.wizardCommonLangProperties=[],this.primaryButtonStatus=!0,this.metaDataDetails={},this.submitBtnClickEmit=new a.vpe,this.cancelBtnClickEmit=new a.vpe,this.componentAfterInit=new a
```

---

## [16] appointmentLetter

**Description :** POST /template/appointmentLetter — Génération du document de confirmation

**Méthode :** `POST`
**URL :** `/template/appointmentLetter`
**Total contextes extraits :** 4

### Appels HTTP trouvés (1)

**Appel #1 — POST**
```js
ointmentrequest/getallbyuserid?userId=${h}&type=GROUPREQUEST`;return"ADMIN"!==p.userType&&(y=this.visaAdmin+"/appointmentrequest/getallbyuser?type=GROUPREQUEST"),this.http.get(y)}getAppointmentDashboardDetails(){return this.http.get(e.N.visaAppointment+"/appointment/getLandingPageDeatils")}getIWpaymentDetails(h){return this.http.get(e.N.visaWorkFlowURL+"/workflow/status/complete/"+h)}updateAppointmentInformation(h){return this.http.put(e.N.visaAppointment+"/appointments",h)}downloadAppointment(h){const p=new i.WM({accept:"application/pdf"});return this.http.post(e.N.notificationUrl+"/template/appointmentLetter",h,{headers:p,observe:"response",responseType:"blob"})}searcApplicationDetails(h){return this.http.post(e.N.visaAppointment+"/appointments/search",h)}cancelAppointment(h){return this.http.put(`${e.N.visaAppointment}/appointments/cancellation`,h)}getLookUptext(h,p){return this.http.get(this.visaAdmin+`/lookupcdt/getbylangandcode?lookUpCode=${h}&langId=${p}`,{responseType:"text"})}
```

### Contextes clés (3 sur 3)

**Mot-clé :** `appointmentLetter`
```js
entDetails(h){return this.http.get(e.N.visaWorkFlowURL+"/workflow/status/complete/"+h)}updateAppointmentInformation(h){return this.http.put(e.N.visaAppointment+"/appointments",h)}downloadAppointment(h){const p=new i.WM({accept:"application/pdf"});return this.http.post(e.N.notificationUrl+"/template/appointmentLetter",h,{headers:p,observe:"response",responseType:"blob"})}searcApplicationDetails(h){return this.http.post(e.N.visaAppointment+"/appointments/search",h)}cancelAppointment(h){return this.http.put(`${e.N.visaAppointment}/appointments/cancellation`,h)}getLookUptext(h,p){return this.http.get(this.visaAdmin+`/lookupcdt/getbylangandcode?lookUpCode=${h}&langId=${p}`,{responseType:"text"})}getVisafeeByVisaclass(h,p,y){return this.http.get(this.visaAdmin+`/visafee/getvisaClass?visaClassCod
```

**Mot-clé :** `appointmentLetter`
```js
onentAfterInit=new e.vpe,this.srcarray=[],this.documetIsImage=!1}ngOnInit(){this.appIdToBe=this.renderService.getCookieById("APP_ID_TOBE"),this.missionId=this.renderService.getCookieById("missionId"),this.callSanityAndContinue()}callSanityAndContinue(){this.sharedservice.sanityCheck(this.appIdToBe,"appointmentLetter").subscribe({next:T=>{},error:T=>{}}).add(()=>{this.continueFlow()})}continueFlow(){this.proceedToNextStep()}onClickSubmitBtn(T){this.submitBtnClickEmit.emit(T)}onClickCancelBtn(){this.cancelBtnClickEmit.emit()}ngAfterViewInit(){this.componentAfterInit.emit("INITIALIZED"),this.generateTemaple(this.stepDetails.wizStepTemplateName)}setData(T,oe){this.setPaData=T,this.src=oe,this.srcarray=this.src.split("/"),this.docname=this.srcarray[this.srcarray.length-1],this.doctype=this.docn
```

**Mot-clé :** `downloadAppointment`
```js
getAppointmentDashboardDetails(){return this.http.get(e.N.visaAppointment+"/appointment/getLandingPageDeatils")}getIWpaymentDetails(h){return this.http.get(e.N.visaWorkFlowURL+"/workflow/status/complete/"+h)}updateAppointmentInformation(h){return this.http.put(e.N.visaAppointment+"/appointments",h)}downloadAppointment(h){const p=new i.WM({accept:"application/pdf"});return this.http.post(e.N.notificationUrl+"/template/appointmentLetter",h,{headers:p,observe:"response",responseType:"blob"})}searcApplicationDetails(h){return this.http.post(e.N.visaAppointment+"/appointments/search",h)}cancelAppointment(h){return this.http.put(`${e.N.visaAppointment}/appointments/cancellation`,h)}getLookUptext(h,p){return this.http.get(this.visaAdmin+`/lookupcdt/getbylangandcode?lookUpCode=${h}&langId=${p}`,{r
```

---

## [17] csrfAndCookies

**Description :** Mécanismes CSRF (CookieName, XSRF-TOKEN) et cookies (APP_ID_TOBE, missionId, applicantId)

**Méthode :** `N/A`
**URL :** `Mécanique transversale`
**Total contextes extraits :** 96

### Contextes clés (3 sur 96)

**Mot-clé :** `XSRF-TOKEN`
```js
ntent-Type":"application/json",LanguageId:`${Ue}`,"X-Correlation-key":this.generateCorrelationId()}})}else v=v.clone({setHeaders:{Authorization:`Bearer ${Ce}`,"Content-Type":"application/json","X-Correlation-key":this.generateCorrelationId()}});if(v.url.endsWith("/portal/changePassword")){const Ue="XSRF-TOKEN",bt=localStorage.getItem("CSRFTOKEN");v=v.clone({setHeaders:{CookieName:`${Ue}=${bt}`}})}if("PUT"==v.method||v.url.endsWith("/portal/changePassword")){const Ue="XSRF-TOKEN",bt=localStorage.getItem("CSRFTOKEN");v=v.clone({setHeaders:{CookieName:`${Ue}=${bt}`}})}return j.handle(v)}}return ae.\u0275fac=function(v){return new(v||ae)(e.LFG(ht.i),e.LFG(ir.t2),e.LFG(a.F0),e.LFG(d.F))},ae.\u0275prov=e.Yz7({token:ae,factory:ae.\u0275fac}),ae})();var ms=c(4004),Xa=c(262),Ls=c(9646),rl=c(2843);l
```

**Mot-clé :** `XSRF-TOKEN`
```js
":"application/json","X-Correlation-key":this.generateCorrelationId()}});if(v.url.endsWith("/portal/changePassword")){const Ue="XSRF-TOKEN",bt=localStorage.getItem("CSRFTOKEN");v=v.clone({setHeaders:{CookieName:`${Ue}=${bt}`}})}if("PUT"==v.method||v.url.endsWith("/portal/changePassword")){const Ue="XSRF-TOKEN",bt=localStorage.getItem("CSRFTOKEN");v=v.clone({setHeaders:{CookieName:`${Ue}=${bt}`}})}return j.handle(v)}}return ae.\u0275fac=function(v){return new(v||ae)(e.LFG(ht.i),e.LFG(ir.t2),e.LFG(a.F0),e.LFG(d.F))},ae.\u0275prov=e.Yz7({token:ae,factory:ae.\u0275fac}),ae})();var ms=c(4004),Xa=c(262),Ls=c(9646),rl=c(2843);let _s=(()=>{class ae{constructor(v,j,Ce,Ue,bt,Mt,Ut){this.notifierService=v,this.spinner=j,this._router=Ce,this.token=Ue,this.authService=bt,this.route=Mt,this.sheredSer=Ut
```

**Mot-clé :** `XSRF-TOKEN`
```js
ame?{provide:yt,useValue:Ne.cookieName}:[],Ne.headerName?{provide:Tt,useValue:Ne.headerName}:[]]}}}return Le.\u0275fac=function(Ne){return new(Ne||Le)},Le.\u0275mod=e.oAB({type:Le}),Le.\u0275inj=e.cJS({providers:[De,{provide:ht,useExisting:De,multi:!0},{provide:Pt,useClass:Xt},{provide:yt,useValue:"XSRF-TOKEN"},{provide:Tt,useValue:"X-XSRF-TOKEN"}]}),Le})(),B=(()=>{class Le{}return Le.\u0275fac=function(Ne){return new(Ne||Le)},Le.\u0275mod=e.oAB({type:Le}),Le.\u0275inj=e.cJS({providers:[Qe,{provide:p,useClass:je},at,{provide:y,useExisting:at}],imports:[S.withOptions({cookieName:"XSRF-TOKEN",headerName:"X-XSRF-TOKEN"})]}),Le})()},4650:(Ye,Q,c)=>{"use strict";c.d(Q,{$8M:()=>qa,$Z:()=>mm,AFp:()=>x0,ALo:()=>Ug,AaK:()=>p,AsE:()=>ip,BQk:()=>Ed,CHM:()=>hs,CRH:()=>e0,CZH:()=>jd,CqO:()=>s_,D6c:()=>
```

---

## [18] cryptoEncryption

**Description :** Chiffrement AES-256-CBC des credentials (PBKDF2 SHA1, 1000 iter, 32 bytes)

**Méthode :** `N/A`
**URL :** `Bibliothèque interne`
**Total contextes extraits :** 21

### Contextes clés (3 sur 21)

**Mot-clé :** `PBKDF2`
```js
ations=1e3,this.encSecKey="",this.encSecKey=a.N.encSecKey}encrypt(p,y=this.encSecKey){const w=i.lib.WordArray.random(16),f=this.getKey(y,w),E=i.lib.WordArray.random(16),D=i.AES.encrypt(p,f,{iv:E,mode:i.mode.CBC,padding:i.pad.Pkcs7});return w.toString()+E.toString()+D.toString()}getKey(p,y){return i.PBKDF2(p,y,{keySize:8,iterations:1e3})}decrypt(p,y=this.encSecKey){const w=i.enc.Hex.parse(p.substr(0,32)),f=i.enc.Hex.parse(p.substr(32,32)),E=p.substring(64),D=this.getKey(y,w);return i.AES.decrypt(E,D,{iv:f,mode:i.mode.CBC,padding:i.pad.Pkcs7}).toString(i.enc.Utf8)}}return _.\u0275fac=function(p){return new(p||_)},_.\u0275prov=l.Yz7({token:_,factory:_.\u0275fac,providedIn:"root"}),_})()},6477:(Ye,Q,c)=>{"use strict";c.d(Q,{b:()=>l});var i=c(2340),e=c(4650),a=c(529);let l=(()=>{class d{constru
```

**Mot-clé :** `PBKDF2`
```js
es+=l-(e.sigBytes%l||l)},unpad:function(e){var a=e.words,l=e.sigBytes-1;for(l=e.sigBytes-1;l>=0;l--)if(a[l>>>2]>>>24-l%4*8&255){e.sigBytes=l+1;break}}},i.pad.ZeroPadding)},8812:function(Ye,Q,c){var e,a,l,d,_,p,y,i;Ye.exports=(i=c(7585),c(5162),c(3764),d=(a=(e=i).lib).WordArray,p=(_=e.algo).HMAC,y=_.PBKDF2=(l=a.Base).extend({cfg:l.extend({keySize:4,hasher:_.SHA1,iterations:1}),init:function(w){this.cfg=this.cfg.extend(w)},compute:function(w,f){for(var E=this.cfg,D=p.create(E.hasher,w),x=d.create(),k=d.create([1]),K=x.words,H=k.words,I=E.keySize,A=E.iterations;K.length<I;){var F=D.update(f).finalize(k);D.reset();for(var G=F.words,O=G.length,L=F,J=1;J<A;J++){L=D.finalize(L),D.reset();for(var X=L.words,ie=0;ie<O;ie++)G[ie]^=X[ie]}x.concat(F),H[0]++}return x.sigBytes=4*I,x}}),e.PBKDF2=function(
```

**Mot-clé :** `PBKDF2`
```js
r,w),x=d.create(),k=d.create([1]),K=x.words,H=k.words,I=E.keySize,A=E.iterations;K.length<I;){var F=D.update(f).finalize(k);D.reset();for(var G=F.words,O=G.length,L=F,J=1;J<A;J++){L=D.finalize(L),D.reset();for(var X=L.words,ie=0;ie<O;ie++)G[ie]^=X[ie]}x.concat(F),H[0]++}return x.sigBytes=4*I,x}}),e.PBKDF2=function(w,f,E){return y.create(E).compute(w,f)},i.PBKDF2)},3544:function(Ye,Q,c){var i;Ye.exports=(i=c(7585),c(8319),c(9493),c(7865),c(3057),function(){var e=i,l=e.lib.StreamCipher,_=[],h=[],p=[],y=e.algo.RabbitLegacy=l.extend({_doReset:function(){var f=this._key.words,E=this.cfg.iv,D=this._X=[f[0],f[3]<<16|f[2]>>>16,f[1],f[0]<<16|f[3]>>>16,f[2],f[1]<<16|f[0]>>>16,f[3],f[2]<<16|f[1]>>>16],x=this._C=[f[2]<<16|f[2]>>>16,4294901760&f[0]|65535&f[1],f[3]<<16|f[3]>>>16,4294901760&f[1]|65535&f[
```

---

## [19] bookSlotPayloadConstruction

**Description :** Détail complet de la construction du payload PUT /schedule : bookSlot() + initBookSlot()

**Méthode :** `N/A`
**URL :** `Construction payload`
**Total contextes extraits :** 10

### Contextes clés (3 sur 10)

**Mot-clé :** `bookSlot(){`
```js
edProps&&this.reschedProps.appointmentUUID));0!=De.length?De&&De.length>this.selectedSlot.UICount?this.notifierService.notify("Selected time slots don't have enough availability to book the selected applicant.","mat-warn"):this.bookSlot():this.notifierService.notify("Select a applicant","mat-warn")}bookSlot(){if(!this.selectedSlot)return;const De=this.selectedSlotDetails.appointmentId?this.selectedSlotDetails.appointmentId:sessionStorage.getItem("appointmentId");let Ee=parseInt(De,10);const z=this.selectedSlotDetails.applicantUUID?this.selectedSlotDetails.applicantUUID:sessionStorage.getItem("applicantUUID");let B=parseInt(z,10),se={appointmentId:this.selectedSlotDetails.appointmentId?this.selectedSlotDetails.appointmentId:Ee,applicantUUID:this.selectedSlotDetails.applicantUUID?this.select
```

**Mot-clé :** `this.selectedSlot.slotId`
```js
antUUID");let B=parseInt(z,10),se={appointmentId:this.selectedSlotDetails.appointmentId?this.selectedSlotDetails.appointmentId:Ee,applicantUUID:this.selectedSlotDetails.applicantUUID?this.selectedSlotDetails.applicantUUID:B,appointmentLocationType:this.ofcOrPost,appointmentStatus:"SCHEDULED",slotId:this.selectedSlot.slotId,appointmentDt:this.selectedSlot.slotDate,appointmentTime:this.selectedSlot.UItime};this.selectedDateRange="",this.rescheduleYN?this.initRescheduleSlot(se):this.initBookSlot(se)}proceedToNext(De={}){this.wizardFlowYN?this.submitBtnClickEmit.emit(De):(setTimeout(()=>{this.notifierService.notify("Appoinment booking successfully completed","mat-primary")},2e3),this.router.navigate(["../../dashboard"],{relativeTo:this.activatedRouter}))}checkAvailSlot(){this.showCal=!1}listSl
```

**Mot-clé :** `this.selectedSlot.slotDate`
```js
intmentId:this.selectedSlotDetails.appointmentId?this.selectedSlotDetails.appointmentId:Ee,applicantUUID:this.selectedSlotDetails.applicantUUID?this.selectedSlotDetails.applicantUUID:B,appointmentLocationType:this.ofcOrPost,appointmentStatus:"SCHEDULED",slotId:this.selectedSlot.slotId,appointmentDt:this.selectedSlot.slotDate,appointmentTime:this.selectedSlot.UItime};this.selectedDateRange="",this.rescheduleYN?this.initRescheduleSlot(se):this.initBookSlot(se)}proceedToNext(De={}){this.wizardFlowYN?this.submitBtnClickEmit.emit(De):(setTimeout(()=>{this.notifierService.notify("Appoinment booking successfully completed","mat-primary")},2e3),this.router.navigate(["../../dashboard"],{relativeTo:this.activatedRouter}))}checkAvailSlot(){this.showCal=!1}listSlot(De=!1){let je=this.setFromOrToDate(1
```

---

## [20] tokenStorage

**Description :** Gestion des tokens (saveToken/getToken/removeToken via sessionStorage)

**Méthode :** `N/A`
**URL :** `SessionStorage interne`
**Total contextes extraits :** 29

### Contextes clés (3 sur 29)

**Mot-clé :** `saveToken(`
```js
thorization:"Basic "+this.cryptoService.encrypt(H.username+":"+H.password)};return this.http.post(`${d.N.authenticationURL}/login`,A,{headers:I,observe:"response"}).pipe((0,e.U)(F=>(200==F.status&&(this.csrfToken=F.headers.get("Csrftoken"),localStorage.setItem("CSRFTOKEN",this.csrfToken),this.token.saveToken(F.headers.get("Authorization")),this.token.setRefreshToken(F.headers.get("refreshtoken")),F.body.userType="APPLICANT",localStorage.setItem("loggedInApplicantUser",JSON.stringify(F.body)),this.setIdleTimeOut()),F)))}logoutUser(){return this.http.post(`${d.N.authenticationURL}/logout`,null,{responseType:"text"})}get currentUserValue(){let H=localStorage.getItem("loggedInApplicantUser");return H&&(H=JSON.parse(H)),H}forgotPassword(H){const I=d.N.visaAppPortalURL+"/forgotPassword";let A=ne
```

**Mot-clé :** `saveToken(`
```js
ssword:H},{headers:F})}resetPasswordForApp(H,I){let A=d.N.visaAppPortalURL+"/temporaryPasswordChange";const F=new i.WM({Authorization:"Basic "+this.cryptoService.encrypt(I+":"+H)});return this.http.post(A,null,{headers:F,observe:"response"}).pipe((0,e.U)(G=>(200==G.status&&!G.body?.mfa&&(this.token.saveToken(G.headers.get("Authorization")),this.token.setRefreshToken(G.headers.get("refreshtoken")),localStorage.setItem("loggedInApplicantUser",JSON.stringify(G.body)),this.setIdleTimeOut()),G)))}forceLogoutUser(H=!1){this.dashboardService.resetApplicantDetails(),this.token.removeToken(),["loggedInApplicantUser","isExpdite","showedPasswordpopup","stateCode","countryCode","GROUPDETAILS","APP_POSTOFC","_expiredTimeApplicant","forceLogoutApplicant","LanguageId","paymenUrl","docDeliveryApplication"
```

**Mot-clé :** `saveToken(`
```js
})}varifyMfa(H,I){const A=new i.WM({Authorization:"Basic "+this.cryptoService.encrypt(I.username+":"+I.password),userType:"applicant",mfa:H.mfa});return this.http.post(`${d.N.authenticationURL}/verifyMfa`,null,{headers:A,observe:"response"}).pipe((0,e.U)(F=>(200==F.status&&!F.body?.mfa&&(this.token.saveToken(F.headers.get("Authorization")),this.token.setRefreshToken(F.headers.get("refreshtoken")),localStorage.setItem("loggedInUser",JSON.stringify(F.body)),localStorage.setItem("loggedInApplicantUser",JSON.stringify(F.body)),this.setIdleTimeOut()),F)))}}return k.\u0275fac=function(H){return new(H||k)(h.LFG(i.eN),h.LFG(p.i),h.LFG(y.F0),h.LFG(w.l),h.LFG(f.uw),h.LFG(E.$),h.LFG(D.L))},k.\u0275prov=h.Yz7({token:k,factory:k.\u0275fac,providedIn:"root"}),k})()},2783:(Ye,Q,c)=>{"use strict";c.d(Q,{L
```

---
