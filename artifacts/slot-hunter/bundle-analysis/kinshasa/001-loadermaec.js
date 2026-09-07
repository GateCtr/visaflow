(function(){
    var sVersion = (inIframe()) ? '2' : '4';
    
    var sSrc = bkt_init_widget.srvsrc;    
    var sServerUrl = sSrc.split("/js/")[0];
    
    var sJqueryUrl = sServerUrl + '/js/jquery/jquery-2.1.1.min.js';
    var sRequireUrl = sServerUrl + '/js/require/require-2.1.14.js';
    
    var sMainUrl = sServerUrl + '/onlinebookings/main';
    var sMainJsUrl = sServerUrl + '/js/widgets/mainv1.js?v=' + sVersion;
    
    var sMainContainer = '#idBktWidgetBody';
    
//    var jQueryBkt;
                 
    function start(){
        bkt_init_widget.version = sVersion;
        
        bkt_init_widget.src = document.location.href;
        
        if(bkt_init_widget.src.indexOf("#redsysok") >= 0){
            var src = bkt_init_widget.src.split("#redsysok");
            bkt_init_widget.src = src[0];
        }
        
        if(bkt_init_widget.src.indexOf("#redsysko") >= 0){
            var src = bkt_init_widget.src.split("#redsysko");
            bkt_init_widget.src = src[0];
        }        
        
        if(typeof bkt_init_widget.lang === 'undefined'){ bkt_init_widget.lang = 'es'; }
        
        var someUrlPieces = location.href.split("#dochangelanguage/");
        if(someUrlPieces.length > 1){ bkt_init_widget.lang = someUrlPieces[1]; }
        
        loadJquery();
    }
    
    function loadJquery(){
        if(window.jQuery === undefined){
            var oScriptHtmlElement = document.createElement('script');
            oScriptHtmlElement.setAttribute("type","text/javascript");
            oScriptHtmlElement.setAttribute("src", sJqueryUrl);
            (document.getElementsByTagName("head")[0] || document.documentElement).appendChild(oScriptHtmlElement);
            
            if(oScriptHtmlElement.attachEvent){ //it is IE                
                oScriptHtmlElement.onreadystatechange = function() { // for IE
                    if(this.readyState == 'complete' || this.readyState == 'loaded'){
                        this.onreadystatechange = null;
                        scriptHandler();
                    }
                };
            } 
            else{
                oScriptHtmlElement.onload = scriptHandler;
            }
        }
        else if(window.jQuery.fn.jquery !== '2.1.1'){
            var oScriptHtmlElement = document.createElement('script');
            oScriptHtmlElement.setAttribute("type","text/javascript");
            oScriptHtmlElement.setAttribute("src", sJqueryUrl);
            (document.getElementsByTagName("head")[0] || document.documentElement).appendChild(oScriptHtmlElement);
            
            if(oScriptHtmlElement.attachEvent){ //it is IE                
                oScriptHtmlElement.onreadystatechange = function() { // for IE
                    if(this.readyState == 'complete' || this.readyState == 'loaded'){
                        this.onreadystatechange = null;
                        scriptHandlerNoConflict();
                    }
                };
            } 
            else{
                oScriptHtmlElement.onload = scriptHandlerNoConflict;
            }            
        }
        else{
            scriptHandler();
        }
    }
    
    function scriptHandlerNoConflict(){
        jQueryBkt = window.jQuery.noConflict(true);
        main();
    }
    
    function scriptHandler(){
        jQueryBkt = window.jQuery;            
        main();
    }
    
    function main(){    
        jQueryBkt(document).ready(function() {
            if(bkt_init_widget.type === 'default'){
                jQueryBkt('#idBktWidgetBody').append('<div style="text-align: center;"><img class="clsBktWidgetDefaultLoading" src="'+ sServerUrl +'/images/widgets/default/loading/loading.gif" alt="Loading" height="24" width="24"></div>');
            }

            getHtml();            
        });
    }    
    
    function getHtml(){
       var sSrvsrc = bkt_init_widget.srvsrc;
       delete bkt_init_widget.srvsrc;
       jQueryBkt.getJSON(sMainUrl + '/?callback=?', bkt_init_widget, serverResponseRenderView);
       bkt_init_widget.srvsrc = sSrvsrc;
    } 
    
    function serverResponseRenderView(data){
        if(typeof data.status === 'undefined'){
            jQueryBkt(sMainContainer).append(data); 
            
            loadLibs();            
        }
        else{
            jQueryBkt(sMainContainer).append('<p>There was an error loading the widget.</p>');
        } 
    }    
    
    function loadLibs(){
        loadCss();
        
        var oScriptHtmlElement = document.createElement('script');
        oScriptHtmlElement.text += 'var oClientValues_248295 = {};';
        (document.getElementsByTagName('head')[0] || document.documentElement).appendChild(oScriptHtmlElement);
        
        if(window.require === undefined){
            oScriptHtmlElement = document.createElement('script');
            oScriptHtmlElement.setAttribute('type', 'text/javascript');
            oScriptHtmlElement.setAttribute('src', sRequireUrl);
            (document.getElementsByTagName('head')[0] || document.documentElement).appendChild(oScriptHtmlElement);
            oScriptHtmlElement.setAttribute('data-main', sMainJsUrl);  
        }
        else{
            oScriptHtmlElement = document.createElement('script');
            oScriptHtmlElement.setAttribute('type', 'text/javascript');
            oScriptHtmlElement.setAttribute('src', sMainJsUrl);
            (document.getElementsByTagName('head')[0] || document.documentElement).appendChild(oScriptHtmlElement);
        }
    }
    
    function loadCss(){
        var someCss = ['maec.css'];
        
        if(bkt_init_widget.scroll === true){
            someCss.push('scroll.css');
        }
        
        for(var i = 0 ; i < someCss.length ; i++){
            var oScriptHtmlElement = document.createElement('link');
            oScriptHtmlElement.setAttribute('rel', 'stylesheet');
            oScriptHtmlElement.setAttribute('type', 'text/css');
            oScriptHtmlElement.setAttribute('href', sServerUrl + '/css/widgets/' + someCss[i]+"?v="+sVersion);
            (document.getElementsByTagName('head')[0] || document.documentElement).appendChild(oScriptHtmlElement);
        }
    }    
	
    function inIframe(){
        try{
            return window.self !== window.top;
        }
        catch(e){
            return true;
        }
    }	
   
    start();
})();