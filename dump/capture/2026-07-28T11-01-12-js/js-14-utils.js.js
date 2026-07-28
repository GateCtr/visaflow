define(['jquery', 'underscore', 'backbone'], function ($, _, Backbone) {
    var get_server_url = {};     

    return {
        get_server_url: function () { 
                        var sSrc = require.toUrl('');
                        var sServerUrl = sSrc.split("/js/")[0];        
                        return sServerUrl+"/onlinebookings/";                        
        },
        dataToUri: function(obj, prefix) {
            var str = [];
            for(var property in obj) {
              if (obj.hasOwnProperty(property)) {
                var k = prefix ? prefix + "[" + property + "]" : property, v = obj[property];
                str.push(typeof v === "object" ? dataToUri(v, k) : encodeURIComponent(k) + "=" + encodeURIComponent(v));
              }
            }
            return str.join("&");
        },
        dateJsToPlain: function(date){
            if (typeof date === 'undefined') date = new Date(); 
            
            var year = date.getFullYear();
            var month = (date.getMonth() + 1) < 10 ? '0' + (date.getMonth() + 1) : date.getMonth() + 1;
            var day = (date.getDate()) < 10 ? '0' + date.getDate() : date.getDate();
            
            return year + '-' + month + '-' + day;            
        },
        plainDateToObject: function(p_sDate){
            var sDate = p_sDate;
            var splits = sDate.split("-"); 
            
            var date = new Date(splits[0], (parseInt(splits[1])-1), splits[2]);
//            date.setTime(date.getTime() + date.getTimezoneOffset()*60*1000);
            
            return date;
        },
        getFirstMonthDay: function(p_sDate){
            var oDate = this.plainDateToObject(p_sDate);             
            var firstDay = new Date(oDate.getFullYear(), oDate.getMonth(), 1);
            var sFirstDay = this.dateJsToPlain(firstDay);
            
            return sFirstDay;
        },
        getLastMonthDay: function(p_sDate) {      
            var oDate = this.plainDateToObject(p_sDate);             
            var lastDay = new Date(oDate.getFullYear(), oDate.getMonth() + 1, 0);
            var sLastDay = this.dateJsToPlain(lastDay);            
            
            return sLastDay;
        },
        obtainObjectsIds: function(p_someObjects){
            var someFields = [];
            
            for(var i = 0; i < p_someObjects.length; i++){
                someFields.push(p_someObjects[i].id);
            }
            
            return someFields;
        },
        formatDate: function(p_sDate, p_sLang){
            var translateMonthNames = [];
            translateMonthNames['en'] = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            translateMonthNames['es'] = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
            translateMonthNames['pt'] = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
            translateMonthNames['ca'] = ['Gener', 'Febrer', 'Març', 'Abril', 'Maig', 'Juny', 'Juliol', 'Agost', 'Setembre', 'Octubre', 'Novembre', 'Desembre'];
            translateMonthNames['uk'] = ['січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
            translateMonthNames['de'] = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
            translateMonthNames['ko'] = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
            translateMonthNames['fr'] = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
            translateMonthNames['eu'] = ['Urtarrila', 'Otsaila', 'Martxoa', 'Apirila', 'Maiatza', 'Ekaina', 'Uztaila', 'Abuztua', 'Iraila', 'Urria', 'Azaroa', 'Abendua'];
            
            var translateDayNames = [];
            translateDayNames['en'] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            translateDayNames['es'] = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
            translateDayNames['pt'] = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
            translateDayNames['ca'] = ['Diumenge', 'Dilluns', 'Dimarts', 'Dimecres', 'Dijous', 'Divendres', 'Dissabte'];
            translateDayNames['uk'] = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', 'ятниця', 'Субота'];
            translateDayNames['de'] = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
            translateDayNames['ko'] = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
            translateDayNames['fr'] = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Verndredi', 'Samedi'];
            translateDayNames['eu'] = ['Igandea', 'Astelehena', 'Asteartea', 'Asteazkena', 'Osteguna', 'Ostirala', 'Larunbata'];
            
            var dayNames = [];            
            if (typeof translateDayNames[p_sLang] === 'undefined') {
                dayNames = translateDayNames['en'];
            }
            else {
                dayNames = translateDayNames[p_sLang];
            }
            
            var monthNames = [];
            if (typeof translateMonthNames[p_sLang] === 'undefined') {
                monthNames = translateMonthNames['en'];
            }
            else {
                monthNames = translateMonthNames[p_sLang];
            }
            
            var date = this.plainDateToObject(p_sDate);
            
            var weekDay = date.getDay();
            var day = date.getDate();
            var month = date.getMonth();
            var year = date.getFullYear();
            
            var sFinalDate = "";
            
            if(p_sLang === 'es'){
                sFinalDate = dayNames[weekDay] + " " + day + " de " + monthNames[month] + " de " + year;
            }
            else if(p_sLang === 'eu'){
                sFinalDate = monthNames[month] + " " + day + " " + dayNames[weekDay] + " " + year;
            }
            else if(p_sLang === 'pt'){
                sFinalDate = dayNames[weekDay] + " " + day + " " + monthNames[month] + " " + year;
            }
            else if(p_sLang === 'ca'){
                sFinalDate = dayNames[weekDay] + " " + day + " " + monthNames[month]+ " " + year;
            }
            else{
                sFinalDate = dayNames[weekDay] + " " + monthNames[month] + " " + day + " " + year;
            }
            
            return sFinalDate;
        },
        setCookie: function(p_oValues){
            var pairs = '';
            var expires = new Date();
            expires.setTime(expires.getTime() + (24 * 60 * 60 * 1000));
            
            for(var key in p_oValues){
                pairs += key + '=_#' + p_oValues[key] + '&_#';
            }
            
            pairs = pairs.substring(0, pairs.length-3);
            
            if(pairs.length > 0){
                document.cookie = 'bkt_widget=' + pairs + ";" + expires;
            }
            else{
//                this.deleteCookie();
            }
        }, 
        readCookie: function(){
            var cookie = {};
            var values = document.cookie.match("(^|;) ?bkt_widget=([^;]*)(;|$)");
            
            if(values === null){ return null; }
            
            var pairs = values[2].split("&_#");
            
            if(pairs.length <= 0){ return null; }
            
            for(var i = 0 ; i < pairs.length ; i++){
                var splits = pairs[i].split("=_#");
                
                cookie[splits[0]] = splits[1];
            }
            
            return cookie;
        },
        deleteCookie: function(){
            document.cookie = 'bkt_widget=;expires=Thu, 01 Jan 1970 00:00:01 GMT;';
        },
        getDateNow: function(){
            var date = new Date();

            var day = (date.getDate() < 10) ? ('0' + date.getDate()) : date.getDate();
            var month = ((date.getMonth() + 1) < 10) ? ('0' + (date.getMonth() + 1)) : (date.getMonth() + 1);
            var year = date.getFullYear();

            return year + '-' + month + '-' + day;
        },
        getTimeNow: function(){
            var date = new Date();

            var hour = (date.getHours() < 10) ? ('0' + date.getHours()) : date.getHours();
            var minutes = (date.getMinutes() < 10) ? ('0' + date.getMinutes()) : date.getMinutes();
            var seconds = (date.getSeconds() < 10) ? ('0' + date.getSeconds()) : date.getSeconds();

            return hour + ':' + minutes + ':' + seconds;
        },
        resizeWidgetIframe: function(){
            if(/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)){
                window.top.postMessage(document.body.scrollHeight, "*");
            }
        },
        obtainExtrasIds: function(p_someExtras){
            var someFields = {};

            $.each(p_someExtras, function(serviceIndex, extras){
                $.each(extras, function(extraIndex, value){
                    if(typeof someFields[serviceIndex] === 'undefined'){
                        someFields[serviceIndex] = [];
                    }

                    someFields[serviceIndex].push(extraIndex);
                });
            });            
            
            return someFields;
        },
        timeToAmPm: function(time_string){
            var splits = time_string.split(":"); 
            
            var hours = parseInt(splits[0]);
            var minutes = parseInt(splits[1]);
            var ampm = hours >= 12 ? 'pm' : 'am';
            
            hours = hours % 12;
            hours = hours ? hours : 12; // the hour '0' should be '12'
            minutes = minutes < 10 ? '0' + minutes : minutes;
            
            var strTime = hours + ':' + minutes + ' ' + ampm;
            
            return strTime;
        }        
    };
});