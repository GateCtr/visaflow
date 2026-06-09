//app.directive('reference', ['$compile', '$http', '$templateCache', function ($compile, $http, $templateCache) {
//    var getTemplate = function (contentType) {
//        var templateLoader,
//            templateMap = {
//                text: 'text.html',
//                photo: 'photo.html',
//                video: 'video.html',
//                quote: 'quote.html',
//                link: 'link.html',
//                chat: 'chat.html',
//                audio: 'audio.html',
//                answer: 'answer.html'
//            };

//        var templateUrl = templateMap[contentType];
//        templateLoader = $http.get(templateUrl, { cache: $templateCache });

//        return templateLoader;
//    };

//    var linker = function (scope, element, attrs) {
//        var loader = getTemplate(post.type);

//        var promise = loader.success(function (html) {
//            element.html(html);
//        }).then(function (response) {
//            element.replaceWith($compile(element.html())(scope));
//        });
//    };

//    return {
//        restrict: 'E',
//        scope: {
//            reference: '=reference'
//        },
//        link: linker
//    };
//}]);



app.directive('referenceperson', function () {
    var linkf = function (scope, element, attrs, ngModel) {
        scope.daysInMonth = 31;
        scope.months = 12;
        scope.yearsFrom = 1900;
        scope.yearsTo = new Date().getFullYear();

        element.bind('keydown,click, blur', function (e) {
            scope.$apply();
        });

        scope.getRange = function (from, to, numLength, onlyUnspecified) {
            var input = [];

            if (onlyUnspecified) {
                input.push('00');
            }
            else {
                for (var i = from; i <= to; i += 1) {
                    var formatnumber = pad(i, numLength);
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
    };

    return {
        restrict: 'E',
        scope: {
            ref: '=reference',
            formfield: '=formfield',
            Prefix: '=prefix',
            refGuid: '=refguid',
            Lists: '=list',
            readonly: '=readonly',
            onToggleModal: '&onAddressToggleModal',
            setDateofbirthPerson: '=setDateofbirthPerson',
            getDateofbirthPerson: '=getDateofbirthPerson',
            choose: '=chooseText',
personBirthDate:'=personBirthDate'
        },
        templateUrl: '../Person',
        link: linkf
       
    };
});

app.directive('referenceorganisation', function () {
    var linkf = function (scope, element, attrs) {
        scope.getRange = function (from, to, numLength) {
            var input = [];
            for (var i = from; i <= to; i += 1) {
                var formatnumber = pad(i, numLength);
                input.push(formatnumber);
            }

            return input;
        };

        //padding leading 0 for dates
        function pad(n, width, z) {
            z = z || '0';
            n = n + '';
            return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
        };
    };

    return {
        restrict: 'E',
        scope: {
            ref: '=reference',
            formfield: '=formfield',
            refGuid: '=refguid',
            Lists: '=list',
            readonly: '=readonly',
            onToggleModal: '&onAddressToggleModal'
        },
        templateUrl: '../Organisation',
        link: linkf,
        controller: 'referenceController'
    };
});

app.directive('minimalorganisation', function () {
    return {
        restrict: 'E',
        scope: {
            ref: '=reference',
            formfield: '=formfield',
            readonly: '=readonly'
        },
        templateUrl: '../MinimalOrganisation',
        controller: 'referenceController'
    };
});

app.directive('minimalperson', function () {
    return {
        restrict: 'E',
        scope: {
            ref: '=reference',
            formfield: '=formfield',
            readonly: '=readonly'
        },
        templateUrl: '../MinimalPerson',
        controller: 'referenceController'
    };
});