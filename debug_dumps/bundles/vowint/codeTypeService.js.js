app.service('CodeTypeService', ['$http', 'messageService', function ($http, ErrorService) {

    //GetAllCountryTypes
    var GetAllCountryTypes = function () {
        var p = $http({
            method: 'Get',
            url: '/Common/GetAllCountryTypes',
            cache: true
        }).success(function (data, status, headers, config) {
            return data;
        }).error(function (data, status, headers, config) {
            messageService.sendErrorMessage('get:/Common/GetAllCountryTypes');
        });
        return p;
    };

    //GetCountryTypeByIso2
    var GetCountryIdByIso2 = function (iso2) {
        if (iso2) {
            var p = $http({
                method: 'GET',
                url: '/Common/GetCountryIdByIso2',
                params: { 'iso2': iso2 },
                cache: true
            }).success(function (data, status, headers, config) {
                return data;
            })
                .error(function (data, status, headers, config) {
                    messageService.sendErrorMessage('get:/Common/GetCountryIdByIso2');
                });
            return p;
        } else {
            return null;
        }
    };

    //GetNationalityPaymentExceptionCountryByCountryId
    var GetNationalityPaymentExceptionByNationalityId = function (nationalityId) {
        return $http({
            method: 'GET',
            url: '/Common/GetNationalityPaymentExceptionByNationalityId',
            params: { 'nationalityId': nationalityId },
            cache: true
        }).then(function (data, status, headers, config) {
            if (typeof data === 'object') {
                return data;
            } else {
                return "";
            }
        }, function (response) {
            return "";
        });
    };

    //GetAllNationalityTypes
    var GetAllNationalityTypes = function () {
        var p = $http({
            method: 'Get',
            url: '/Common/GetAllNationalityTypes',
            cache: true
        }).success(function (data, status, headers, config) {
            return data;
        }).error(function (data, status, headers, config) {
            $scope.message = 'Unexpected Error';
        });
        return p;
    };

    //GetPurposeOfTravelTypesByVisaType
    var GetPurposeOfTravelTypesByVisaType = function (visaTypeId, dateOfApplication) {
        if (visaTypeId) {
            var p = $http({
                method: 'GET',
                url: '/Common/GetPurposeOfTravelTypesByVisaType',
                params: { 'visaTypeId': visaTypeId, 'dateOfApplication': dateOfApplication }
            }).success(function (data, status, headers, config) {
                return data;
            })
                .error(function (data, status, headers, config) {
                    messageService.sendErrorMessage('get:/Common/GetPurposeOfTravelTypesByVisaType');
                });
            return p;
        } else {
            return null;
        }
    };

    var GetPurposeOfTravelCategoriesByVisaType = function (visaTypeId, dateOfApplication) {
        if (visaTypeId) {
            var p = $http({
                method: 'GET',
                url: '/Common/GetPurposeOfTravelCategoryByVisaTypeId',
                params: { 'visaTypeId': visaTypeId, 'dateOfApplication': dateOfApplication }
            }).success(function (data, status, headers, config) {
                return data;
            })
                .error(function (data, status, headers, config) {
                    messageService.sendErrorMessage('get:/Common/GetPurposeOfTravelCategoryByVisaTypeId');
                });
            return p;
        } else {
            return null;
        }
    };


    var GetPurposeOfTravelCategoryByPurposeOfTravel = function (purposeOfTravelId, visaTypeId, dateOfApplication) {
        if (purposeOfTravelId) {
            var p = $http({
                method: 'GET',
                url: '/Common/GetPurposeOfTravelCategoryByPurposeOfTravelId',
                params: {
                    'purposeOfTravelId': purposeOfTravelId,'visaTypeId' : visaTypeId, 'dateOfApplication': dateOfApplication
            }
            }).success(function (data, status, headers, config) {
                return data;
            })
                .error(function (data, status, headers, config) {
                    messageService.sendErrorMessage('get:/Common/GetPurposeOfTravelTypesByVisaType');
                });
            return p;
        } else {
            return null;
        }
    };

    var GetExemptionByVisaType = function (visaType, birthDate, dateOfApplication, appId, memberStateOfDestinationId) {
        var p = $http({
            method: 'Get',
            url: '/Common/GetExemptionsByVisaType',
            params: { 'visaType': visaType, 'birthDate': birthDate, 'dateOfApplication': dateOfApplication, 'appId': appId, 'memberStateOfDestinationId': memberStateOfDestinationId },
            cache: false
        }).success(function (data) {
            return data;
        }).error(function () {
            messageService.sendErrorMessage('get:/Common/GetExemptionsByVisaType');
        });
        return p;

    };

    var GetExemptionByCategoryTypeAndVisaType = function (visaType, birthDate, dateOfApplication, appId, memberStateOfDestinationId) {
        var p = $http({
            method: 'Get',
            url: '/Common/GetExemptionsByVisaType',
            params: { 'visaType': visaType, 'birthDate': birthDate, 'dateOfApplication': dateOfApplication, 'appId': appId, 'memberStateOfDestinationId': memberStateOfDestinationId },
            cache: false
        }).success(function (data) {
            return data;
        }).error(function () {
            messageService.sendErrorMessage('get:/Common/GetExemptionsByVisaType');
        });
        return p;

    };


    var GetPurposeOfTravelByCategoryType = function (categoryId) {
        if (categoryId) {
            var p = $http({
                method: 'GET',
                url: '/Common/GetPurposeOfTravelByCategory',
                params: {'categoryId': categoryId }
            }).success(function (data, status, headers, config) {
                return data;
            })
                .error(function (data, status, headers, config) {
                    messageService.sendErrorMessage('get:/Common/GetPurposeOfTravelByCategory');
                });
            return p;
        } else {
            return null;
        }
    };








    var GetPurposeOfTravelByCategoryAndVisaType = function (categoryId, visaTypeId, dateOfApplication) {
        if (categoryId) {
            var p = $http({
                method: 'GET',
                url: '/Common/GetPurposeOfTravelByCategoryAndVisa',
                params: { 'categoryId': categoryId, 'visaTypeId': visaTypeId, 'dateOfApplication': dateOfApplication }
            }).success(function (data, status, headers, config) {
                return data;
            })
                .error(function (data, status, headers, config) {
                    messageService.sendErrorMessage('get:/Common/GetPurposeOfTravelByCategory');
                });
            return p;
        } else {
            return null;
        }
    };









    //GetAllSexTypes
    var GetAllSexTypes = function () {
        var p = $http({
            method: 'Get',
            url: '/Common/GetAllSexTypes',
            cache: true
        }).success(function (data, status, headers, config) {
            return data;
        }).error(function (data, status, headers, config) {
            messageService.sendErrorMessage('get:/Common/GetAllSexTypes');
        });
        return p;
    };

    //GetNewGuid
    var GetNewGuid = function () {
        var p = $http({
            method: 'Get',
            url: '/Common/GetNewGuidAsync',
            cache: false
        }).success(function (data) {
            return data;
        }).error(function () {
            messageService.sendErrorMessage('get:/Common/GetNewGuid');
        });
        return p;
    };

    //GetApplicationFee
    var GetApplicationFee = function (gratuityId, visaTypeId, nationalityId, issuingCountryId, documentTypeId, dateOfApplication, dateOfBirth,memberOfDestinationId) {
        var p = $http({
            method: 'GET',
            url: '/Common/GetApplicationFee',
            params: { 'gratuityId': gratuityId, 'visaTypeId': visaTypeId, 'nationalityId': nationalityId, 'issuingCountryId': issuingCountryId, 'documentTypeId': documentTypeId, 'dateOfApplication': dateOfApplication, 'dateOfBirth': dateOfBirth,'memberOfDestinationId' :  memberOfDestinationId},
            cache: true
        }).success(function (data, status, headers, config) {
            return data;
        })
                .error(function (data, status, headers, config) {
                  messageService.sendErrorMessage('get:/Common/GetApplicationFee');
                });
        return p;
    };

    var GetVacCurrencies = function(vacId) {
      var p = $http({
        method: 'GET',
        url: '/Common/GetVacCurrencies',
        params: { 'vacId': vacId },
        cache: true
      }).success(function (data, status, headers, config) {
        return data;
      })
      .error(function (data, status, headers, config) {
        messageService.sendErrorMessage('get:/Common/GetVacCurrencies');
      });

      return p;
    }

    var GetVacCurrency = function(vacId) {
      var p = $http({
        method: 'GET',
        url: '/Common/GetVacCurrency',
        params: { 'vacId': vacId },
        cache: true
      }).success(function (data, status, headers, config) {
        return data;
      })
      .error(function (data, status, headers, config) {
        messageService.sendErrorMessage('get:/Common/GetVacCurrency');
      });

      return p;
    }

    var GetAllVisaStatusTypes = function () {
        var p = $http({
            method: 'Get',
            url: '/Common/GetAllVisaStatusTypes',
            cache: false
        }).success(function (data) {
            return data;
        }).error(function () {
            messageService.sendErrorMessage('get:/Common/GetAllVisaStatusTypes');
        });
        return p;
    };

    var GetExemptionByVisaType = function (visaType, birthDate, dateOfApplication, appId, memberStateOfDestinationId) {
        var p = $http({
            method: 'Get',
            url: '/Common/GetExemptionsByVisaType',
            params: { 'visaType': visaType, 'birthDate': birthDate, 'dateOfApplication': dateOfApplication,'appId' : appId,'memberStateOfDestinationId':memberStateOfDestinationId },
            cache: false
        }).success(function (data) {
            return data;
        }).error(function () {
            messageService.sendErrorMessage('get:/Common/GetExemptionsByVisaType');
        });
        return p;
        
    };

    //return pointer
    return {
        getPurposeOfTravelList: GetPurposeOfTravelTypesByVisaType,
        getPurposeOfTravelCategoryList: GetPurposeOfTravelCategoriesByVisaType,
        getCountryList: GetAllCountryTypes,
        getNationalityList: GetAllNationalityTypes,
        getSexList: GetAllSexTypes,
        getCountryIdByIso2: GetCountryIdByIso2,
        getNationalityPaymentExceptionByNationalityId: GetNationalityPaymentExceptionByNationalityId,
        getNewGuid: GetNewGuid,
        getApplicationFee: GetApplicationFee,
        getVacCurrencies: GetVacCurrencies,
        getVacCurrency: GetVacCurrency,
        getAllVisaStatusTypes: GetAllVisaStatusTypes,
        getExemptionByVisaType: GetExemptionByVisaType,
        getPurposeOfTravelCategoryByPurposeOfTravel: GetPurposeOfTravelCategoryByPurposeOfTravel,
        getPurposeOfTravelByCategoryAndVisa: GetPurposeOfTravelByCategoryAndVisaType
    }
}]);