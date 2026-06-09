app.controller('referenceController', ['$scope', '$http', '$timeout', '$filter', '$window',  function ($scope, $http, $timeout, $filter, $window) {

    //-------------------------SCHOOL-------------------------//
    
    $scope.SchoolSearchList = [];
    $scope.getSchoolAsync = function (query) {
        $http({
            method: 'Get',
            url: '/Common/getSchoolAsync',
            cache: true,
            params: { 'query': query },
        }).success(function (data, status, headers, config) {
                $scope.SchoolSearchList = data;           
        }).error(function (data, status, headers, config) {
            $scope.ErrorMessage = 'Unexpected Error';
        });
    };


}]);



