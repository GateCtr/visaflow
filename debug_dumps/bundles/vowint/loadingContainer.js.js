//app.directive('loadingContainer', [function () {
//    return {
//        restrict: 'A',
//        scope: false,
//        link: function (scope, element, attrs) {
//            var loadingLayer = angular.element('<div class="loading"></div>');
//            element.append(loadingLayer);
//            element.addClass('loading-container');
//            scope.$watch(attrs.loadingContainer, function (value) {
//                loadingLayer.toggleClass('ng-hide', !value);
//            });
//        }
//    };
//}]);

(function () {
    'use strict';

    angular
        .module('osOnline')
        .directive('loadingContainer', loadingContainer);

    //loadingContainer.$inject = ['$window'];

    function loadingContainer() {
        // Usage:
        //     <gender></gender>
        // Creates:
        //
        var directive = {
            link: link,
            restrict: 'A',
            scope: false
        };
        return directive;

        function link(scope, element, attrs) {
            var loadingLayer = angular.element('<div class="loading"></div>');
            element.append(loadingLayer);
            element.addClass('loading-container');
            scope.$watch(attrs.loadingContainer, function (value) {
                loadingLayer.toggleClass('ng-hide', !value);
            });
        }
    }
})();