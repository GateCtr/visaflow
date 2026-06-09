app.directive('guardian', function () {
    return {
        restrict: 'E',
        scope: {
            Guardian: '=model',
            gfield: '=gfield',
            Lists: '=list',
            onToggleModal: '&onAddressToggleModal',
            guardianRelationShipTypes: '=guardianRelationShipTypes'
        },
        templateUrl: '../Guardian'
    };
});