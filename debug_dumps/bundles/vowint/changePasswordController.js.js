app.controller('changePasswordController', ['$scope', '$http', function ($scope, $http) {
    $scope.formData = {};

    $scope.processForm = function () {
        $scope.errorOldPassword = null;
        $scope.errorNewPassword = null;
        $scope.errorConfirmPassword = null;
        $scope.message = null;
        $scope.errors = [];

        $http({
            method: 'POST',
            url: '/Account/Manage',
            data: $.param($scope.formData),  // pass in data as strings
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }  // set the headers so angular passing info as form data (not request payload)
        })
            .success(function (data) {
                if (!data.Success) {
                    // if not successful, bind errors to error variables
                    $scope.message = data.Message;
                    $scope.errors = data.Errors;
                    if (data.Errors.OldPassword) $scope.errorOldPassword = data.Errors.OldPassword;
                    if (data.Errors.NewPassword) $scope.errorNewPassword = data.Errors.NewPassword;
                    if (data.Errors.ConfirmPassword) $scope.errorConfirmPassword = data.Errors.ConfirmPassword;
                } else {
                    // if successful, bind success message to message
                    closemodals();
                    $.gritter.add({
                        position: 'bottom-right',
                        title: 'Success',
                        text: data.Message,
                        class_name: 'success'
                    });
                }
            })
            .error(function (data, status, headers, config) {
                // called asynchronously if an error occurs
                // or server returns response with an error status.
            });
    };

    var init = function () {
        $scope.formData = {};
        $scope.errorOldPassword = null;
        $scope.errorNewPassword = null;
        $scope.errorConfirmPassword = null;
        $scope.message = null;
    }

    var closemodals = function () {
        $('.md-modal').removeClass("md-show");
        init();
    };
    init();

    $('.md-trigger').modalEffects();

    $scope.closemodal = closemodals;
}]);