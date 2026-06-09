app.controller('gdprController', ['$scope', '$http', '$compile', '$window', 'messageService',
    function ($scope, $http, $compile, $window, messageService) {

        $scope.GDPR = {};
        $scope.ErrorMessage = '';
        $scope.GdprApprovalChexBoxShow = false;
        $scope.ShowErrorNoSelection = false;
        $scope.GDPR.visaType = ['Court séjour (≤ 90 jours)', 'Long séjour (> 90 jours)'];
        var textShortStay = angular.element(document.querySelector("#shortStay")).val();
        var textLongStay = angular.element(document.querySelector("#longStay")).val();
        $scope.GDPR.visaType = [
            {
                Value: 0,
                Text: '-'
            },
            {
                Value: 1,
                Text: textShortStay
            },
            {
                Value: 2,
                Text: textLongStay
            }];
        $scope.GDPR.visaTypeSelected = 0; 
       
        $scope.gdprApproval = false;
        $scope.showErrorGdprApproval = false;
        $scope.ShowErrorNoSelection = false;
        

        $scope.gdprLink = function (isCaptcha) {
            $scope.ActivateCaptcha = isCaptcha;
            $scope.GdprApprovalChexBoxShow = true;
            $scope.showErrorGdprPleaseRead = false;
            $scope.ShowErrorNoSelection = false;


        }
        $scope.visaTypeChange = function () {
            $scope.GdprApprovalChexBoxShow = false;
            $scope.showErrorGdprApproval = false;
            $scope.showErrorNoSelection = false;
            $scope.showErrorGdprPleaseRead = false;
            $scope.gdprApproval = false;
            $("#GdprApproval").prop("checked", false);
        }
        $scope.gdprApprove = function () {
            $scope.vaCoreId;
            if ($scope.gdprApproval === true)
            {
                $scope.showErrorGdprApproval = false;
                $scope.ShowErrorNoSelection = false;
                $scope.path = $window.location.origin + $window.location.pathname.replace("Gdpr", "CreateGdprNewWithAutoNumber");
                
                var hcaptcha = '';
                if ($scope.ActivateCaptcha === true) {
                    hcaptcha = document.querySelector("iframe[data-hcaptcha-response]").getAttribute("data-hcaptcha-response");
                }
                //var requestdata = { gdprApproval: $scope.GDPR.visaTypeSelected };
                //var hcaptcha = document.querySelector("iframe[data-hcaptcha-response]").getAttribute("data-hcaptcha-response");
                var gdprApproval = {
                    Approval: $scope.GDPR.visaTypeSelected,
                    RecaptchaResponse: hcaptcha
                };
                $scope.ErrorMessage = '';
                $http({
                    method: "POST",
                    url: $scope.path,
                    data: $.param(gdprApproval),  // pass in data as strings
                    headers: {
                        'Content-Type': "application/x-www-form-urlencoded"
                    }
                })
                .success(function (data) {
                    if (data.Success === false) {
                        $scope.ErrorMessage = data.ErrorMessage;
                    }
                    else {
                        //to do manage error when callin the method
                        $scope.vaCoreId = data.VACoreId;
                        $scope.path = $window.location.origin + $window.location.pathname.replace("Gdpr", "Edit") + '/' + data.VACoreId;
                        $window.location.href = $scope.path;
                    }
                       
                })
               .error(function () {
                   $scope.ErrorMessage = "Err";
               });
            }
            else if ($scope.GDPR.visaTypeSelected == null || $scope.GDPR.visaTypeSelected === 0)
            {
                $scope.showErrorNoSelection = true;
                $scope.showErrorGdprApproval = false;
            }
            else
            {
                $window.location.href = "#rgbdError";
                $scope.showErrorGdprApproval = true;
                
                if ($scope.GdprApprovalChexBoxShow == false)
                {
                    $scope.showErrorGdprPleaseRead = true;
                    $scope.showErrorGdprApproval = false;

                }
                else
                {
                    $scope.showErrorGdprApproval = true;
                    $scope.showErrorGdprPleaseRead = false;
                }
                $scope.showErrorNoSelection = false;
                
            }

        }
        $scope.gdprCancel = function () {
            window.location = '/';
        }
        

    }]);