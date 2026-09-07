require.config({
    baseUrl: bkt_init_widget.srvsrc+'/js/',
    urlArgs: "v="+bkt_init_widget.version,
    paths: {        
        jquery: 'jquery/jquery-2.1.1.min',
        noconflict: 'jquery/noconflict',
        underscore: 'backbone/underscore',        
        backbone: 'backbone/backbone',        
        views: 'widgets/default/views',        
        models: 'widgets/default/models',
        collections: 'widgets/default/collections',  
        jqueryui: 'widgets/default/ui/jquery-ui.min'
    },
    map: {
        "*": {
            "jquery": 'noconflict'
        },
        "noconflict": {
            "jquery": "jquery"
        }
    },
    shim: {
        jquery: {
            exports: '$'
        },
        jqueryui:{
            deps: ['jquery']
        },
        underscore: {
            exports: '_'
        },
        backbone: {
            exports: 'Backbone',
            deps: ['jquery', 'underscore']
        }
    }
});

if(bkt_init_widget.type === 'button'){
    require(['widgets/button/app'], function(App){                        
        this.Backbone.$ = jQueryBkt;
        App.initialize();
    }); 
}
else{
    require(['widgets/default/app'], function(App){                      
        this.Backbone.$ = jQueryBkt;
        App.initialize();
    });     
} 
