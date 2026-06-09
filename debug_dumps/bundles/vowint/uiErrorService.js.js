app.factory('uiErrorService', ['$http', 'messageService', function ($http, messageService) {
    var UIErrorService = {};

    UIErrorService.setControlErrors = function (errors) {
        if (errors != null) {
            for (var i = 0; i < errors.length; i++) {
                var element = $("#" + errors[i].Key);
                if (!element.length) {
                    element = $("[name=" + errors[i].Key.replace("References", "referencePerson").replace("[", "\\[").replace("]", "\\]").replace(".", "\\.") + "]");
                }
                element.addClass("input-validation-error"); //red control border
                $("<span class='field-validation-error' data-valmsg-for='" + errors[i].Key + "' + data-valmsg-replace='true'></span>")
                    .html(errors[i].Value[0]).appendTo(element.parent()); //error text for specific control
            }
        }
    };

    UIErrorService.removeControlErrors = function () {
        $(".input-validation-error").removeClass("input-validation-error");
        $("span.field-validation-error").remove();        
    };

    UIErrorService.resetControlErrors = function (errors) {
        UIErrorService.removeControlErrors();
        if (errors != null) {
            for (var i = 0; i < errors.length; i++) {
                var element = $("#" + errors[i].Key);
                if (!element.length) {
                    element = $("[name='" + errors[i].Key.replace("References","referencePerson").replace("[", "\\[").replace("]", "\\]").replace(".", "\\.") + "']");
                }
                element.addClass("input-validation-error"); //red control border
                $("<span class='field-validation-error' data-valmsg-for='" + errors[i].Key + "' + data-valmsg-replace='true'></span>")
                    .html(errors[i].Value[0]).appendTo(element.parent()); //error text for specific control
            }
        }
    };

    return UIErrorService;
}]);