app.controller('commonController', ['$scope', '$http', 'messageService', function ($scope, $http, messageService) {
    $scope.isLoading = true;
    $scope.UserDataHandler = null;
    $scope.baseUrl = window.location.host;
    var language = document.documentElement.lang;
    ;
    if (window.location.href.indexOf('/fr-BE/') != -1 || window.location.href.indexOf('/fr') != -1) {
        $scope.baseUrl = $scope.baseUrl + '/fr/';
    }
    if (window.location.href.indexOf('/nl-BE/') != -1 || window.location.href.indexOf('/nl') != -1) {
        $scope.baseUrl = $scope.baseUrl + '/nl/';
    }
    if (window.location.href.indexOf('/en-UK/') != -1 || window.location.href.indexOf('/en') != -1) {
        $scope.baseUrl = $scope.baseUrl + '/en/';
    }
    
   
    $scope.GdprShortStayUrl = 'https://' + $scope.baseUrl + 'VisaApplication/PrintGdpr?gdprApproval=1';
    $scope.GdprLongStayUrl = 'https://' + $scope.baseUrl + 'VisaApplication/PrintGdpr?gdprApproval=2';
    $scope.GdprUrl = $scope.baseUrl;
      
    $scope.urlEncode = function (target) {

        return encodeURIComponent(target);
    }

    $scope.ToggleSideMenu = function () {
        var w = $("#cl-wrapper");
        var collapsed = 'True';
        if (w.hasClass("sb-collapsed")) { collapsed = 'False'; }
        $http({
            method: 'POST', url: '/Common/SetSessionVariable', data: {
                sessionVariable: "CollapsedMenu",
                value: collapsed
            }
        }).
        success(function (data, status) {
            //alert("ok");
        }).
        error(function (data, status) {
            //alert("error");
        });
    };
    $scope.redirectToGoogle = function () {
        $window.open('https://www.google.com', '_blank');
    };

    $scope.messageService = messageService;
}]);