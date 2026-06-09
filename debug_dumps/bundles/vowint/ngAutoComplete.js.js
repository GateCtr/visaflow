/**
 * A directive for adding google places autocomplete to a text box
 * google places autocomplete info: https://developers.google.com/maps/documentation/javascript/places
 *
 * Usage:
 *
 * + ng-model - autocomplete textbox value
 *
 * + details - more detailed autocomplete result, includes address parts, latlng, etc. (Optional)
 *
 * + options - configuration for the autocomplete (Optional)
 *
 *       + types: type,        String, values can be 'geocode', 'establishment', '(regions)', or '(cities)'
 *       + bounds: bounds,     Google maps LatLngBounds Object, biases results to bounds, but may return results outside these bounds
 *       + country: country    String, ISO 3166-1 Alpha-2 compatible country code. examples; 'ca', 'us', 'gb'
 *       + watchEnter:         Boolean, true; on Enter select top autocomplete result. false(default); enter ends autocomplete
 *
 * example:
 *
 *    options = {
 *        types: '(cities)',
 *        country: 'ca'
 *    }
 * 
 * //Geometry points
 * https://developers.google.com/maps/documentation/javascript/reference#PlaceGeometry
 * //address types
 * https://developers.google.com/maps/documentation/geocoding/#Types 
 * //GeocoderAddressComponent address properties
 * https://developers.google.com/maps/documentation/javascript/reference#GeocoderAddressComponent
**/

app.directive('ngAutocomplete', ["CodeTypeService", function (CodeTypeService) {
      return {
          require: 'ngModel',
          scope: {
              ngModel: '=',
              options: '=?',
              details: '=?'
          },

          link: function (scope, element, attrs, controller) {

              //options for autocomplete
              var opts
              var watchEnter = false
              //convert options provided to opts
              var initOpts = function () {

                  opts = {}
                  if (scope.options) {

                      if (scope.options.watchEnter !== true) {
                          watchEnter = false
                      } else {
                          watchEnter = true
                      }

                      if (scope.options.types) {
                          opts.types = []
                          opts.types.push(scope.options.types)
                          scope.gPlace.setTypes(opts.types)
                      } else {
                          scope.gPlace.setTypes([])
                      }

                      if (scope.options.bounds) {
                          opts.bounds = scope.options.bounds
                          scope.gPlace.setBounds(opts.bounds)
                      } else {
                          scope.gPlace.setBounds(null)
                      }

                      if (scope.options.country) {
                          opts.componentRestrictions = {
                              country: scope.options.country
                          }
                          scope.gPlace.setComponentRestrictions(opts.componentRestrictions)
                      } else {
                          scope.gPlace.setComponentRestrictions(null)
                      }
                  }
              }

              if (scope.gPlace == undefined) {
                  scope.gPlace = new google.maps.places.Autocomplete(element[0], {});
              }
              google.maps.event.addListener(scope.gPlace, 'place_changed', function () {
                  var result = scope.gPlace.getPlace();
                  if (result !== undefined) {
                      if (result.address_components !== undefined) {

                          scope.$apply(function () {
                              //initialize otherwise we send undefined in the control
                              scope.details = result;
                              scope.details.houseNumber = '';
                              scope.details.street = '';
                              scope.details.city = '';
                              scope.details.postalCode = '';
                              scope.details.country = '';
                          // Get each component of the address from the place details
                          // and fill the corresponding field on the form.
                          for (var i = 0; i < result.address_components.length; i++) {
                              var addressType = result.address_components[i].types[0];
                              if (addressType == 'street_number') {
                                  scope.details.houseNumber = result.address_components[i]['short_name'];
                              }
                              if (addressType == 'route') {
                                  scope.details.street = result.address_components[i]['short_name'];
                              }
                              if (addressType == 'locality') {
                                  scope.details.city = result.address_components[i]['long_name'];
                              }
                              if (addressType == 'postal_code') {
                                  scope.details.postalCode = result.address_components[i]['short_name'];
                              }
                              if (addressType == 'country') {
                                  scope.details.country = result.address_components[i]['short_name'];
                                  //assync get CountryId
                                  CodeTypeService.getCountryIdByIso2(scope.details.country).then(function (d) {
                                      scope.details.countryId = d.data.Value;
                                      scope.details.country = d.data.Text; //If translation is present we use our Text
                                  });
                              }
                          }
                          scope.details.placeName = result.name;
                          scope.details.telephone = result.international_phone_number;

                          var location = result.geometry.location;
                          document.getElementById('location').value = location;

                          var mapOptions = {
                              zoom: 13,
                              center: location
                          };

                          map = new google.maps.Map(document.getElementById('map-canvas'),
                              mapOptions);

                          var markerOptions = {
                              map: map,
                              position: location
                          };

                          var marker = new google.maps.Marker(markerOptions);
                              controller.$setViewValue(element.val());
                          });
                      }
                      else {
                          if (watchEnter) {
                              getPlace(result)
                          }
                      }
                  }
              })

              //function to get retrieve the autocompletes first result using the AutocompleteService 
              var getPlace = function (result) {
                  var autocompleteService = new google.maps.places.AutocompleteService();
                  if (result.name.length > 0) {
                      autocompleteService.getPlacePredictions(
                        {
                            input: result.name,
                            offset: result.name.length
                        },
                        function listentoresult(list, status) {
                            if (list == null || list.length == 0) {

                                scope.$apply(function () {
                                    scope.details = null;
                                });

                            } else {
                                var placesService = new google.maps.places.PlacesService(element[0]);
                                placesService.getDetails(
                                  { 'reference': list[0].reference },
                                  function detailsresult(detailsResult, placesServiceStatus) {

                                      if (placesServiceStatus == google.maps.GeocoderStatus.OK) {
                                          scope.$apply(function () {

                                              controller.$setViewValue(detailsResult.formatted_address);
                                              element.val(detailsResult.formatted_address);

                                              scope.details = detailsResult;
                                              
                                              /***/
                                              scope.details = result;
                                          //initialize otherwise we send undefined in the control
                                              scope.details.houseNumber = '';
                                              scope.details.street = '';
                                              scope.details.city = '';
                                              scope.details.postalCode = '';
                                              scope.details.country = '';
                                              // Get each component of the address from the place details
                                              // and fill the corresponding field on the form.
                                              for (var i = 0; i < detailsResult.address_components.length; i++) {
                                                  var addressType = detailsResult.address_components[i].types[0];
                                                  if (addressType == 'street_number') {
                                                      scope.details.houseNumber = detailsResult.address_components[i]['short_name'];
                                                  }
                                                  if (addressType == 'route') {
                                                      scope.details.street = detailsResult.address_components[i]['short_name'];
                                                  }
                                                  if (addressType == 'locality') {
                                                      scope.details.city = detailsResult.address_components[i]['long_name'];
                                                  }
                                                  if (addressType == 'postal_code') {
                                                      scope.details.postalCode = detailsResult.address_components[i]['short_name'];
                                                  }
                                                  if (addressType == 'country') {
                                                      scope.details.country = detailsResult.address_components[i]['short_name'];
                                                      //assync get CountryId
                                                      CodeTypeService.getCountryIdByIso2(scope.details.country).then(function (d) {
                                                          scope.details.countryId = d.data.Value;
                                                          scope.details.country = d.data.Text;//If translation is present we use our Text
                                                      });
                                                  }
                                              }
                                              scope.details.placeName = detailsResult.name;
                                              scope.details.telephone = detailsResult.international_phone_number;
                                              
                                              var location = detailsResult.geometry.location;
                                              document.getElementById('location').value = location;

                                              var mapOptions = {
                                                  zoom: 13,
                                                  center: location
                                              };

                                              map = new google.maps.Map(document.getElementById('map-canvas'),
                                                  mapOptions);

                                              var markerOptions = {
                                                  map: map,
                                                  position: location
                                              };

                                              var marker = new google.maps.Marker(markerOptions);

                                              controller.$setViewValue(element.val());
                                              /***/
                                              
                                              //on focusout the value reverts, need to set it again.
                                              var watchFocusOut = element.on('focusout', function (event) {
                                                  element.val(detailsResult.formatted_address);
                                                  element.unbind('focusout')
                                              })

                                          });
                                      }
                                  }
                                );
                            }
                        });
                  }
              }

              controller.$render = function () {
                  var location = controller.$viewValue;
                  element.val(location);
              };

              //watch options provided to directive
              scope.watchOptions = function () {
                  return scope.options
              };
              scope.$watch(scope.watchOptions, function () {
                  initOpts()
              }, true);

          }
      };
  }]);

