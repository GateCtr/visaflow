//Googple Places
//USAGE:
//The data-Id of the button is used as prefix
//ex. <a data-modal="AddressPickerModal" data-id="referencePerson{{$index}}" class="md-trigger btn btn-default toggleModal"><span class="glyphicon glyphicon-search"></span></a>

app.controller("autocompleteController", ['$scope', 'addressService', function ($scope, addressService) {

    $scope.result = ''
    $scope.details = ''
    $scope.options = {};

    $scope.form = {
        type: 'geocode',
        typesEnabled: false,
        boundsEnabled: false,
        componentEnabled: false,
        watchEnter: true
    }

    //watch form for changes
    $scope.watchForm = function () {
        return $scope.form
    };
    $scope.$watch($scope.watchForm, function () {
        $scope.checkForm()
    }, true);
      
    //set options from form selections
    $scope.checkForm = function () {

        $scope.options = {};

        $scope.options.watchEnter = $scope.form.watchEnter

        if ($scope.form.typesEnabled) {
            $scope.options.types = $scope.form.type
        }

        if ($scope.form.boundsEnabled)
        {
            var SW = new google.maps.LatLng($scope.form.bounds.SWLat, $scope.form.bounds.SWLng)
            var NE = new google.maps.LatLng($scope.form.bounds.NELat, $scope.form.bounds.NELng)
            var bounds = new google.maps.LatLngBounds(SW, NE);
            $scope.options.bounds = bounds

        }
        if ($scope.form.componentEnabled) {
            $scope.options.country = $scope.form.country
        }
    };

    $('a[href="#map"]').on('shown.bs.tab', function () {
        google.maps.event.trigger(map, "resize");
        map.setCenter($scope.details.geometry.location);
    });

    //funtion closeModal
    var closemodals = function () {
        $('.md-modal').removeClass("md-show");
    };
    $scope.closemodal = closemodals; //pointer closeModal

    //fields are copied in prefix (whitch is the data-id of the button passed) + _Name
    var copyTextIntoForm = function () {
        addressService.prepForBroadcast($scope.details);
        //angular.element($("input#" + prefix + "_Street")).val($scope.details.street + ' ' + $scope.details.houseNumber);
        //angular.element($("input#" + prefix + "_PostalCode")).val($scope.details.postalCode);
        //angular.element($("input#" + prefix + "_City")).val($scope.details.city);
        ////field telephone is not part of address but if added with id prefix + _Telephonenumber data will be copied
        //angular.element($("input#" + prefix.replace('_Address', '') + "_Telephonenumber")).val($scope.details.telephone);
        ////field name is not part of address but if added with id prefix + _Name data will be copied
        //angular.element($("input#" + prefix.replace('_Address', '') + "_Name")).val($("#Place_name").val()); 
        ////select the index in the country dropdown
        //$("#s2id_" + prefix + "_CountryId").select2("val", $scope.details.countryId);
        
        $scope.details = null; //empty all controlls by setting binded elements to null
        ClearValue($("#Autocomplete2")); //clear the serachfield
        closemodals(); //close the modal screen
    }

    $scope.doCopyTextIntoForm = copyTextIntoForm; //pointer copyTextIntoForm

    //data-id of the clicked search button is used as a prefix result is copied afterwards
    //$(document).on("click", ".toggleModal", function () {
    //    prefix = $(this).data('id');
    //});


}
]);

//clear the controls when we close the modalscreen
function ClearValue(input) {
    input.val('');
}