app.factory('addressService', ['$http', '$rootScope', 'messageService', function ($http, $rootScope, messageService) {
    var AaddressService = {};

    AaddressService.resultAddress = '';

    AaddressService.prepForBroadcast = function (address) {
        this.resultAddress = address;
        this.broadcastItem();
    };

    AaddressService.broadcastItem = function () {
        $rootScope.$broadcast('handleAddressBroadcast');
    };

    return AaddressService;

}]);