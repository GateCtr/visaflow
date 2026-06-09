var app = angular.module('osOnline', [
    'ngTable',
    'ngResource',
    'blueimp.fileupload',
    'multi-select',
    //'ngBootstrap',
    'angular-flot',
    'ui.select',
    'ngSanitize',
    'ui.bootstrap',
    'ui.mask'
], function () {
});



app.run(['$rootScope', 'ACTOR', function ($rootScope, ACTOR) {
    $rootScope.ACTOR = ACTOR;

    

    //global range function
    $rootScope.getRange = function (from, to, numLength, onlyUnspecified) {
        var input = [];

        if (numLength == 6) {
            alert("aha");
        }

        if (onlyUnspecified) {
            input.push('00');
        }
        else {

            for (var i = from; i <= to; i += 1) {
                var formatnumber = pad(i, numLength);

                var item = new function () {
                    this.value = formatnumber;
                    if (formatnumber === '00') {
                        this.text = 'XX';
                    }
                    else {
                        this.text = formatnumber;
                    }
                }

                input.push(formatnumber);
            }
        }

        return input;
    };

    //padding leading 0 for dates
    function pad(n, width, z) {
        z = z || '0';
        n = n + '';
        return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
    };
}]);

//*******************       Config           *******************//

app.config(['$httpProvider', 'uiSelectConfig', '$compileProvider', function ($httpProvider, uiSelectConfig, $compileProvider) {
    $httpProvider.defaults.headers.common["X-Requested-With"] = 'XMLHttpRequest';

    $httpProvider.defaults.cache = false;
    if (!$httpProvider.defaults.headers.get) {
        $httpProvider.defaults.headers.get = {};
    }
    // disable IE ajax request caching
    $httpProvider.defaults.headers.get['If-Modified-Since'] = '0';

    $httpProvider.interceptors.push('HttpErrorInterceptorModule');
    uiSelectConfig.theme = 'select2';

    $compileProvider.aHrefSanitizationWhitelist(/^\s*(https?|ftp|mailto|biomodappdev|biomodapptst|biomodappuat|biomodapp):/);

    // Disable IE ajax request caching

    //$httpProvider.interceptors.push(function ($q, $rootScope) {
    //    return {
    //        'request': function (config) {
    //            $rootScope.$broadcast('loading-started');
    //            return config || $q.when(config);
    //        },
    //        'response': function (response) {
    //            $rootScope.$broadcast('loading-complete');
    //            return response || $q.when(response);
    //        }
    //    };
    //});
}]);

//*******************       Directives       *******************//

app.directive('repeatDone', [function () {
    return function (scope, element, attrs) {
        if (scope.$last) {
            $('.icheck').iCheck({
                checkboxClass: 'icheckbox_square-blue checkbox',
                radioClass: 'iradio_square-blue'
            });
        }
    };
}]);

app.directive('popover', [function () {
    return {
        restrict: 'A',
        link: function (scope, element, attrs) {
            $(element).popover();
        }
    };
}]);


app.directive('modalShow', [function () {
    return {
        restrict: "A",
        scope: {
            modalVisible: "="
        },
        link: function (scope, element, attrs) {
            scope.showLoading = function (visible) {
                if (visible) {
                    element.modal({ show: true, keyboard: false, backdrop: 'static' });
                }
                else {
                    element.modal("hide");
                }
            }
            //Check to see if the modal-visible attribute exists
            if (!attrs.modalVisible) {
                //The attribute isn't defined, show the modal by default
                scope.showLoading(false);
            }
            else {
                //Watch for changes to the modal-visible attribute
                scope.$watch("modalVisible", function (newValue, oldValue) {
                    scope.showLoading(newValue);
                });
            }
        }
    }
}]);

//app.directive('scrollspyBroadcast', ['$rootScope', function ($rootScope) {
//    return {
//        restrict: 'A',
//        scope: {},
//        link: function (scope, element, attrs) {
//            scope.activate = function () {
//                scope.documentHeight = Math.max(document.body.scrollHeight, document.body.offsetHeight, document.documentElement.clientHeight, document.documentElement.scrollHeight, document.documentElement.offsetHeight);
//                //distance down the page the top of the window is currently at
//                scope.userScrolledTop = (window.pageYOffset !== undefined) ? window.pageYOffset : (document.documentElement || document.body.parentNode || document.body).scrollTop;
//                //distance down the page the bottom of the window is currently at
//                scope.userScrolledBottom = scope.userScrolledTop + window.innerHeight;

//                scope.elementOffsetTop = element[0].offsetTop;
//                scope.elementOffsetBottom = scope.elementOffsetTop + Math.max(element[0].scrollHeight, element[0].offsetHeight);

//                scope.triggerOffset = 20;

//                //determine if element needs to be triggered by the top or bottom of the window
//                if ((scope.elementOffsetTop - scope.triggerOffset) < (scope.documentHeight - window.innerHeight)) {
//                    if (scope.elementOffsetTop <= (scope.userScrolledTop + scope.triggerOffset)) {
//                        $rootScope.$broadcast('spied', {
//                            'activeSpy': attrs.id
//                        });
//                    }
//                } else {
//                    if (scope.userScrolledBottom > (scope.elementOffsetBottom - scope.triggerOffset)) {
//                        $rootScope.$broadcast('spied', {
//                            'activeSpy': attrs.id
//                        });
//                    }
//                }
//            };

//            angular.element(document).ready(function () {
//                scope.activate();
//            });

//            angular.element(window).bind('scroll', function () {
//                scope.activate();
//            });
//        }
//    };
//}]);

//app.directive('scrollspyListen', ['$rootScope', function ($rootScope) {
//    return {
//        restrict: 'A',
//        scope: {
//            scrollspyListen: '@',
//            enabled: '@'
//        },
//        replace: true,
//        transclude: true,
//        template: function (element, attrs) {
//            var tag = element[0].nodeName;
//            return '<' + tag + ' data-ng-transclude data-ng-class="{active: enabled}"></' + tag + '>';
//        },
//        link: function (scope, element, attrs) {
//            $rootScope.$on('spied', function (event, args) {
//                scope.enabled = false;

//                if (scope.scrollspyListen === args.activeSpy) {
//                    scope.enabled = true;
//                }

//                if (!scope.$$phase) scope.$digest();
//            });
//        }
//    };
//}]);

app.directive('targetBlank', [function () {
    return {
        compile: function (element) {
            var elems = (element.prop("tagName") === 'A') ? element : element.find('a');
            elems.attr("target", "_blank");
        }
    };
}]);

app.factory('HttpErrorInterceptorModule', ['$q', 'messageService', function ($q, messageService) {
    return {
        response: function (response) {
            return response;
        },
        responseError: function (response) {
            if (response.status === 403) {
                messageService.sendErrorMessage('You have not enough permissions');
            }
            if (canRecover(response)) {
                return responseOrNewPromise
            }
            return $q.reject(response);
        }
    };
}]);

//*******************       Filters          *******************//

app.filter('jsonDate', ['$filter', function ($filter) {
    return function (input, format) {
        return $filter('date')(parseInt(input.substr(6)), format);
    };
}]);

//*******************       Constants        *******************//

app.constant('ACTOR', {
    TYPES: {
        APPLICANT: 1,
        GUARDIAN: 2,
        OCCUPATION: 3,
        ACCOMODATION: 4,
        REFERENCEPERSON: 5,
        REFERENCEORGANISATION: 6,
        EUFAMILYMEMBER: 7,
    },
    SUBTYPES: {
        VISAAPPLICANT: 1,
        PARENTALAUTHORITY: 2,
        LEGALGUARDIAN: 3,
        OCCUPATIONEMPLOYER: 4,
        OCCUPATIONEDUCATIONALESTABLISHMENT: 5,
        HOTELORTEMPORARYACCOMODATION: 6,
        REFERENCEPERSON: 7,
        REFERENCECOMPANY: 8,
        REFERENCESCHOOL: 9,
        EUFAMILYMEMBER: 10
    }
});

app.value(
    "CONSTANTS", {
    DAYSINMONTH : 31,
    MONTHS : 12,
    YEARSFROM : 1900
})