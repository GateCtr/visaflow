app.controller("visaApplicationController", ["$scope", "$http", "$timeout", "$filter", "$window", "CodeTypeService", "addressService", "uiErrorService", "AppId", "ACTOR", "$q", 'messageService', '$sce', 'accentRemoveService',
    function ($scope, $http, $timeout, $filter, $window, CodeTypeService, addressService, uiErrorService, AppId, ACTOR, $q, messageService, $sce, accentRemoveService) {
        //Assign osuniqueid parameter to Angular (comming from form)
        $scope.AppId = AppId;
        $scope.VA = {};
        $scope.ShowDocumentCheck = false;
        $scope.SuccessMessage = "";
        $scope.ErrorMessage = "";
        $scope.Errors = [];
        $scope.canEditPayment = false;
        $scope.canEditGratuity = true;
        $scope.canEditCurrency = true;
        $scope.canEditFingerprintExemption = true;
        $scope.needFingerprintExemptionReason = false;
        $scope.canEditNumberOfEntries = true;
        $scope.canEditDuration = true;
        $scope.startDateBiometrics = new Date(2007, 7, 29, 0, 0, 0, 0);
        $scope.fpVisaDStudentGoLive = new Date(2014, 1, 1, 0, 0, 0, 0);
        $scope.isPerformingServerAction = false;
        $scope.model = { SelectedVacCountry: "" };
        $scope.fingerPrintImage = "";
        $scope.myValue = 1;
        $scope.TravelDocumentCountryList = [];

        /***************************      Here are located all the values for the MRZ modal window     *******************************************/

        $scope.sexValue = "M";
        $scope.travel_Document_IssuingState = "NA";
        $scope.personal_Data_Nationality = "NA";
        $scope.personal_Vfa = "NA";

        $scope.currentStatus = 7;
        $scope.TempMrzStatus;
        $scope.MrzCheckBoxChecked = false;
        $scope.ShowDeleteScan = true;
        $scope.MRZ_BirthDateFormat = "-";
        $scope.MRZ_ValidityDateFormat = "-";
        $scope.showUeFamilyMember = false;
        $scope.showConfirmEmail = false;
        $scope.confirmEmail = "";
        $scope.invalidEmail = false;
        $scope.AppointmentTaken = false;
        $scope.bioModFetchOk = true;

        // Not nice... You should create a config array of objects that will hold all scan data per case
        // and you should put that in a constant variable in a separate common js file where all hardcoded data would come from 
        // and then inject it in the controller in order to use it here (Michael)


        $scope.availableScanPictures = [

            "/Content/Images/GreenPassport.jpg"
            ,

            "/Content/Images/GreenPassport.jpg"
            ,

            "/Content/Images/GreenPassport.jpg"
            ,

            "/Content/Images/GreenPassport.jpg"
            ,

            "/Content/Images/RedPassport.jpg"
            ,

            "/Content/Images/WarningPassport.jpg"
            ,

            "/Content/Images/Passport.jpg"
            ,

            "/Content/Images/loading.gif"

        ];
        $scope.PdfStyleGrey = "filter:  opacity(0.5) drop-shadow(0 0 0 grey);";
        $scope.PdfStyleGreen = "filter:  opacity(0.5) drop-shadow(0 0 0 green);";
        $scope.PdfStyleOrange = "filter:  opacity(0.5) drop-shadow(0 0 0 orange);";
        $scope.PdfStyle = $scope.PdfStyleGrey;
        $scope.anyDocument = false;
        $scope.checkBoxIgnored = false;
        $scope.ArrowShow = false;
        $scope.IsScanPictureClick = false;

        /*Hide and show Overwritten arrow*/
        $scope.showArrow = false;
        var StatusScan =
        {
            OK: 0, OKIGNORED: 1, OKOVERWRITTEN: 2, NOSCANIGNORED: 3, NOSCAN: 4, WARNING: 5, NOTAPPLICABLE: 6
        }

        /************************************************   End of the MRZ modal window ****************************************/

        $scope.FingerprintExemptions;
        $scope.setLoading = function () {
            $scope.showDialog = true;
        };
        $scope.unsetLoading = function () {
            $scope.showDialog = false;
        };

        $scope.changeEmail = function () {
            var valeur = $scope.VA.Personal_Data_Email;
            $scope.showConfirmEmail = true;
        }

        $scope.changeConfirmEmail = function () {

            if ($scope.confirmEmail.length > 0 && $scope.VA.Personal_Data_Email !== $scope.confirmEmail)
                $scope.invalidEmail = true;
            else
                $scope.invalidEmail = false;
        }

        $scope.constEUFamilyMember = ACTOR.TYPES.EUFAMILYMEMBER;

        $scope.toggleModal = function (addressModel) {
            $scope.currentAddress = addressModel;
        };

        $scope.$on("handleAddressBroadcast", function () {

            $scope.currentAddress.Street = addressService.resultAddress.street;
            $scope.currentAddress.HouseNumber = addressService.resultAddress.houseNumber;
            $scope.currentAddress.City = addressService.resultAddress.city;
            $scope.currentAddress.PostalCode = addressService.resultAddress.postalCode;
            $scope.currentAddress.CountryId = addressService.resultAddress.countryId;
        });

        //-------------------------SCHOOL-------------------------//
        $scope.SchoolSearchList = [];
        $scope.getSchoolAsync = function (query) {
            $http({
                method: "Get",
                url: "/Common/getSchoolAsync",
                cache: true,
                params: { 'query': query }
            }).success(function (data) {
                if (data.Success === true) {
                    $scope.SchoolSearchList = data;
                } else {
                    $scope.ValidIdErrors = data.ModelErrors;
                    uiErrorService.setControlErrors($scope.ValidIdErrors);
                }
            }).error(function () {
                $scope.ErrorMessage = "Unexpected Error";
            });
        };




        innerPrintBarcode = function (barcodeAmount) {
            switch (barcodeAmount) {
                case 8:
                    document.getElementById('PrintBarcodeEight').click();
                    break;
                case 4:
                    document.getElementById('PrintBarcodeFour').click();
                    break;
                case 1:
                    document.getElementById('PrintBarcodeOne').click();
                    break;
                case 44:
                    document.getElementById('PrintBarcodeFourLandscape').click();
                    break;
                default:
                    break;
            }
        };

        $scope.printBarcode = function (e, barcodeAmount) {
            e.preventDefault();
            if (!$scope.VA.OSUniqueId) {
                $http({
                    method: "Get",
                    url: "/Common/GetOsUniqueId",
                    cache: true,
                    params: {
                        'AppId': $scope.VA.AppId
                    }
                })
                    .success(function (data) {
                        $scope.VA.OSUniqueId = data.OsUniqueId;
                        innerPrintBarcode(barcodeAmount);
                    })
                    .error(function () {
                        $scope.ErrorMessage = "Unexpected Error";
                    });
            }
            else {
                innerPrintBarcode(barcodeAmount);
            }
        };







        //config special dateofbirth control
        $scope.daysInMonth = 31;
        $scope.months = 12;
        $scope.yearsFrom = 1900;
        $scope.yearsTo = new Date().getFullYear();
        $scope.Day = "Day"; //Select index DAY
        $scope.Month = "Month";//Select index Month
        $scope.Year = "Year";//Select index Year
        $scope.EUDay = "EUDay"; //Select index DAY
        $scope.EUMonth = "EUMonth";//Select index Month
        $scope.EUYear = "EUYear";//Select index Year
        $scope.ShowPreviousSchengenVisa = false;


        $scope.delay = (function () {
            var promise = null;
            return function (callback, ms) {
                $timeout.cancel(promise); //clearTimeout(timer);
                promise = $timeout(callback, ms); //timer = setTimeout(callback, ms);
            };
        })();



        $scope.DifferenceBetweenMrzAndSchengen = function () {
            if ($scope.currentStatus == StatusScan.OK || $scope.currentStatus == StatusScan.OKIGNORED || $scope.currentStatus == StatusScan.OKOVERWRITTEN || $scope.currentStatus == StatusScan.WARNING) {
                $scope.TempMrzStatus = StatusScan.OK;
                $scope.LastNameChanged();
                $scope.FirstNameChanged();
                $scope.CompareDateOfBirtWithMrz();
                $scope.CompareNationalityWithMrz();
                $scope.CompareValiddUntilWithMrz();
                $scope.CompareDocumentNumberWithMrz();
                $scope.compareIssuingAuthorityCountryIdWithMrz();
                $scope.comparePersonal_Data_GenderIdWithMrz();
                if ($scope.TempMrzStatus == StatusScan.WARNING) {
                    if ($scope.VA.Overwritten == true)
                        $scope.VA.Overwritten = false;
                    if ($scope.VA.Ignored == true)
                        $scope.VA.Ignored = false;
                }
                $scope.currentStatus = $scope.TempMrzStatus;

            }
        }

        var borderStyleWarning = "border: orange 2px solid ;flex:1;"
        $scope.LastNameChanged = function () {
            var borderStyle = ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN) ? "border: red 2px solid ;flex:1;" : "border: green 2px solid ;flex:1;";

            var LastNameCompareWithMrzReady = $scope.VA.Personal_Data_LastName.replace("'", " ").replace("-", " ").replace(",", " ");

            if ($scope.VA.Mrz_LastName === LastNameCompareWithMrzReady) {
                $scope.VA.Css_LastName = " " + borderStyle;
            }
            else {
                $scope.VA.Css_LastName = "background: orange;" + " " + borderStyleWarning;
                $scope.TempMrzStatus = StatusScan.WARNING;
            }

        }

        $scope.FirstNameChanged = function () {
            var borderStyle = ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN) ? "border: red 2px solid ;flex:1;" : "border: green 2px solid ;flex:1;";
            var FirstNameCompareWithMrzReady = $scope.VA.Personal_Data_FirstName.replace("'", " ").replace("-", " ").replace(",", " ");

            if ($scope.VA.Mrz_FirstName === FirstNameCompareWithMrzReady) {
                $scope.VA.Css_FirstName = " " + borderStyle;
            }
            else {
                $scope.VA.Css_FirstName = "background: orange;" + " " + borderStyleWarning;
                $scope.TempMrzStatus = StatusScan.WARNING;
            }
        }
        $scope.CompareDateOfBirtWithMrz = function () {
            var borderStyle = ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN) ? "border: red 2px solid ;flex:1;" : "border: green 2px solid ;flex:1;";

            var Personal_Data_BirthDate_Compare = $scope.VA.Personal_Data_BirthDate.substring(2, 10);
            var Mrz_BirthDate_compare;
            if ($scope.VA.Mrz_BirthDate == undefined || $scope.VA.Mrz_BirthDate == "")
                Mrz_BirthDate_compare = "";
            else
                Mrz_BirthDate_compare = $scope.VA.Mrz_BirthDate.substring(2, 10);
            if (Mrz_BirthDate_compare === undefined || Personal_Data_BirthDate_Compare === Mrz_BirthDate_compare || (Mrz_BirthDate_compare === "")) {
                $scope.VA.Css_BirthDate = " " + borderStyle;
            }
            else {
                $scope.VA.Css_BirthDate = "background: orange;" + " " + borderStyleWarning;
                $scope.TempMrzStatus = StatusScan.WARNING;
            }
        }

        $scope.CompareNationalityWithMrz = function () {
            var borderStyle = ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN) ? "border: red 2px solid ;flex:1;" : "border: green 2px solid ;flex:1;";
            if ($scope.VA.Mrz_NationalityId === $scope.VA.Personal_Data_NationalityId) {
                $scope.VA.Css_Nationality = " " + borderStyle;
            }
            else {
                $scope.VA.Css_Nationality = "background: orange;" + " " + borderStyleWarning;
                $scope.TempMrzStatus = StatusScan.WARNING;
            }
        }
        $scope.CompareValiddUntilWithMrz = function () {
            var borderStyle = ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN) ? "border: red 2px solid ;flex:1;" : "border: green 2px solid ;flex:1;";
            var TravelDocument_ValidUntil_Compare = $scope.VA.TravelDocument_ValidUntil.substring(0, 6);
            var Mrz_ValidUntil_Compare = $scope.VA.Mrz_ValidUntil.substring(0, 6);
            var TravelDocument_ValidUntil_Decade = $scope.VA.TravelDocument_ValidUntil.substring(8, 10);
            var Mrz_ValidUntil_Decade = $scope.VA.Mrz_ValidUntil.substring(8, 10);
            if (TravelDocument_ValidUntil_Compare === Mrz_ValidUntil_Compare && TravelDocument_ValidUntil_Decade === Mrz_ValidUntil_Decade) {

                $scope.VA.Css_ValidUntil = " " + borderStyle;
            }
            else {
                $scope.VA.Css_ValidUntil = "background: orange;" + " " + borderStyleWarning;
                $scope.TempMrzStatus = StatusScan.WARNING;
            }

        }

        $scope.CompareDocumentNumberWithMrz = function () {
            var borderStyle = ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN) ? "border: red 2px solid ;flex:1;" : "border: green 2px solid ;flex:1;";
            if ($scope.VA.Mrz_DocumentNumber === $scope.VA.TravelDocument_DocumentNumber) {
                $scope.VA.Css_DocumentNumber = " " + borderStyle;
            }
            else {
                $scope.VA.Css_DocumentNumber = "background: orange;" + " " + borderStyleWarning;
                $scope.TempMrzStatus = StatusScan.WARNING;
            }

        }

        $scope.compareIssuingAuthorityCountryIdWithMrz = function () {
            var borderStyle = ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN) ? "border: red 2px solid ;flex:1;" : "border: green 2px solid ;flex:1;";
            if ($scope.VA.Mrz_IssuingAuthorityCountryId === $scope.VA.TravelDocument_IssuingAuthorityCountryId) {
                $scope.VA.Css_IssuingAuthorityCountry = " " + borderStyle;
            }
            else {
                $scope.VA.Css_IssuingAuthorityCountry = "background: orange;" + " " + borderStyleWarning;
                $scope.TempMrzStatus = StatusScan.WARNING;
            }


        }

        $scope.comparePersonal_Data_GenderIdWithMrz = function () {
            var borderStyle = ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN) ? "border: red 2px solid ;flex:1;" : "border: green 2px solid ;flex:1;";
            if ($scope.VA.Mrz_GenderId === $scope.VA.Personal_Data_GenderId) {
                $scope.VA.Css_Gender = " " + borderStyle;
            }
            else {
                $scope.setsexValue();
                $scope.VA.Css_Gender = "background: orange;" + " " + borderStyleWarning;
                $scope.TempMrzStatus = StatusScan.WARNING;
            }


        }


        $scope.doSetDateOfBirth = function () {

            $scope.VA.Personal_Data_BirthDate = $scope.Year + "-" + $scope.Month + "-" + $scope.Day;
            if (typeof $scope.VA.Application_VisaTypeRequestedId != "undefined" && $scope.VA.Application_VisaTypeRequestedId) {
                if ($scope.VA.Application_VisaTypeRequestedId === 2 && !$scope.isUnderXYears($scope.VA.Personal_Data_BirthDate, $scope.VA.DateOfApplication, 6) && $scope.VA.Application_GratuityId === 9) {
                    $scope.VA.Application_GratuityId = null;
                }
                if ($scope.VA.Application_VisaTypeRequestedId === 2 && !$scope.isUnderXYears($scope.VA.Personal_Data_BirthDate, $scope.VA.DateOfApplication, 6) && $scope.VA.Application_GratuityId === 16) {
                    $scope.VA.Application_GratuityId = null;
                }
            }
            for (var i = 0; i < $scope.FingerprintExemptions.length; i++) {
                if ($scope.VA.Application_FingerprintExemptionId == $scope.FingerprintExemptions[0].Value) {
                    if ($scope.FingerprintExemptions[0].Age !== undefined && (!$scope.isUnderXYears($scope.VA.Personal_Data_BirthDate, $scope.VA.DateOfApplication, $scope.FingerprintExemptions[0].Age))) {
                        $scope.VA.Application_FingerprintExemptionId = null;
                    }
                    break;
                }
            }
            $scope.calcVisaFeeWaiver();
            $scope.calcFingerprintExemption();
            $scope.CompareDateOfBirtWithMrz();
        };

        $scope.doGetDateOfBirth = function () {
            if (typeof $scope.VA.Personal_Data_BirthDate != "undefined" && $scope.VA.Personal_Data_BirthDate) {
                $scope.Year = $scope.VA.Personal_Data_BirthDate.substring(0, 4);
                $scope.Month = $scope.VA.Personal_Data_BirthDate.substring(5, 7);
                $scope.Day = $scope.VA.Personal_Data_BirthDate.substring(8, 10);
            }
        };

        //$scope.doSetDateOfBirthEU = function () {
        //    $scope.VA.EUFamilyMember.BirthDate.Day = $scope.EUYear + "/" + $scope.EUMonth + "/" + $scope.EUDay;
        //    $scope.VA.EUFamilyMember.BirthDate.Day = $scope.EUDay;
        //    $scope.VA.EUFamilyMember.BirthDate.Month = $scope.EUMonth;
        //    $scope.VA.EUFamilyMember.BirthDate.Year = $scope.EUYear;
        //    //$scope.VA.EUFamilyMember.BirthDate

        //};

        //$scope.doGetDateOfBirthEU = function () {
        //    if (typeof $scope.VA.EUFamilyMember.BirthDate != "undefined" && $scope.VA.EUFamilyMember.BirthDate) {
        //        $scope.EUYear = $scope.VA.EUFamilyMember.BirthDate.Year;
        //        $scope.EUMonth = $scope.VA.EUFamilyMember.BirthDate.Month;
        //        $scope.EUDay = $scope.VA.EUFamilyMember.BirthDate.Day;
        //    }
        //};

        $scope.doGetDateOfBirthPerson = function (guid) {

            var personDate = null;
            for (var i = 0; i < $scope.VA.References.length; i++) {
                if ($scope.VA.References[i].Id === guid) {
                    personDate = $scope.VA.References[i];
                }
            }
            if (typeof personDate != "undefined" && personDate) {

                if (personDate.Person_BirthDate) {
                    if (personDate.Person_BirthDate.Year)
                        $("#DateOfBirth_Year_" + guid + " option[label='" + personDate.Person_BirthDate.Year + "']").prop("selected", "selected");
                    if (personDate.Person_BirthDate.Month)
                        $("#DateOfBirth_Month_" + guid + " option[label='" + personDate.Person_BirthDate.Month + "']").prop("selected", "selected");
                    if (personDate.Person_BirthDate.Day)
                        $("#DateOfBirth_Day_" + guid + " option[label='" + personDate.Person_BirthDate.Day + "']").prop("selected", "selected").change();
                }
            }
        }

        $scope.doSetDateOfBirthPerson = function (guid) {

            var personDate = null;
            for (var i = 0; i < $scope.VA.References.length; i++) {
                if ($scope.VA.References[i].Id === guid) {
                    personDate = $scope.VA.References[i];

                    if ($scope.VA.References[i].Person_BirthDate == null)
                        $scope.VA.References[i].Person_BirthDate = {};
                    $scope.VA.References[i].Person_BirthDate.Day = $("#DateOfBirth_Day_" + guid + " option:selected").attr("label");
                    $scope.VA.References[i].Person_BirthDate.Month = $("#DateOfBirth_Month_" + guid + " option:selected").attr("label");
                    $scope.VA.References[i].Person_BirthDate.Year = $("#DateOfBirth_Year_" + guid + " option:selected").attr("label");
                }
            }
        }

        $scope.isInvitingPersonFilled = function () {
            return ($scope.checkbox1 || $scope.checkbox2 || $scope.checkbox3);
        };
        $scope.isInvitingOganisationFilled = function () {
            return ($scope.checkbox1 || $scope.checkbox2 || $scope.checkbox3);
        };

        //#BEGIN REGION SPONSOR dynamic add
        $scope.addReferencePerson = function (selectedSponsor) {
            if (typeof $scope.VA.References == "undefined") {
                $scope.VA.References = [];
            }

            if (selectedSponsor === "SponsorApplicant") {
                $scope.VA.Personal_Data_Sponsor = true;
            }

            if (selectedSponsor === "SponsorGuardianParent1") {
                $scope.VA.Guardian_Parent1.Sponsor = true;
            }

            if (selectedSponsor === "SponsorGuardianParent2") {
                $scope.VA.Guardian_Parent2.Sponsor = true;
            }

            if (selectedSponsor === "SponsorOccupation") {
                $scope.VA.Personal_Occupation.Sponsor = true;
            }

            var x = $scope.VA.References.length + 1;

            //set selected sponsorType true
            for (var i = 0; i < $scope.VA.References.length; i++) {
                if ($scope.VA.References[i].Id === selectedSponsor) {
                    $scope.VA.References[i].Sponsor = true;
                }
            }

            if (selectedSponsor === "Other") {
                //Create new row if other
                $scope.getNewGuidAsync().then(function (nGuid) {
                    $scope.VA.References.push({ "Id": nGuid.data, "Sponsor": true, "SchoolID": null, "Accompany": null, "Signaled": null, "Organisation_Number": null, "Organisation_Name": null, "Organisation_Address": { Street: "", HouseNumber: "", City: "", PostalCode: "", CountryId: "" }, "Organisation_VATNumber": null, "Organisation_TelephoneNumber": null, "Organisation_EMail": null, "Person_Number": null, "Person_FirstName": null, "Person_LastName": null, "Person_Address": { Street: "", City: "", PostalCode: "", CountryId: "" }, "Person_Organisation": null, "Person_Gender": null, "Person_Nationality": null, "Person_BirthCity": null, "Person_BirthPlaceCountry": null, "Person_BirthDate": null, "Person_BirthNationality": null, "Person_BirthLastName": null, "Person_Occupation": null, "Person_CivilState": null, "Person_ExtendedMinor": null, "Person_TelephoneNumber": null, "Person_MobileNumber": null, "Person_EMail": null, "Deleted": false });
                }, function (error) {
                });
            }

            //If new controlls are added we need to register the trigger (modal popup) google search
            $timeout(function () { $(".md-trigger").modalEffects(); });
        };
        $scope.rt = function () {
            return true;
        };

        $scope.getNewGuidAsync = function () {
            var exceptionDeferred = $q.defer();
            CodeTypeService.getNewGuid().then(function (d) {
                exceptionDeferred.resolve(d);
            }, function (error) {
                exceptionDeferred.resolve(null);
            });
            return exceptionDeferred.promise;
        };

        $scope.possibleSponsorTypes = [];
        $scope.calcSponsorTypes = function () {
            var sponsorTypes = [];
            //if the list is not undefined
            if (typeof $scope.Lists != "undefined" && $scope.Lists) {
                //For every value in the actorsubtype list
                for (var i = 0; i < $scope.Lists.ActorSubTypes.length; i++) {
                    //If Minor
                    if ($scope.isMinor($scope.VA.Personal_Data_BirthDate, $scope.VA.Personal_Data_ExtendedMinor, $scope.VA.DateOfApplication)) {
                        //Remove Guardian_Parent1 from sponsorTypes list if already chosen
                        if ($scope.VA.Guardian_Parent1.Sponsor !== true) {
                            //If selected actorsubtype == PARENTALAUTHORITY add the transmated value to the list
                            if ($scope.VA.Guardian_Parent1.ActorSubTypeId === ACTOR.SUBTYPES.PARENTALAUTHORITY && $scope.Lists.ActorSubTypes[i].Value === ACTOR.SUBTYPES.PARENTALAUTHORITY) {
                                sponsorTypes.push({ Value: 'SponsorGuardianParent1', Text: $scope.Lists.ActorSubTypes[i].Text + ' 1' });
                            }
                            //If selected actorsubtype == LEGALGUARDIAN add the transmated value to the list
                            if ($scope.VA.Guardian_Parent1.ActorSubTypeId === ACTOR.SUBTYPES.LEGALGUARDIAN && $scope.Lists.ActorSubTypes[i].Value === ACTOR.SUBTYPES.LEGALGUARDIAN) {
                                sponsorTypes.push({ Value: 'SponsorGuardianParent1', Text: $scope.Lists.ActorSubTypes[i].Text + ' 1' });
                            }
                        }

                        //Remove Guardian_Parent2 from sponsorTypes list if already chosen
                        if ($scope.VA.ShowParent2 && $scope.VA.Guardian_Parent2.Sponsor !== true) {
                            //If selected actorsubtype == PARENTALAUTHORITY add the transmated value to the list
                            if ($scope.VA.Guardian_Parent2.ActorSubTypeId === ACTOR.SUBTYPES.PARENTALAUTHORITY && $scope.Lists.ActorSubTypes[i].Value === ACTOR.SUBTYPES.PARENTALAUTHORITY) {
                                sponsorTypes.push({ Value: 'SponsorGuardianParent2', Text: $scope.Lists.ActorSubTypes[i].Text + ' 2' });
                            }
                            //If selected actorsubtype == LEGALGUARDIAN add the transmated value to the list
                            if ($scope.VA.Guardian_Parent1.ActorSubTypeId === ACTOR.SUBTYPES.LEGALGUARDIAN && $scope.Lists.ActorSubTypes[i].Value === ACTOR.SUBTYPES.LEGALGUARDIAN) {
                                sponsorTypes.push({ Value: 'SponsorGuardianParent2', Text: $scope.Lists.ActorSubTypes[i].Text + ' 2' });
                            }
                        }
                    }

                    //Remove occupation from sponsorTypes list if already chosen
                    if ($scope.VA.Personal_Occupation.Sponsor !== true) {
                        //If selected actorsubtype == OCCUPATIONEMPLOYER add the transmated value to the list
                        if ($scope.VA.Personal_Occupation.ActorSubTypeId === ACTOR.SUBTYPES.OCCUPATIONEMPLOYER && $scope.Lists.ActorSubTypes[i].Value === ACTOR.SUBTYPES.OCCUPATIONEMPLOYER) {
                            sponsorTypes.push({ Value: "SponsorOccupation", Text: $scope.Lists.ActorSubTypes[i].Text });
                        }
                        //If selected actorsubtype == OCCUPATIONEDUCATIONALESTABLISHMENT add the transmated value to the list
                        if ($scope.VA.Personal_Occupation.ActorSubTypeId === ACTOR.SUBTYPES.OCCUPATIONEDUCATIONALESTABLISHMENT && $scope.Lists.ActorSubTypes[i].Value === ACTOR.SUBTYPES.OCCUPATIONEDUCATIONALESTABLISHMENT) {
                            sponsorTypes.push({ Value: "SponsorOccupation", Text: $scope.Lists.ActorSubTypes[i].Text });
                        }
                    }

                    if ($scope.Lists.ActorSubTypes[i].Value === ACTOR.SUBTYPES.VISAAPPLICANT && $scope.VA.Personal_Data_Sponsor !== true) {
                        sponsorTypes.push({ Value: "SponsorApplicant", Text: $scope.Lists.ActorSubTypes[i].Text });
                    }

                    if (typeof $scope.VA.References != "undefined" && $scope.VA.References) {
                        for (var j = 0; j < $scope.VA.References.length; j++) {
                            //if it is a 31 but not a accomodation and not already chosen
                            if ($scope.Lists.ActorSubTypes[i].Value === ACTOR.SUBTYPES.REFERENCEPERSON && $scope.VA.References[j].ActorSubType === ACTOR.SUBTYPES.REFERENCEPERSON && $scope.VA.References[j].Sponsor !== true && $scope.VA.References[j].Invitation === true && $scope.VA.References[j].ActorSubType !== 0) {
                                sponsorTypes.push({ Value: $scope.VA.References[j].Id, Text: $scope.Lists.ActorSubTypes[i].Text + ": " + $scope.getPersonFullName($scope.VA.References[j]) });
                            }

                            //if it is a 32 and not already chosen
                            if ($scope.Lists.ActorSubTypes[i].Value === ACTOR.SUBTYPES.REFERENCECOMPANY && $scope.VA.References[j].ActorSubType === ACTOR.SUBTYPES.REFERENCECOMPANY && $scope.VA.References[j].Sponsor !== true && $scope.VA.References[j].Invitation === true && $scope.VA.References[j].ActorSubType !== 0) {
                                sponsorTypes.push({ Value: $scope.VA.References[j].Id, Text: $scope.Lists.ActorSubTypes[i].Text + ": " + $scope.getOrganisationFullName($scope.VA.References[j]) });
                            }
                            if ($scope.Lists.ActorSubTypes[i].Value === ACTOR.SUBTYPES.REFERENCESCHOOL && $scope.VA.References[j].ActorSubType === ACTOR.SUBTYPES.REFERENCESCHOOL && $scope.VA.References[j].Sponsor !== true && $scope.VA.References[j].Invitation === true && $scope.VA.References[j].ActorSubType !== 0) {
                                sponsorTypes.push({ Value: $scope.VA.References[j].Id, Text: $scope.Lists.ActorSubTypes[i].Text + ": " + $scope.getOrganisationFullName($scope.VA.References[j]) });
                            }
                        }
                    }
                }
            }

            $scope.possibleSponsorTypes = sponsorTypes;
        };

        $scope.getPersonFullName = function (actor) {
            var returnValue = "";

            if (typeof actor.Person_FirstName != "undefined" && actor.Person_FirstName) {
                returnValue += actor.Person_FirstName + " ";
            }

            if (typeof actor.Person_LastName != "undefined" && actor.Person_LastName) {
                returnValue += actor.Person_LastName;
            }

            return returnValue;
        };
        $scope.getOrganisationFullName = function (actor) {
            var returnValue = "";

            if (typeof actor.Organisation_Name != "undefined" && actor.Organisation_Name) {
                returnValue += actor.Organisation_Name;
            }

            return returnValue;
        };

        $scope.$watch('personYear', function () {

        });

        $scope.$watch('personMonth', function () {
        });

        $scope.$watch('personDay', function () {
        });

        $scope.$watch("InvitingPerson[0].ActorSubType", function () {

            if (typeof $scope.InvitingPerson != "undefined" && $scope.InvitingPerson && $scope.InvitingPerson[0].ActorSubType === 6) {
                $scope.InvitingPerson[0].ActorType = 4;
            }

            if (typeof $scope.InvitingPerson != "undefined" && $scope.InvitingPerson && $scope.InvitingPerson[0].ActorSubType === 7) {
                $scope.InvitingPerson[0].ActorType = 5;
            }

            if (typeof $scope.InvitingPerson != "undefined" && $scope.InvitingPerson) {
                if ((typeof $scope.InvitingPerson[0] !== "undefined") && $scope.InvitingPerson[0] && ($scope.InvitingPerson[0].ActorSubType === 10 || $scope.InvitingPerson[0].ActorSubType === 6)) {
                    $scope.InvitingPerson[0].Sponsor = false;
                }
            }
            if (typeof $scope.InvitingPerson != "undefined" && $scope.InvitingPerson)
                if ((typeof $scope.InvitingPerson[0] !== "undefined") && $scope.InvitingPerson[0])
                    if (typeof $scope.InvitingPerson[0].ActorSubType === "undefined") {
                        $scope.InvitingPerson[0].ActorSubType = 0;
                        $scope.InvitingPerson[0].Deleted = true;
                    }
        });
        $scope.$watch("InvitingOrganisation[0].ActorSubType", function () {

            if (typeof $scope.InvitingOrganisation != "undefined" && $scope.InvitingOrganisation) {
                $scope.InvitingOrganisation[0].ActorType = 6;
            }
            if (typeof $scope.InvitingOrganisation != "undefined" && $scope.InvitingOrganisation)
                if ((typeof $scope.InvitingOrganisation[0] !== "undefined") && $scope.InvitingOrganisation[0])
                    if (typeof $scope.InvitingOrganisation[0].ActorSubType === "undefined") {
                        $scope.InvitingOrganisation[0].ActorSubType = 0;
                        $scope.InvitingOrganisation[0].Deleted = true;
                    }

        });
        $scope.$watchCollection("VA.References", function () {
            $("#scrollBlock").scrollspy("refresh");
        });

        $scope.removeReferencePerson = function (item) {
            var index = $scope.VA.References.indexOf(item);
            if ((item.ActorType === ACTOR.TYPES.REFERENCEPERSON || item.ActorType === ACTOR.TYPES.REFERENCEORGANISATION) && item.Invitation) {
                item.Sponsor = false; //don't remove record used for Inviting Person And InvitingOrganisation
            } else {
                if (item.Id != "undefined") {
                    item.Deleted = true;
                } else {
                    $scope.VA.References.splice(index, 1);
                }

            }
        };
        $scope.removeSponsorApplicant = function () {
            $scope.VA.Personal_Data_Sponsor = false;
        };
        $scope.removeSponsorOccupation = function () {
            $scope.VA.Personal_Occupation.Sponsor = false;
        };
        $scope.removeGuardianParent1 = function () {
            $scope.VA.Guardian_Parent1.Sponsor = false;
        };
        $scope.removeGuardianParent2 = function () {
            $scope.VA.Guardian_Parent2.Sponsor = false;
        };
        $scope.isReferenceTypeMyself = function () {
            if (this.ref.SponsorType === "I") {
                this.ref.ReferenceType = 32; //applicant
            }
        };
        //#END REGION SPONSOR
        //Validate OSnumber
        $scope.showInvalidOsUniqueId = function () {
            return (!$scope.IsValidNewOsUniqueId) && $scope.ValidateOsUniqueIdProcessed;
        };

        $scope.saveForm = function () {
            $scope.save("Save");
        };
        $scope.saveCommentForm = function () {
            $scope.save("SaveComment");
        };
        $scope.submitForm = function () {
            $scope.save("Submit", 2);
        };
        $scope.validateForm = function () {
            $scope.save("Validate", 2);
        };
        $scope.ignoreSchengen = function () {

            $scope.VA.Ignored = true; $scope.showArrow = false;
            $scope.currentStatus = StatusScan.OKIGNORED;
            $scope.save("Save");
            $scope.currentStatus = $scope.VA.StatusScan;
            $scope.VA.Ignored = ($scope.currentStatus == StatusScan.OKIGNORED || $scope.currentStatus == StatusScan.NOSCANIGNORED);
            $scope.checkBoxIgnored = ($scope.currentStatus == StatusScan.WARNING || $scope.currentStatus == StatusScan.NOSCAN);
            $scope.ArrowShow = ($scope.currentStatus == StatusScan.WARNING);
            $scope.MrzCheckBoxChecked = true;
        };

        $scope.schengenOverwritten = function () {

            $scope.VA.Overwritten = true;
            $scope.currentStatus = StatusScan.OKOVERWRITTEN;
            $scope.save("Save");
            $scope.currentStatus = $scope.VA.StatusScan;
            $scope.VA.Overwritten = $scope.currentStatus == StatusScan.OKOVERWRITTEN;
            $scope.checkBoxIgnored = ($scope.currentStatus == StatusScan.WARNING || $scope.currentStatus == StatusScan.NOSCAN);
            $scope.ArrowShow = ($scope.currentStatus == StatusScan.WARNING);
        }
        $scope.verifyForm = function () {
            $scope.save("Verify");
        };
        $scope.completeForm = function () {
            $scope.save("Complete");
        };

        $scope.addApplicationToTheJourney = function () {
            $scope.save("AddApplicationToTheJourney");
        };

        $scope.putApplicationOnHold = function () {
            $scope.save("PutApplicationOnHold");
        }
        $scope.updateApplicationDate = function () {
            $scope.save("UpdateApplicationDate");
        }

        $scope.printForm = function () {
            $window.location.href = "/" + $window.location.pathname.replace(/^\/([^\/]*).*$/, "$1") + "nl/VisaApplication/PrintReceipt?AppId=" + $scope.AppId;
        };


        $scope.PromptDeleteScanClose = function (event) {
            $('#scanPassportAndMrzModalContent').removeClass("mrzOpacity");
            $scope.closemodal(event);
        }
        $scope.PromptDeleteScanOk = function (event) {
            $scope.deleteScan();
            $('#scanPassportAndMrzModalContent').removeClass("mrzOpacity");

            $scope.closemodal(event);
            $('#scanPassportAndMrzModal').removeClass("md-show");
        }



        $scope.PromptDeleteBiometricClose = function (event) {

            $('#BasicInformation').removeClass("mrzOpacity");
            $('#PromptDeleteBimetryModal').removeClass("md-show");
            $scope.closemodal(event);
        }
        $scope.PromptDeleteBiometricOk = function (event) {
            //$scope.deleteScan();
            /*        $('#osOnlineBody').addClass("mrzOpacity");
            $('#PromptDeleteBimetryModal').addClass("md-show");*/
            $('#BasicInformation').removeClass("mrzOpacity");
            $('#PromptDeleteBimetryModal').removeClass("md-show");
            $scope.closemodal(event);
            $scope.deleteBiometric();
            //to do event to delete the biometric data

        }

        $scope.closeWarningAppointmentModal = function () {
            $('#warningAppointmentModal').removeClass("md-show");

        }

        $scope.manageAppointmentTakeDoc = function () {

            if ($scope.VA.CompanyPrefix == 'MSH' || $scope.VA.CompanyPrefix == 'BEL') {
                $http({
                    method: 'POST',
                    url: '/VisaApplication/ManageRdvTakeDoc',
                    params: { 'Id': $scope.VA.AppId },
                    headers: { 'Content-Type': "application/x-www-form-urlencoded" },
                    cache: false
                }).success(function (data) {
                    if (data.Success === true) {
                        var eappUrl = data.EappUrl;
                        $window.open(eappUrl, '_blank');
                    }
                });
            }
        }
        $scope.makeAppointment = function () {
            if ($scope.VA.IntendedDateOfArrivalInTheFuture === false) {
                $('#warningAppointmentModal').addClass("md-show");
            }
            else {
                
                if ($scope.VA.IsTravellerGroupQuestion === 1) {
                    $scope.appointmentUrl = '';
                    for (var i = 0; i < $scope.Lists.CompanyList.length; i++) {
                        if ($scope.VA.CompanyPrefix === $scope.Lists.CompanyList[i].CompanyPrefix) {
                            $scope.appointmentUrl = $scope.Lists.CompanyList[i].AppointmentUrl;
                        }
                    }

                    $http({
                        method: 'POST',
                        url: '/VisaApplication/CreateRdv',
                        params: { 'Id': $scope.VA.AppId },
                        headers: { 'Content-Type': "application/x-www-form-urlencoded" },
                        cache: false
                    }).success(function (data) {
                        if (data.Success === false) {
                            $scope.Errors = [];
                            $scope.ErrorMessage = data.ErrorMessage;

                        }
                        else {
                            $scope.VA.SubGroupId = data.VA.SubGroupId;
                            $scope.AppointmentTaken = $scope.VA.SubGroupId !== undefined && $scope.VA.SubGroupId !== null;
                           
                            if ($scope.VA.CompanyPrefix == "MSH" || $scope.VA.CompanyPrefix == "BEL" || data.eappUrl !== undefined)
                            {
                                var eappUrl = data.EappUrl;
                                $window.open(eappUrl, '_blank');
                            }
                            else {
                                var outsourcerWebsite = $scope.appointmentUrl.concat(data.infoToSent);
                                $window.open(outsourcerWebsite, '_blank');
                            }


                        }

                    }).error(function () {
                    });

                }
                else {

                    var subGroupId = $scope.VA.SubGroupId;
                    if (subGroupId != undefined) {

                        if ($scope.VA.CompanyPrefix == 'MSH' || $scope.VA.CompanyPrefix == 'BEL') {
                            $http({
                                method: 'POST',
                                url: '/VisaApplication/ManageRdv',
                                params: { 'Id': $scope.VA.AppId },
                                headers: { 'Content-Type': "application/x-www-form-urlencoded" },
                                cache: false
                            }).success(function (data) {
                                if (data.Success === true) {
                                    var eappUrl = data.EappUrl;
                                    $window.open(eappUrl, '_blank');
                                }
                            });
                        }
                        else {
                            $http({
                                method: "Get",
                                url: "/common/GetJsonGroupBySubGroupId",
                                cache: false,
                                params: {
                                    'SubGroupId': $scope.VA.SubGroupId
                                },
                            }).success(function (data) {
                                requestdata = { info: data.infoToSent };
                                $scope.appointmentUrl = '';
                                for (var i = 0; i < $scope.Lists.CompanyList.length; i++) {
                                    if ($scope.VA.CompanyPrefix === $scope.Lists.CompanyList[i].CompanyPrefix) {
                                        $scope.appointmentUrl = $scope.Lists.CompanyList[i].AppointmentUrl;
                                    }
                                }
                                // if ($scope.VA.CompanyPrefix === 'VFS') {
                                var outsourcerWebsite = $scope.appointmentUrl.concat(data.infoToSent);
                                $window.open(outsourcerWebsite, '_blank');
                                //}
                                //else
                                //{
                                //    $.post($scope.appointmentUrl,
                                //   requestdata,
                                //   function (data) {
                                //       var w = window.open('about:blank');
                                //       w.document.open();
                                //       w.document.write(data);
                                //       w.document.close();
                                //   });
                                //}

                            });
                        }

                    }
                    else {
                        $window.location.href = '/' + $window.location.pathname.replace(/^\/([^\/]*).*$/, '$1') + '/VisaApplication/IndexGroupByVacoreId/' + $scope.VA.AppId;
                    }
                }
            }
        }
        // $scope.eAppointmentUrl = '';

        //$scope.getEAppointmentUrl = function () {
        //    $http({
        //        method: 'Get',
        //        url: '/Common/GetEAppointmentUrl',
        //        params: { 'id': $scope.VA.AppId },
        //        cache: false
        //    }).success(function (data) {
        //        $scope.eAppointmentUrl = data.url;

        //    }).error(function () {
        //    });
        //}


        $scope.saveDecisionReady = function () {
            $http({
                method: 'POST',
                url: '/ReceiveDocument/SaveDecisionReady',
                params: { 'id': $scope.VA.AppId },
                headers: { 'Content-Type': "application/x-www-form-urlencoded" },
                cache: false
            }).success(function (data) {
                if (data.Success === false) {
                    $scope.Errors = [];
                    $scope.ErrorMessage = data.ErrorMessage;

                }
                else {
                    messageService.sendSuccessMessage(data.SuccessMessage);
                    $scope.VA = data.VA;
                    if (typeof data.rights != "undefined" && data.rights) {
                        $scope.rights = data.rights;
                    }

                }

            }).error(function () {
            });
        }




        $scope.redirectToOutsourcerWebsite = function () {
            var outsourcerWebsite = $scope.VA.Vac_AppointmentWebsite;
            $window.open(outsourcerWebsite, '_blank');

        }

        $scope.deleteScan = function () {
            var canViewBiometricInfo = $scope.VA.CanViewBiometricInfo;

            $http({
                method: "POST",
                url: "/VisaApplication/DeleteScan",
                data: $.param($scope.VA),
                headers: {
                    'Content-Type': "application/x-www-form-urlencoded"
                }
            }).success(function (data) {
                $scope.VA = data.VA;
                $scope.VA.CanViewBiometricInfo = canViewBiometricInfo;
                $scope.currentStatus = $scope.VA.StatusScan;
                if ($scope.currentStatus == StatusScan.NOTAPPLICABLE) {
                    $scope.IsScanPictureClick = false;
                }
                $scope.checkBoxIgnored = true;
                $scope.InitializeMrz();
                $scope.MRZ_BirthDateFormat = "-";
                $scope.MRZ_ValidityDateFormat = "-";
                $scope.closemodal;
            });


        }

        $scope.deleteBiometric = function () {

            $http({
                method: "POST",
                url: "/VisaApplication/DeleteBiometric",
                params: { 'Id': $scope.VA.AppId },
                headers: {
                    'Content-Type': "application/x-www-form-urlencoded"
                }
            }).success(function (data) {
                if (data.Success === false) {
                    $scope.Errors = [];
                    messageService.sendErrorMessage(data.ErrorMessage);

                }
                else {
                    $scope.VA.HasFingerprints = false;
                    $scope.UpdateFingerPrintPicture();
                    $scope.VA.HasFingerprints = false;
                    $scope.Picture = data.Picture;

                    messageService.sendSuccessMessage(data.SuccessMessage);
                }

            });


        }

        $scope.saveDocumentRetrieve = function () {
            $http({
                method: 'POST',
                url: '/RetrieveDocument/SaveRetrieveDocument',
                data: $.param($scope.VA),
                headers: {
                    'Content-Type': "application/x-www-form-urlencoded"
                },
                cache: false
            }).success(function (data) {
                if (data.Success === false) {
                    $scope.Errors = [];
                    $scope.ErrorMessage = data.ErrorMessage;

                }
                else {
                    messageService.sendSuccessMessage(data.SuccessMessage);
                    $scope.VA = data.VA;
                    if (typeof data.rights != "undefined" && data.rights) {
                        $scope.rights = data.rights;
                    }
                }
            }).error(function () {
            });
        }

        $scope.getBioFromBioMod = function () {
            $scope.sourceFingerPrintImage = "../../../content/images/loading.gif";

            $http({
                method: 'GET',
                url: '/Common/GetBiometricsFromBioMod',
                params: { 'AppId': $scope.VA.AppId },
                cache: false
            }).success(function (data) {
                if (data.Success === false) {
                    $scope.Errors = [];
                    //$scope.ErrorMessage = data.ErrorMessage;
                    messageService.sendErrorMessage(data.ErrorMessage);
                }
                else {
                    if (data.HasPicture === true) {
                        $scope.Picture = data.Picture;
                    }

                    if (data.HasFingerprints === true) {
                        $scope.VA.HasFingerprints = true;
                    }

                    if (typeof data.rights != "undefined" && data.rights) {
                        $scope.rights = data.rights;
                    }
                }

                $scope.UpdateFingerPrintPicture();
            }).error(function () {
            });
        }

        $scope.DisableIsGroupQuestion = function () {
            return $scope.VA.StatusId !== 1 || $scope.VA.GroupId !== null;

        }




        $scope.IsGroup = function () {
            var result = $scope.VA.GroupId != null;
            return result;

        }



        $scope.save = function (urlString, newStatusId) {
            if ($scope.isPerformingServerAction === false) {
                $scope.VA.StatusScan = $scope.currentStatus;
                if ($scope.VA.StatusScan == StatusScan.WARNING) {
                    if ($scope.VA.Overwritten === true)
                        $scope.VA.Overwritten = false;
                    if ($scope.VA.Ignored === true)
                        $scope.VA.Ignored = false;

                }
                $scope.VA.OnlyNationals = $scope.SetOnlyNationals();
                $scope.isPerformingServerAction = true;
                $scope.SuccessMessage = "";
                $scope.ErrorMessage = "";
                $scope.Errors = [];
                $scope.VA.Confirm_Email = $scope.confirmEmail;
                uiErrorService.removeControlErrors();

                $scope.VA.ClientDateTime = $filter('date')(new Date(), 'dd/MM/yyyy HH:mm:ss');
                //$scope.VA.Application_Comment = $scope.escapeHtml($scope.VA.Application_Comment);
                if ($scope.VA.Application_AddComment != null) {
                    $scope.VA.Application_Comment = $scope.escapeHtml($scope.VA.Application_Comment);
                }

                //var phoneNumberUtil = i18n.phonenumbers.PhoneNumberUtil.getInstance();
                var phonesValid = true;

                if (urlString == "Submit") {
                    $("input[data-val-phonenumber]").each(function (key, val) {
                        if ($(val).val() != null && $(val).val() != undefined && $(val).val() != "") {
                            var pvalid = true;
                            try {
                                var number = $(val).val();//phoneNumberUtil.parseAndKeepRawInput($(val).val());

                                pvalid = libphonenumber.isValidPhoneNumber(number); //phoneNumberUtil.isPossibleNumber(number);


                            } catch (e) {
                                pvalid = false;

                            }
                            if (pvalid == false) {
                                $scope.Errors.push({ Key: $(val).attr("id"), Value: [$(val).attr("data-val-phonenumber")] });
                                phonesValid = false;
                                $scope.VA.PhoneValid = phonesValid;
                            }
                        }
                    });
                }

                $http({
                    method: "POST",
                    url: "/VisaApplication/" + urlString,
                    data: $.param($scope.VA),
                    headers: {
                        'Content-Type': "application/x-www-form-urlencoded"
                    }
                }).success(function (data) {

                    if (data.Success === false) {

                        if (!phonesValid) {
                            var newErrorList = [];
                            if (data.ModelErrors !== undefined && data.ModelErrors !== null) {
                                for (var i = 0; i < data.ModelErrors.length; i++) {
                                    var error = data.ModelErrors[i];
                                    for (var j = 0; j < $scope.Errors.length; j++) {
                                        var cerror = $scope.Errors[j];

                                        if (cerror.Value[0].indexOf(error.Value[0].substring(0, 4)) >= 0 && !cerror.handled) {
                                            newErrorList.push(cerror);
                                            $scope.Errors[j].handled = true;
                                        }
                                    }
                                    newErrorList.push(data.ModelErrors[i]);
                                }
                            }


                            for (var i = 0; i < $scope.Errors.length; i++) {
                                if (!$scope.Errors[i].handled) {
                                    newErrorList.push($scope.Errors[i]);
                                }
                            }

                            $scope.Errors = newErrorList;
                        }
                        else {
                            $scope.Errors = data.ModelErrors;
                        }

                        uiErrorService.setControlErrors($scope.Errors);
                        $(".back-to-top").triggerHandler("click");
                    } else {
                        if (urlString == "Submit") {
                            location.href = location.href;
                            //  $scope.getEAppointmentUrl();
                        }
                        if (urlString === "AddApplicationToTheJourney") {
                            $window.location.href = '/' + $window.location.pathname.replace(/^\/([^\/]*).*$/, '$1') + '/VisaApplication/Edit/' + data.VA.AppId;

                        }
                        else {
                            $scope.SuccessMessage = data.SuccessMessage;
                            $scope.VA = data.VA;
                            $scope.AppointmentTaken = $scope.VA.SubGroupId !== undefined && $scope.VA.SubGroupId !== null;
                            if ($scope.VA.SelectedVacCountry == null)
                                $scope.VA.SelectedVacCountry = undefined;
                            if (newStatusId != null) {
                                $scope.VA.StatusId = newStatusId;
                            }
                            //$scope.DateTimeFilter();
                            if (urlString == "UpdateApplicationDate") {
                                var url = "/" + $window.location.pathname.replace(/^\/([^\/]*).*$/, "$1") + "nl/VisaApplication/PrintVA?AppId=" + $scope.AppId + "&PrintLanguage=en-US";
                                var win = window.open(url, '_blank');
                                win.focus();
                            }
                            $scope.setsexValue();
                            $scope.initializeApplication(data);
                            $scope.currentStatus = $scope.VA.StatusScan;
                            messageService.sendSuccessMessage(data.SuccessMessage);

                        }


                    }
                    if (typeof data.rights != "undefined" && data.rights) {
                        $scope.rights = data.rights;
                    }
                    $scope.isPerformingServerAction = false;

                    $scope.MrzCheckBoxChecked = false;
                    $scope.checkBoxIgnored = $scope.VA.StatusScan == StatusScan.NOSCAN || $scope.VA.StatusScan == StatusScan.WARNING;
                    $scope.ArrowShow = $scope.VA.StatusScan == StatusScan.WARNING;
                    $scope.InitializeMrz();


                    $scope.isPermitForResidenceRequired();
                    $scope.isPermitForDestinationRequired();
                }).error(function () {

                    $scope.Errors = [];
                    $scope.ErrorMessage = "Unexpected Error";
                    $scope.isPerformingServerAction = false;
                });

            }
        }


        var renderStartDate = new Date().getTime();
        var renderEndDate;

        window.onload = getRenderTime;

        function getRenderTime() {
            renderEndDate = new Date().getTime();
            time = (renderEndDate - renderStartDate);
            $scope.LogEvent();
        }

        $scope.LogEvent = function () {
            $http({
                method: "POST",
                url: "/Common/LogRenderingClientTime",
                params: {
                    'actionName': 'getVisaApplication',
                    'time': time
                },
            }).success(function (data) {

            });
        }
        $scope.TravelDocumentTypeAllowingAllKindCountries = [3, 8, 9, 10, 11, 12, 13, 14, 15, 16];

        $scope.travelDocumentTypeChange = function () {
            if ($scope.TravelDocumentTypeAllowingAllKindCountries.includes($scope.VA.TravelDocument_DocumentTypeId)) {
                $scope.TravelDocumentCountryList = $scope.Lists.CountryTypes;
            }
            else {
                $scope.TravelDocumentCountryList = $scope.Lists.CountryNonSchengenTypes;
            }
        };
        $scope.doGetVisaApplicationDossier = function () {
            $scope.ApplicationCanBeShown = true;
            $scope.SuccessMessage = "";
            $scope.ErrorMessage = "";
            $scope.Errors = [];
            $scope.ValidateOsUniqueIdClicked = true;
            var AppId = (typeof $scope.AppId != "undefined" && $scope.AppId) ? $scope.AppId : 0;
            $http({
                method: "Get",
                url: "/common/getVisaApplication",
                cache: false,
                params: {
                    'AppId': AppId
                },
            }).success(function (data) {
                if (data.Success === true) {
                    //initialize
                    $scope.CanCompleteOrValidate = data.CanCompleteOrValidate;
                    $scope.Lists = data.Lists;
                    $scope.TravelDocumentCountryList = data.Lists.CountryNonSchengenTypes;
                    $scope.purposeofTravelCategoryFullList = data.Lists.PurposeOfTravelCategoryTypes;
                    $scope.VA = data.VA;
                    $scope.Picture = data.Picture;
                    $scope.CustomUrlBiomod = data.CustomUrlBiomod;
                    $scope.UpdateFingerPrintPicture();
                    $scope.AppointmentTaken = $scope.VA.SubGroupId !== undefined && $scope.VA.SubGroupId !== null;
                    $scope.confirmEmail = $scope.VA.Personal_Data_Email;
                    $scope.currentStatus = $scope.VA.StatusScan;
                    $scope.ownApplication = data.ownApplication;
                    $scope.bioModFetchOk = data.bioModFetchOk;
                    if ($scope.VA.VacId > 0) {
                        $scope.GetShengenCountriesByVac(true);
                    }
                    $scope.rights = data.rights;

                    $scope.anyDocument = data.anyDocument;
                    //anyDocumentTypeOneanyDocumentTypeOne
                    if (data.anyDocumentTypeOne === true) {
                        $scope.PdfStyle = $scope.PdfStyleGreen;
                    }
                    else {
                        if ($scope.anyDocument === true) {
                            $scope.PdfStyle = $scope.PdfStyleOrange;
                        }
                        else {
                            $scope.PdfStyle = $scope.PdfStyleGrey;
                        }
                    }
                    $scope.VA.choose = { choose: $scope.VA.Choose };
                    //if ($scope.VA.StatusId === 2 && data.canTakeAppointment)
                    //{
                    //    $scope.getEAppointmentUrl();
                    //}
                    $scope.showLoading = false;
                    var truc = $scope.VA.EUFamilyMember !== null && $scope.VA.EUFamilyMember.LastName !== null;
                    $scope.showUeFamilyMember = $scope.VA.GdprApproval == 1 || ($scope.VA.EUFamilyMember !== null && $scope.VA.EUFamilyMember.LastName !== null);

                    //$scope.VA.Application_VisaTypeRequestedId != undefined && ($scope.VA.Application_VisaTypeRequestedId == 1 || $scope.VA.Application_VisaTypeRequestedId == 2);


                    var passportScanVar = $("#passportScan")[0];
                    var downloadpassportScan = new Image();
                    downloadpassportScan.onload = function () {
                        passportScanVar.src = this.src;
                    }
                    downloadpassportScan.src = $("#passportScan").attr("data-url");
                    if ($scope.VA.StatusScan != undefined) {
                        $scope.checkBoxIgnored = $scope.VA.StatusScan == StatusScan.NOSCAN || $scope.VA.StatusScan == StatusScan.WARNING;
                        $scope.ArrowShow = $scope.VA.StatusScan == StatusScan.WARNING;
                        $scope.currentStatus = $scope.VA.StatusScan;
                    }
                    if ($scope.VA.Mrz_BirthDate != undefined && $scope.VA.Mrz_BirthDate != '-')
                        $scope.MRZ_BirthDateFormat = "XX" + $scope.VA.Mrz_BirthDate.slice(2, 10);
                    if ($scope.VA.Mrz_ValidUntil != undefined && $scope.VA.Mrz_BirthDate != '-')
                        $scope.MRZ_ValidityDateFormat = $scope.VA.Mrz_ValidUntil.slice(0, 6) + "XX" + $scope.VA.Mrz_ValidUntil.slice(8, 10);


                    //$scope.visaTypeRequestChange();
                    var dateOfApp = $scope.VA.DateOfApplication;
                    if ($scope.VA.StatusId < 3)
                        dateOfApp = convertDate(new Date());

                    if (typeof $scope.VA.Application_VisaTypeRequestedId != "undefined" && $scope.VA.Application_VisaTypeRequestedId) {
                        CodeTypeService.getPurposeOfTravelList($scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                            $scope.purposeOfTravelList = d.data;
                            $scope.setPurposeOfTravelDescription();
                        }
                        );
                        if (typeof $scope.VA.Application_PurposeOfTravelId != "undefined" && $scope.VA.Application_PurposeOfTravelId && $scope.VA.Application_PurposeOfTravelId > 0) {
                            if (typeof $scope.VA.Application_PurposeOfTravelCategoryId != "undefined" && $scope.VA.Application_PurposeOfTravelCategoryId && typeof $scope.VA.Application_PurposeOfTravelCategoryId != "undefined" && $scope.VA.Application_PurposeOfTravelCategoryId) {


                                CodeTypeService.getPurposeOfTravelByCategoryAndVisa($scope.VA.Application_PurposeOfTravelCategoryId, $scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                                    $scope.purposeOfTravelList = d.data;
                                    if ($scope.purposeOfTravelList.length == 1) {
                                        $scope.VA.Application_PurposeOfTravelId = $scope.purposeOfTravelList[0].Value;
                                    }
                                });


                                CodeTypeService.getPurposeOfTravelCategoryByPurposeOfTravel($scope.VA.Application_PurposeOfTravelId, $scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                                    $scope.Lists.PurposeOfTravelCategoryTypes = d.data;
                                    var categoryExistInList = false;
                                    if (typeof $scope.VA.Application_PurposeOfTravelCategoryId != "undefined" && $scope.VA.Application_PurposeOfTravelCategoryId && $scope.VA.Application_PurposeOfTravelCategoryId > 0) {
                                        var arrayLength = d.data.length;

                                        for (var i = 0; i < arrayLength; i++) {
                                            if (d.data[i].Value == $scope.VA.Application_PurposeOfTravelCategoryId) {
                                                categoryExistInList = true;
                                            }
                                        }
                                    }
                                    if (d.data.length >= 1 && !categoryExistInList) {
                                        $scope.VA.Application_PurposeOfTravelCategoryId = d.data[0].Value;
                                    }
                                });

                            }
                            else {
                                CodeTypeService.getPurposeOfTravelCategoryByPurposeOfTravel($scope.VA.Application_PurposeOfTravelId, $scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                                    $scope.Lists.PurposeOfTravelCategoryTypes = d.data;
                                    var categoryExistInList = false;
                                    if (typeof $scope.VA.Application_PurposeOfTravelCategoryId != "undefined" && $scope.VA.Application_PurposeOfTravelCategoryId && $scope.VA.Application_PurposeOfTravelCategoryId > 0) {
                                        var arrayLength = d.data.length;

                                        for (var i = 0; i < arrayLength; i++) {
                                            if (d.data[i].Value == $scope.VA.Application_PurposeOfTravelCategoryId) {
                                                categoryExistInList = true;
                                            }
                                        }
                                    }
                                    if (d.data.length >= 1 && !categoryExistInList) {
                                        $scope.VA.Application_PurposeOfTravelCategoryId = d.data[0].Value;
                                    }
                                });

                            }


                        }
                        else {
                            CodeTypeService.getPurposeOfTravelCategoryList($scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                                $scope.purposeofTravelCategoryFullList = d.data;
                                $scope.Lists.PurposeOfTravelCategoryTypes = $scope.purposeofTravelCategoryFullList;


                            });

                        }



                    }
                    else {
                        $scope.purposeOfTravelList = null;
                        $scope.Lists.PurposeOfTravelCategoryTypes = null;
                    }

                    $scope.initializeApplication(data);
                    $scope.filterVacList();
                    $scope.InitializeMrz();
                    $scope.addClickScanPicture();
                    $scope.calcFingerprintExemption();

                    if ($scope.bioModFetchOk === false) {
                        //$scope.ErrorMessage = "Error fetch BioMod";
                        $scope.Errors = [];
                        messageService.sendErrorMessage(data.ErrorMessage);
                    }

                    $timeout(function () {
                        //If new controlls are added we need to register the trigger (modal popup google places search button)
                        $(".md-trigger").modalEffects();

                    });

                    $scope.doGetDateOfBirthPerson($scope.VA.ReferencePersonId);
                } else {
                    if (typeof data.ModelErrors != "undefined" && data.ModelErrors) {
                        $scope.ErrorMessage = data.ModelErrors;
                        $scope.ApplicationCanBeShown = data.HasPermission;
                    } else {
                        $scope.ErrorMessage = "Unexpected Error";
                    }

                    $scope.showLoading = false;
                }
            }).error(function () {
                $scope.ErrorMessage = "Unexpected Error";
                $scope.showLoading = false;
            });
        };

        $scope.deleteBiometry = function () {
            $('#osOnlineBody').addClass("BasicInformation");
            $('#PromptDeleteBimetryModal').addClass("md-show");
        };

        $scope.BuildBioModLink = function () {
            var urlbiomod = $scope.CustomUrlBiomod + ":-m Visa -w " + $scope.VA.VOWId;

            //name info : DO NOT put space here, but double underscore instead ! The space will cause issue in the argument's parser of BioMod. The __ is replaced by a space in BioMod.
            //format: Name Firstname (01/01/1990 M)
            $scope.setsexValue();
            $scope.doGetDateOfBirth();
            var birthDateDisplay = $scope.Day + "/" + $scope.Month + "/" + $scope.Year;
            urlbiomod += " -i " + $scope.VA.Personal_Data_LastName + "__" + $scope.VA.Personal_Data_FirstName + "__(" + birthDateDisplay + "__" + $scope.sexValue + ")";

            if ($scope.VA.Application_FingerprintExemptionId != undefined && $scope.VA.Application_FingerprintExemptionId > 0)
                urlbiomod += " -r Fingerprints";

            $scope.BioModLink = urlbiomod;
        }

        $scope.PreviousFingerprintChange = function () {
            if ($scope.VA.PreviousFingerPrint !== undefined && $scope.VA.PreviousFingerPrint === true) {
                $scope.VA.PreviousFingerprint_CaptureDate = '';
                $scope.VA.PreviousFingerprint_VisaNumber = '';
            }

        }

        $scope.initializeApplication = function (data) {
            $scope.doGetDateOfBirth();
            //$scope.doGetDateOfBirthEU();



            $scope.canEditPayment = data.canEditPayment;

            //if (typeof data.Lists != "undefined" && data.Lists)
            //    if (typeof data.Lists.PurposeOfTravelTypesByVisaType != "undefined" && data.Lists.PurposeOfTravelTypesByVisaType)
            //        $scope.purposeOfTravelList = data.Lists.PurposeOfTravelTypesByVisaType;

            $scope.DateTimeFilter();

            $scope.InvitingPerson = $scope.VA.References.filter(function (item) {
                return item.ActorType === ACTOR.TYPES.REFERENCEPERSON && item.Invitation === true || item.ActorType === ACTOR.TYPES.ACCOMODATION;
            });
            //if ($scope.InvitingPerson && $scope.InvitingPerson.length > 0 && $scope.InvitingPerson[0].Person_Nationality == 90)
            //{
            //    $scope.doSetNationalityPerson($scope.InvitingPerson[0].Id, $scope.InvitingPerson[0].Person_Nationality);
            //}

            $scope.InvitingOrganisation = $scope.VA.References.filter(function (item) {
                return item.ActorType === ACTOR.TYPES.REFERENCEORGANISATION && item.Invitation === true;
            });

            $scope.calcVisaFeeWaiver();
            $scope.calculateDuration();

            $timeout(function () {
                for (var i = 0; i < data.VA.References.length; i++) {
                    $scope.doGetDateOfBirthPerson(data.VA.References[i].Id);
                }
            }, 3000);
        };

        $scope.DateTimeFilter = function () {
            //Filter dates to right format
            if ($scope.VA.TravelDocument_DateOfIssue !== null)
                $scope.VA.TravelDocument_DateOfIssue = $filter("jsonDate")($scope.VA.TravelDocument_DateOfIssue, "DD/MM/YYYY");
            if ($scope.VA.TravelDocument_ValidUntil !== null)
                $scope.VA.TravelDocument_ValidUntil = $filter("jsonDate")($scope.VA.TravelDocument_ValidUntil, "DD/MM/YYYY");
            if ($scope.VA.Application_IntendedDateOfArrival !== null)
                $scope.VA.Application_IntendedDateOfArrival = $filter("jsonDate")($scope.VA.Application_IntendedDateOfArrival, "DD/MM/YYYY");
            if ($scope.VA.Application_IntendedDateOfDeparture !== null)
                $scope.VA.Application_IntendedDateOfDeparture = $filter("jsonDate")($scope.VA.Application_IntendedDateOfDeparture, "DD/MM/YYYY");
            if ($scope.VA.PermitForDestinationCountry_PermitValidFrom !== null)
                $scope.VA.PermitForDestinationCountry_PermitValidFrom = $filter("jsonDate")($scope.VA.PermitForDestinationCountry_PermitValidFrom, "DD/MM/YYYY");
            if ($scope.VA.PermitForDestinationCountry_PermitValidUntil !== null)
                $scope.VA.PermitForDestinationCountry_PermitValidUntil = $filter("jsonDate")($scope.VA.PermitForDestinationCountry_PermitValidUntil, "DD/MM/YYYY");
            if ($scope.VA.PermitForResidenceCountry_PermitValidUntil !== null)
                $scope.VA.PermitForResidenceCountry_PermitValidUntil = $filter("jsonDate")($scope.VA.PermitForResidenceCountry_PermitValidUntil, "DD/MM/YYYY");
            if ($scope.VA.PreviousSchengenVisa_DateOfIssue !== null)
                $scope.VA.PreviousSchengenVisa_DateOfIssue = $filter("jsonDate")($scope.VA.PreviousSchengenVisa_DateOfIssue, "DD/MM/YYYY");
            if ($scope.VA.PreviousSchengenVisa_ValidUntil !== null)
                $scope.VA.PreviousSchengenVisa_ValidUntil = $filter("jsonDate")($scope.VA.PreviousSchengenVisa_ValidUntil, "DD/MM/YYYY");
            if ($scope.VA.PreviousFingerprint_CaptureDate !== null)
                $scope.VA.PreviousFingerprint_CaptureDate = $filter("jsonDate")($scope.VA.PreviousFingerprint_CaptureDate, "DD/MM/YYYY");
        };

        $scope.escapeHtml = function (str) {
            var entityMap = {
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': '&quot;',
                "'": '&#39;',
                "/": '&#x2F;'
            };
            if (str === null || str === "")
                return str;
            return String(str).replace(/[&<>"'\/]/g, function (s) {
                return entityMap[s];
            });
        };

        //Visa Type Request changed
        $scope.visaTypeRequestChange = function () {
            $scope.VA.Application_FingerprintExemptionId = null;
            var dateOfApp = $scope.VA.DateOfApplication;
            if ($scope.VA.StatusId < 3)
                dateOfApp = convertDate(new Date());

            $scope.VA.Application_PurposeOfTravelId = null;
            $scope.VA.Application_PurposeOfTravelCategoryId = null;
            $scope.purposeOfTravelDescription = '';

            if (typeof $scope.VA.Application_VisaTypeRequestedId != "undefined" && $scope.VA.Application_VisaTypeRequestedId) {
                CodeTypeService.getPurposeOfTravelList($scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                    $scope.purposeOfTravelList = d.data;
                    if ($scope.purposeOfTravelList.length == 1) {
                        $scope.VA.Application_PurposeOfTravelId = $scope.purposeOfTravelList[0].Value;
                        $scope.setPurposeOfTravelDescription();
                    }
                    CodeTypeService.getPurposeOfTravelCategoryList($scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                        $scope.purposeofTravelCategoryFullList = d.data;
                        $scope.Lists.PurposeOfTravelCategoryTypes = $scope.purposeofTravelCategoryFullList;
                        if (d.data.length == 1) {
                            $scope.VA.Application_PurposeOfTravelCategoryId = d.data[0].Value;
                        }
                    });
                }
                );


            } else {
                $scope.setPurposeOfTravelDescription();
                $scope.purposeOfTravelList = null;
                $scope.Lists.PurposeOfTravelCategoryTypes = null;
            }
            if ($scope.VA.Application_VisaTypeRequestedId === 3) {
                $scope.VA.Application_NumberOfEntriesRequestedId = 3;
                $scope.canEditNumberOfEntries = false;
            } else {
                $scope.canEditNumberOfEntries = true;
            }
            if (typeof $scope.VA.Application_VisaTypeRequestedId != "undefined" && $scope.VA.Application_VisaTypeRequestedId) {
                if ($scope.VA.Application_VisaTypeRequestedId !== 2 && $scope.VA.Application_GratuityId === 9) {
                    $scope.VA.Application_GratuityId = null;
                }
            }

            $scope.calculateDuration();
            $scope.calcFingerprintExemption();
            $scope.calcVisaFeeWaiver();
            $scope.GetShengenCountriesByVac();
            // $scope.showUeFamilyMember = $scope.VA.Application_VisaTypeRequestedId != undefined && ($scope.VA.Application_VisaTypeRequestedId == 1 || $scope.VA.Application_VisaTypeRequestedId == 2);

        };

        $scope.setPurposeOfTravelDescription = function () {
            if (typeof $scope.VA.Application_PurposeOfTravelId != "undefined" && $scope.VA.Application_PurposeOfTravelId && $scope.VA.Application_PurposeOfTravelId > 0) {
                for (var i = 0; i < $scope.purposeOfTravelList.length; i++) {
                    if ($scope.purposeOfTravelList[i].Value == $scope.VA.Application_PurposeOfTravelId)//purposeOfTravelList
                    {
                        $scope.purposeOfTravelDescription = $scope.purposeOfTravelList[i].Description;

                    }
                }
            }
            else {

                $scope.purposeOfTravelDescription = '';
            }

        }

        $scope.purposeOfTravelCategoryChange = function () {
            var dateOfApp = $scope.VA.DateOfApplication;
            if ($scope.VA.StatusId < 3)
                dateOfApp = convertDate(new Date());
            if (typeof $scope.VA.Application_PurposeOfTravelCategoryId != "undefined" && $scope.VA.Application_PurposeOfTravelCategoryId && typeof $scope.VA.Application_PurposeOfTravelCategoryId != "undefined" && $scope.VA.Application_PurposeOfTravelCategoryId) {


                CodeTypeService.getPurposeOfTravelByCategoryAndVisa($scope.VA.Application_PurposeOfTravelCategoryId, $scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                    $scope.purposeOfTravelList = d.data;
                    if ($scope.purposeOfTravelList.length == 1) {
                        $scope.VA.Application_PurposeOfTravelId = $scope.purposeOfTravelList[0].Value;
                    }
                    if (typeof $scope.VA.Application_PurposeOfTravelId != "undefined" && $scope.VA.Application_PurposeOfTravelId && $scope.VA.Application_PurposeOfTravelId > 0) {
                        var arrayLength = $scope.purposeOfTravelList.length;
                        var categoryExistInList = false;
                        for (var i = 0; i < arrayLength; i++) {

                            if ($scope.purposeOfTravelList[i].Value == $scope.VA.Application_PurposeOfTravelId) {
                                categoryExistInList = true;
                            }
                        }
                        if (!categoryExistInList)
                            $scope.VA.Application_PurposeOfTravelId = null;

                    }
                });






            }
            else {

                if (typeof $scope.VA.Application_VisaTypeRequestedId != "undefined" && $scope.VA.Application_VisaTypeRequestedId) {
                    CodeTypeService.getPurposeOfTravelList($scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                        $scope.purposeOfTravelList = d.data;
                    }
                    );

                    CodeTypeService.getPurposeOfTravelCategoryList($scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                        $scope.purposeofTravelCategoryFullList = d.data;
                        $scope.Lists.PurposeOfTravelCategoryTypes = $scope.purposeofTravelCategoryFullList;
                    }
                    );
                }



                //$scope.Lists.PurposeOfTravelCategoryTypes = $scope.purposeofTravelCategoryFullList;

            }

        };


        $scope.purposeOfTravelChange = function () {

            var dateOfApp = $scope.VA.DateOfApplication;
            if ($scope.VA.StatusId < 3)
                dateOfApp = convertDate(new Date());
            if (typeof $scope.VA.Application_PurposeOfTravelId != "undefined"
                && $scope.VA.Application_PurposeOfTravelId && $scope.VA.Application_PurposeOfTravelId > 0) {
                CodeTypeService.getPurposeOfTravelCategoryByPurposeOfTravel($scope.VA.Application_PurposeOfTravelId, $scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                    $scope.Lists.PurposeOfTravelCategoryTypes = d.data;
                    if (typeof $scope.VA.Application_PurposeOfTravelCategoryId != "undefined" && $scope.VA.Application_PurposeOfTravelCategoryId && $scope.VA.Application_PurposeOfTravelCategoryId > 0) {
                        var arrayLength = d.data.length;
                        var categoryExistInList = false;
                        for (var i = 0; i < arrayLength; i++) {

                            if (d.data[i].Value == $scope.VA.Application_PurposeOfTravelCategoryId) {
                                categoryExistInList = true;
                            }
                        }
                    }
                    if (d.data.length >= 1 && !categoryExistInList) {
                        $scope.VA.Application_PurposeOfTravelCategoryId = d.data[0].Value;




                        CodeTypeService.getPurposeOfTravelByCategoryAndVisa($scope.VA.Application_PurposeOfTravelCategoryId, $scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                            $scope.purposeOfTravelList = d.data;
                        });



                    }
                });
            }
            //else if  (typeof $scope.VA.Application_PurposeOfTravelCategoryId != "undefined"
            //    && $scope.VA.Application_PurposeOfTravelCategoryId && $scope.VA.Application_PurposeOfTravelCategoryId > 0)
            //{
            //    CodeTypeService.getPurposeOfTravelByCategoryAndVisa($scope.VA.Application_PurposeOfTravelCategoryId, $scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
            //        $scope.purposeOfTravelList = d.data;
            //    });

            //}
            //else
            //{

            //    $scope.purposeOfTravelList =  CodeTypeService.getPurposeOfTravelList($scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
            //        $scope.purposeOfTravelList = d.data;                           
            //    });

            //    //    $scope.Lists.PurposeOfTravelTypesByVisaType;
            //    $scope.Lists.PurposeOfTravelCategoryTypes = $scope.purposeofTravelCategoryFullList;
            //}
            else {
                $scope.VA.Application_PurposeOfTravelCategoryId = null;
                $scope.purposeOfTravelList = CodeTypeService.getPurposeOfTravelList($scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                    $scope.purposeOfTravelList = d.data;

                    CodeTypeService.getPurposeOfTravelCategoryList($scope.VA.Application_VisaTypeRequestedId, dateOfApp).then(function (d) {
                        $scope.purposeofTravelCategoryFullList = d.data;
                        $scope.Lists.PurposeOfTravelCategoryTypes = $scope.purposeofTravelCategoryFullList;


                    });
                });



            }

            $scope.setPurposeOfTravelDescription();
        };

        //Lists.PurposeOfTravelCategoryTypes



        //Number Of Entries Requested changed
        $scope.changeNumberOfEntriesRequested = function () {
            $scope.calculateDuration();
        };

        //Intended date of arrival/departure changed
        $scope.changeIntendedDateOf = function () {
            $scope.calculateDuration();
        };

        //Free movement checkbox change
        $scope.freeMovementChange = function () {
            if ($scope.VA.Application_FreeMovement) {
                $scope.VA.Application_VisaTypeRequestedId = 2;
                $scope.visaTypeRequestChange();
                $('#euFamilyMemberModal').addClass("md-show");

            } else {
                $scope.VA.Application_GratuityId = null;
            }
            $scope.calcVisaFeeWaiver();
        };

        $scope.PromptDeleteScan = function () {
            $('#scanPassportAndMrzModalContent').addClass("mrzOpacity");
            $('#PromptDeleteScanModal').addClass("md-show");
        }

        // PassportStatusImage click
        $scope.ScanPictureClick = function () {
            $('#scanPassportAndMrzModal').addClass("md-show");

        };
        $scope.ShowMrzModal = function (data) {
            if (data === "Application_MRZ")
                $scope.ScanPictureClick();

        }

        $scope.vacRequestChange = function () {
            var vacid = $scope.VA.VacId;

            var vac = $filter('filter')($scope.Lists.VacTypes, { Value: vacid }, true)[0];
            if (vac) {

                $scope.VA.SelectedVacCountry = vac.CountryId;
                $scope.filterVacList();
                // change Vac adapt status Mrz ready or not
                if (vac.ScanReady === true && $scope.currentStatus === StatusScan.NOTAPPLICABLE)
                    $scope.currentStatus = $scope.VA.StatusScan === StatusScan.NOSCANIGNORED ? StatusScan.NOSCANIGNORED : StatusScan.NOSCAN;
                if (vac.ScanReady === false && ($scope.currentStatus === StatusScan.NOSCAN || $scope.currentStatus === StatusScan.NOSCANIGNORED))
                    $scope.currentStatus = StatusScan.NOTAPPLICABLE;
            }

            CodeTypeService.getVacCurrency($scope.VA.VacId).then(function (d) {
                $scope.VA.Application_CurrencyCode = d.data.Code;
                $scope.VA.Application_Rate = d.data.ExchangeRate;
                if ($scope.VA.Application_CurrencyCode !== "EUR") {
                    $scope.calcVisaFeeForCurrency();
                }
            });
        };



        $scope.GetShengenCountriesByVac = function (init) {
            $scope.selectedCountriesShengen = [];
            for (i = 0; i < $scope.Lists.CountrySchengenVacs.length; i++) {
                if ($scope.Lists.CountrySchengenVacs[i].VacId == $scope.VA.VacId) {
                    for (j = 0; j < $scope.Lists.CountrySchengenTypes.length; j++) {
                        if ($scope.Lists.CountrySchengenVacs[i].ctCountryId == $scope.Lists.CountrySchengenTypes[j].Value
                            && (
                                $scope.VA.Application_VisaTypeRequestedId == null
                                || $scope.VA.Application_VisaTypeRequestedId == undefined
                                || $scope.VA.Application_VisaTypeRequestedId !== 3
                                || $scope.Lists.CountrySchengenTypes[j].Value === 142//in case of a VisaD we should keep only the LUX if exist into the list
                            )

                        ) {
                            $scope.selectedCountriesShengen.push($scope.Lists.CountrySchengenTypes[j]);
                            break;
                        }
                    }
                }
            }

            var countryExistingIntoList = false
            for (j = 0; j < $scope.selectedCountriesShengen.length; j++) {
                if ($scope.selectedCountriesShengen[j].Value == $scope.VA.Application_MemberStateOfDestinationId) {
                    countryExistingIntoList = true
                }


            }
            if (countryExistingIntoList == false) {
                for (j = 0; j < $scope.Lists.CountrySchengenTypes.length; j++) {
                    if ($scope.Lists.CountrySchengenTypes[j].Value == $scope.VA.Application_MemberStateOfDestinationId && $scope.VA.Application_MemberStateOfDestinationId != 32) {
                        $scope.selectedCountriesShengen.push($scope.Lists.CountrySchengenTypes[j]);
                        break;
                    }
                }

            }

            for (j = 0; j < $scope.Lists.CountrySchengenTypes.length; j++) {
                if ($scope.Lists.CountrySchengenTypes[j].Value == 32) {
                    $scope.selectedCountriesShengen.push($scope.Lists.CountrySchengenTypes[j]);
                    break;
                }
            }
        }

        //Calculate duration
        $scope.calculateDuration = function () {
            if ((typeof $scope.VA.Application_VisaTypeRequestedId != "undefined" && $scope.VA.Application_VisaTypeRequestedId)) {
                switch ($scope.VA.Application_VisaTypeRequestedId) {
                    case 1:
                        $scope.VA.Application_DurationOfIntendedStay = 0;
                        $scope.canEditDuration = false;
                        break;
                    case 2:
                        if (typeof $scope.VA.Application_NumberOfEntriesRequestedId != "undefined" && $scope.VA.Application_NumberOfEntriesRequestedId) {
                            if (parseInt($scope.VA.Application_NumberOfEntriesRequestedId) === 1) {
                                if (typeof $scope.VA.Application_IntendedDateOfArrival != "undefined" && $scope.VA.Application_IntendedDateOfArrival &&
                                    typeof $scope.VA.Application_IntendedDateOfDeparture != "undefined" && $scope.VA.Application_IntendedDateOfDeparture) {
                                    var arrivalSplitted = $scope.VA.Application_IntendedDateOfArrival.split("/", 3);
                                    var intendedDateOfArrival = new Date(Date.UTC(parseInt(arrivalSplitted[2].substring(2, 4)), parseInt(arrivalSplitted[1]) - 1, parseInt(arrivalSplitted[0]), 0, 0, 0));// new Date(parseInt(arrivalSplitted[2].substring(0, 4)), parseInt(arrivalSplitted[1]) -1, parseInt(arrivalSplitted[0]));
                                    var departureSplitted = $scope.VA.Application_IntendedDateOfDeparture.split("/", 3);
                                    var intendedDateOfDeparture = new Date(Date.UTC(parseInt(departureSplitted[2].substring(2, 4)), parseInt(departureSplitted[1]) - 1, parseInt(departureSplitted[0]), 0, 0, 0));// new Date(parseInt(departureSplitted[2].substring(0, 4)), parseInt(departureSplitted[1]) -1, parseInt(departureSplitted[0]));
                                    if (intendedDateOfArrival <= intendedDateOfDeparture)
                                        $scope.VA.Application_DurationOfIntendedStay = Math.floor((intendedDateOfDeparture - intendedDateOfArrival) / 86400000) + 1;
                                    else
                                        $scope.VA.Application_DurationOfIntendedStay = 0;
                                }
                                $scope.canEditDuration = false;
                            }
                            else
                                $scope.canEditDuration = true;
                        }
                        break;
                    case 3:
                        $scope.canEditDuration = true;
                        break;
                }
            }
        };

        //Calculate Visa Fee Waiver
        $scope.calcVisaFeeWaiver = function () {
            $scope.setVfaFornationality();
            $scope.canEditGratuity = true;
            if (typeof $scope.VA.Application_VisaTypeRequestedId != "undefined" && $scope.VA.Application_VisaTypeRequestedId) {
                if ($scope.VA.Application_FreeMovement) {
                    $scope.VA.Application_GratuityId = 7;
                    $scope.canEditGratuity = false;
                } else if (($scope.VA.Application_VisaTypeRequestedId === 1 || $scope.VA.Application_VisaTypeRequestedId === 2) && $scope.isUnderXYears($scope.VA.Personal_Data_BirthDate, $scope.VA.DateOfApplication, 6)) {
                    $scope.VA.Application_GratuityId = 9;
                    $scope.canEditGratuity = false;
                }
                else if (($scope.personal_Vfa === 'VFA2' && ($scope.VA.Application_VisaTypeRequestedId === 1 || $scope.VA.Application_VisaTypeRequestedId === 2)) && $scope.isUnderXYears($scope.VA.Personal_Data_BirthDate, $scope.VA.DateOfApplication, 12)) {
                    $scope.VA.Application_GratuityId = 16;//Visa Younger Than 12 Years (facility)
                    $scope.canEditGratuity = false;
                }
                else {
                    if ($scope.VA.Application_GratuityId == null) {
                        $scope.VA.Application_GratuityId = 1;
                    }
                    else if ($scope.VA.Application_GratuityId === 9 && !(($scope.VA.Application_VisaTypeRequestedId === 1 || $scope.VA.Application_VisaTypeRequestedId === 2) && $scope.isUnderXYears($scope.VA.Personal_Data_BirthDate, $scope.VA.DateOfApplication, 6))) {
                        $scope.VA.Application_GratuityId = 1;
                    }
                    else if ($scope.VA.Application_GratuityId === 16 && $scope.canEditGratuity == true) {
                        $scope.VA.Application_GratuityId = 1;
                    }
                    else if ($scope.VA.Application_GratuityId === 7 && !$scope.VA.Application_FreeMovement) {
                        $scope.VA.Application_GratuityId = 1;
                    }
                }
            }
            else {
                if ($scope.VA.Application_GratuityId == null) {
                    $scope.VA.Application_GratuityId = 1;
                }
            }
            $scope.calcVisaFee();
        };

        $scope.calcVisaFeeForCurrency = function () {
            $scope.VA.Application_Currency = $scope.VA.Application_Rate === 0 || $scope.VA.Application_Fee === null || $scope.VA.Application_Fee === 0 ? 0 :
                ($scope.VA.Application_Fee * $scope.VA.Application_Rate).toFixed(2);

            var splittedCurrency = $scope.VA.Application_Currency.toString().split(".");
            $scope.VA.Application_CurrencyRound = splittedCurrency[0];
            $scope.VA.Application_CurrencyDecimals = splittedCurrency[1];
        };

        //Calculate Visa Fee
        $scope.calcVisaFee = function () {
            // $scope.setVfaFornationality();
            CodeTypeService.getApplicationFee($scope.VA.Application_GratuityId, $scope.VA.Application_VisaTypeRequestedId, $scope.VA.Personal_Data_NationalityId, $scope.VA.TravelDocument_IssuingAuthorityCountryId, $scope.VA.TravelDocument_DocumentTypeId, $scope.VA.DateOfApplication, $scope.VA.Personal_Data_BirthDate, $scope.VA.Application_MemberStateOfDestinationId).then(function (d) {
                $scope.VA.Application_Fee = d.data;
                var splittedCurrency = $scope.VA.Application_Fee.toString().split(".");


                $scope.Application_Fee = $scope.VA.Application_CurrencyRound = splittedCurrency[0];
                $scope.Application_FeeRound = splittedCurrency[1];


                $scope.calcVisaFeeForCurrency();
            });
        };

        $scope.setVfaFornationality = function () {

            for (i = 0; i < $scope.Lists.CountryNonSchengenTypes.length; i++) {
                if ($scope.VA.Personal_Data_NationalityId == $scope.Lists.NationalityNonEUTypes[i].Value) {
                    $scope.personal_Vfa = $scope.Lists.NationalityNonEUTypes[i].Vfa;
                }

            }
        }

        $scope.previousTypeRequestId = angular.copy($scope.VA.Application_VisaTypeRequestedId);

        $scope.calcFingerprintExemption = function () {
            $scope.filterExemptionList();


        };



        $scope.calcFingerprintExemptionWithNewBirthdate = function () {
            if ($scope.previousTypeRequestId == $scope.VA.Application_VisaTypeRequestedId)
                $scope.VA.Application_FingerprintExemptionId = null;
            else
                $scope.filterExemptionList();
        }
        $scope.sourceFingerPrintImage = "../../../content/images/loading.gif";
        $scope.UpdateVisaImage = function () {
            // $scope.VisaImage = 
        }
        $scope.UpdateFingerPrintPicture = function () {


            if ($scope.VA.HasFingerprints == true)
                $scope.sourceFingerPrintImage = "../../../content/images/BioDone.jpg";
            else if ($scope.VA.Application_FingerprintExemptionId != undefined && $scope.VA.Application_FingerprintExemptionId > 0)
                $scope.sourceFingerPrintImage = "../../../content/images/BioExem.jpg";
            else if ($scope.calculateIn59months() == true)
                $scope.sourceFingerPrintImage = "../../../content/images/fp-checkvis.jpg";
            else
                $scope.sourceFingerPrintImage = "../../../content/images/BioNotCaptured.jpg";
        }

        $scope.isParentalAuthority = function (guardianRelationship) {
            if (typeof guardianRelationship != "undefined" && guardianRelationship) {
                if (guardianRelationship === 2)
                    return true;
            }
            return false;
        };

        //BEGIN REGION isMinor
        $scope.isMinor = function (dateOfBirth, extendedMinor, dateDemande) {
            if (typeof extendedMinor != "undefined" && extendedMinor) {
                if (extendedMinor === true)
                    return true;
            } else if (typeof dateOfBirth != "undefined" && dateOfBirth) {
                return $scope.isUnderXYears(dateOfBirth, dateDemande, 18);
            }
            return false;
        };
        //#END REGION isMinor


        $scope.isUnderXYears = function (dateOfBirth, dateDemande, yearMax) {
            if (dateOfBirth != undefined && dateOfBirth) {
                var birthDate = dateOfBirth.replace("-00", "-01");
                birthDate = birthDate.replace("-00", "-01");
                //  Js new Date(year, month, day, hours)
                var birthDatePlusyearMax = new Date(parseInt(birthDate.substring(0, 4)) + yearMax, parseInt(birthDate.substring(5, 7)) - 1, birthDate.substring(8, 10));
                if ($scope.VA.StatusId < 3)
                    dateDemande = convertDate(new Date());
                var dDemande = stringToDate(dateDemande);
                return birthDatePlusyearMax > dDemande;
            }
            return false;
        };

        function convertDate(inputFormat) {
            function pad(s) { return (s < 10) ? '0' + s : s; }
            var d = new Date(inputFormat);
            return [pad(d.getDate()), pad(d.getMonth() + 1), d.getFullYear()].join('/');
        }

        var stringToDate = function (stringDate_dd_MM_yyyy) {
            var result = new Date();
            if (typeof stringDate_dd_MM_yyyy != "undefined" && stringDate_dd_MM_yyyy) {
                var dateSplit = stringDate_dd_MM_yyyy.split("/");
                result = new Date(dateSplit[2].substring(0, 4), parseInt(dateSplit[1]) - 1, parseInt(dateSplit[0]));
            }
            return result;

        }

        //BEGIN REGION isBetwee6And12Years
        $scope.isBetwee6And12Years = function (dateOfBirth, dateDemande) {
            if (dateOfBirth != undefined && dateOfBirth) {
                var birthDate = dateOfBirth.replace("-00", "-01");
                birthDate = birthDate.replace("-00", "-01");
                birthDate = new Date(birthDate.substring(0, 4), parseInt(birthDate.substring(5, 7)) - 1, birthDate.substring(8, 10));
                if (typeof dateDemande != "undefined" && dateDemande) {
                    //var dateSplitted = dateDemande.split("/", 3);
                    dateDemande = stringToDate(dateDemande);
                } else {
                    dateDemande = new Date();
                }
                var years = dateDemande.getFullYear() - birthDate.getFullYear();

                // Reset birthday to the current year.
                birthDate.setFullYear(dateDemande.getFullYear());

                // If the user's birthday has not occurred yet this year, subtract 1.
                if (dateDemande < birthDate) {
                    years--;
                }

                if (years < 12 && years >= 6) {
                    return true;
                } else {
                    return false;
                }
            }
            return false;
        };

        $scope.GetAge = function (dateOfBirth, dateDemande) {
            if (dateOfBirth != undefined && dateOfBirth) {
                var birthDate = dateOfBirth.replace("-00", "-01");
                birthDate = birthDate.replace("-00", "-01");
                birthDate = new Date(birthDate.substring(0, 4), parseInt(birthDate.substring(5, 7)) - 1, birthDate.substring(8, 10));
                if (typeof dateDemande != "undefined" && dateDemande) {
                    var dateSplitted = dateDemande.split("/", 3);
                    dateDemande = new Date(parseInt(dateSplitted[2].substring(0, 4)), parseInt(dateSplitted[1]) - 1, parseInt(dateSplitted[0]));
                } else {
                    dateDemande = new Date();
                }
                var years = dateDemande.getFullYear() - birthDate.getFullYear();

                // Reset birthday to the current year.
                birthDate.setFullYear(dateDemande.getFullYear());

                // If the user's birthday has not occurred yet this year, subtract 1.
                if (dateDemande < birthDate) {
                    years--;
                }

                return years;
            }
            return 1000;
        };
        //#END REGION isBetwee6And12Years

        //BEGIN REGION hasExceptionCountry
        $scope.hasExceptionCountry = function () {
            var exceptionDeferred = $q.defer();
            if ($scope.VA.Personal_Data_NationalityId != undefined && $scope.VA.Personal_Data_NationalityId) {
                CodeTypeService.getNationalityPaymentExceptionByNationalityId($scope.VA.Personal_Data_NationalityId).then(function (d) {
                    if (d.data !== "") {
                        exceptionDeferred.resolve(true);
                    } else {
                        exceptionDeferred.resolve(false);
                    }
                }, function (error) {
                    exceptionDeferred.resolve(false);
                });
            } else {
                exceptionDeferred.resolve(false);
            }

            return exceptionDeferred.promise;
        };
        //#END REGION hasExceptionCountry

        //START
        //ON PAGE LOAD
        $scope.showLoading = true;
        AddScrollSpy();
        AddScrollCorrection();

        $(".datetime").mask("99/99/9999", {
            placeholder: "dd/mm/yyyy"
        });

        $scope.doGetVisaApplicationDossier();
        $scope.addOtherNationality = function () {
            $scope.VA.Personal_Data_Other_Nationalities.push(0);
        }

        $scope.removeOtherNationality = function (item) {
            $scope.VA.Personal_Data_Other_Nationalities.splice(item, 1);
        }

        $scope.actorOccupation = function (actorSubType) {
            return actorSubType.Value === 4 || actorSubType.Value === 5;
        };

        $scope.personOrAccomodation = function (actorSubType) {
            return actorSubType.Value === 6 || actorSubType.Value === 7;
        };

        $scope.schoolOrCompany = function (actorSubType) {
            return actorSubType.Value === 8 || actorSubType.Value === 9;
        };

        $scope.referenceOrganisation = function (actorType) {
            return actorType.Value === ACTOR.TYPES.REFERENCEORGANISATION;
        };

        $scope.sponsorTypesForActorTypes = function (actorType) {
            return actorType.Value === ACTOR.TYPES.REFERENCEPERSON || actorType.Value === ACTOR.TYPES.REFERENCEORGANISATION;
        };

        $scope.sponsorTypesForActorSubTypes = function (actorSubType) {
            return actorSubType.Value === 8 || actorSubType.Value === 9;
        };

        $scope.guardianRelationShipTypes = function (relationShipType) {
            if ($scope.VA.ShowParent2)
                return relationShipType.Value !== 3;
            else
                return true;
        };
        $scope.freeMovementFilter = function (visaType) {
            if ($scope.VA.Application_FreeMovement)
                return visaType.Value === 2; // || visaType.Value === 3;  D Visa Free
            else
                return true;
        };

        $scope.$watch("VA.Personal_Data_OccupationId", function () {

            if ($scope.VA.Personal_Occupation != undefined && $scope.VA.Personal_Data_OccupationId == undefined) {
                $scope.VA.Personal_Occupation.ActorSubTypeId = null;
            }
            if ($scope.Lists != undefined) {
                for (var i = 0; i < $scope.Lists.OccupationTypes.length; i++) {
                    if ($scope.Lists.OccupationTypes[i].Value === $scope.VA.Personal_Data_OccupationId) {
                        $scope.VA.Personal_Occupation.ActorSubTypeId = $scope.Lists.OccupationTypes[i].ActorSubType;
                    }
                }
            }
        });

        $scope.SetOnlyNationals = function () {

            for (i = 0; i < $scope.Lists.CountrySchengenVacs.length; i++) {
                if ($scope.Lists.CountrySchengenVacs[i].VacId == $scope.VA.VacId && $scope.Lists.CountrySchengenVacs[i].ctCountryId == $scope.VA.Application_MemberStateOfDestinationId)
                    $scope.VA.OnlyNationals = $scope.Lists.CountrySchengenVacs[i].OnlyNationals;
            }
            return $scope.VA.OnlyNationals;
        }

        $scope.calculateIn59months = function () {
            if ($scope.VA.HasFingerprints || $scope.VA.Application_VisaTypeRequestedId == 3) {
                return false;
            }

            return hasTakenFingerprints59MonthsBeforeAppDate() || hasPreviousShengVisa();
        }

        $scope.checkVis = function () {
            var result = ($scope.calculateIn59months() && $scope.VA.Application_FingerprintExemptionId == null && $scope.VA.Application_VisaTypeRequestedId != 3);
            return result;
        }
        $scope.changeFingerPrintExemption = function () {
            $scope.VA.Application_FingerprintExemptionReason = null;
        }
        var hasTakenFingerprints59MonthsBeforeAppDate = function () {
            if ($scope.VA.PreviousFingerprint_CaptureDate == null || $scope.VA.PreviousFingerprint_CaptureDate == undefined || !$scope.VA.PreviousFingerprint_CaptureDate) {
                return false;
            }
            var dateOfApplication = new Date();
            if ($scope.VA.DateOfApplication != undefined && $scope.VA.DateOfApplication)
                dateOfApplication = stringToDate($scope.VA.DateOfApplication);

            var date59monthsago = new Date(dateOfApplication.setMonth(dateOfApplication.getMonth() - 59));
            var datefingerprintstaken = stringToDate($scope.VA.PreviousFingerprint_CaptureDate);
            var hasFingerprintsTaken59MonthsBeforeAppDate = datefingerprintstaken >= date59monthsago;

            return hasFingerprintsTaken59MonthsBeforeAppDate;
        }

        var hasPreviousShengVisa = function () {
            var previousShengen = (($scope.VA.PreviousSchengenVisa_VisaNumber !== null) && ($scope.VA.PreviousSchengenVisa_VisaNumber !== "")
                && ($scope.VA.PreviousSchengenVisa_DateOfIssue !== null) && ($scope.VA.PreviousSchengenVisa_DateOfIssue !== "")
                && ($scope.VA.PreviousSchengenVisa_ValidUntil !== null) && ($scope.VA.PreviousSchengenVisa_ValidUntil !== "")
                && ($scope.VA.PreviousSchengenVisa_DeliveredByCountryId !== null) && ($scope.VA.PreviousSchengenVisa_DeliveredByCountryId !== "") && ($scope.VA.PreviousSchengenVisa_DeliveredByCountryId !== 0))

            return previousShengen;
        }

        $scope.gratuityFilter = function (gratuity) {
            if (typeof $scope.VA.Application_VisaTypeRequestedId != "undefined" && $scope.VA.Application_VisaTypeRequestedId) {
                if ($scope.isUnderXYears($scope.VA.Personal_Data_BirthDate, $scope.VA.DateOfApplication, 12) && $scope.personal_Vfa !== 'undefined' &&
                    $scope.personal_Vfa === 'VFA2' && ($scope.VA.Application_VisaTypeRequestedId === 2 || $scope.VA.Application_VisaTypeRequestedId === 1)) {
                    if (gratuity.Value === 16) {
                        return true;
                    }
                    else {
                        return false;
                    }
                }
                if ($scope.VA.Application_VisaTypeRequestedId === 1 || $scope.VA.Application_VisaTypeRequestedId === 3) {
                    if (gratuity.Value === 2) {
                        return false;
                    }
                }
                if ($scope.VA.Application_VisaTypeRequestedId !== 2) {
                    if (gratuity.Value === 9) {
                        return false;
                    }
                }
            }

            if (typeof $scope.VA.Application_FreeMovement != "undefined") {
                if (!$scope.VA.Application_FreeMovement) {
                    if (gratuity.Value === 7) {
                        return false;
                    }
                }
            }
            if (!$scope.isUnderXYears($scope.VA.Personal_Data_BirthDate, $scope.VA.DateOfApplication, 6)) {
                if (gratuity.Value === 9) {
                    return false;
                }
            }


            if (gratuity.Value === 16) {
                return false;
            }
            return true;
        }

        var closemodalEUs = function () {
            $('#euFamilyMemberModal').removeClass("md-show");
        };
        $scope.closemodalEU = closemodalEUs;

        var closemodals = function (event) {
            var myModal = $(event.target).closest(".md-modal");
            myModal.removeClass("md-show");
        };
        $scope.closemodal = closemodals; //pointer closeModal
        $scope.setsexValue = function () {

            $scope.sexValue = "M";
            if ($scope.VA.Personal_Data_GenderId == 2)
                $scope.sexValue = "F";

            if ($scope.VA.Personal_Data_GenderId == 3)
                $scope.sexValue = "X";
        }

        $scope.setIssuingState = function () {
            for (i = 0; i < $scope.Lists.CountryNonSchengenTypes.length; i++) {
                if ($scope.VA.TravelDocument_IssuingAuthorityCountryId == $scope.Lists.CountryNonSchengenTypes[i].Value) {
                    $scope.travel_Document_IssuingState = $scope.Lists.CountryNonSchengenTypes[i].Text;
                }
            }
        }

        $scope.setPersonalDataNationality = function () {
            for (i = 0; i < $scope.Lists.CountryNonSchengenTypes.length; i++) {
                if ($scope.VA.Personal_Data_NationalityId == $scope.Lists.NationalityNonEUTypes[i].Value) {
                    $scope.personal_Data_Nationality = $scope.Lists.NationalityNonEUTypes[i].Text;
                }
            }

        }

        $scope.setWarningCss = function () {
            var borderStyle = ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN)
                ? "border: red 2px solid ;flex:1;" : "border: green 2px solid ;flex:1;";
            if ($scope.VA.StatusScan == StatusScan.WARNING)
                borderStyle = "border: orange 2px solid ;flex:1;"

            if ($scope.VA.Css_IssuingAuthorityCountry == " " || ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN))
                $scope.VA.Css_IssuingAuthorityCountry = $scope.VA.Css_IssuingAuthorityCountry + " " + borderStyle;
            else
                $scope.VA.Css_IssuingAuthorityCountry = $scope.VA.Css_IssuingAuthorityCountry + " " + borderStyleWarning;

            if ($scope.VA.Css_LastName == " " || ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN))
                $scope.VA.Css_LastName = $scope.VA.Css_LastName + " " + borderStyle;
            else
                $scope.VA.Css_LastName = $scope.VA.Css_LastName + " " + borderStyleWarning;

            if ($scope.VA.Css_FirstName == " " || ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN))
                $scope.VA.Css_FirstName = $scope.VA.Css_FirstName + " " + borderStyle;
            else
                $scope.VA.Css_FirstName = $scope.VA.Css_FirstName + " " + borderStyleWarning;

            if ($scope.VA.Css_DocumentNumber == " " || ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN))
                $scope.VA.Css_DocumentNumber = $scope.VA.Css_DocumentNumber + " " + borderStyle;
            else
                $scope.VA.Css_DocumentNumber = $scope.VA.Css_DocumentNumber + " " + borderStyleWarning;

            if ($scope.VA.Css_Nationality == " " || ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN))
                $scope.VA.Css_Nationality = $scope.VA.Css_Nationality + " " + borderStyle;
            else
                $scope.VA.Css_Nationality = $scope.VA.Css_Nationality + " " + borderStyleWarning;

            if ($scope.VA.Css_BirthDate == " " || ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN))
                $scope.VA.Css_BirthDate = $scope.VA.Css_BirthDate + " " + borderStyle;
            else
                $scope.VA.Css_BirthDate = $scope.VA.Css_BirthDate + " " + borderStyleWarning;

            if ($scope.VA.Css_Gender == " " || ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN))
                $scope.VA.Css_Gender = $scope.VA.Css_Gender + " " + borderStyle;
            else
                $scope.VA.Css_Gender = $scope.VA.Css_Gender + " " + borderStyleWarning;

            if ($scope.VA.Css_ValidUntil == " " || ($scope.VA.StatusScan == StatusScan.NOSCANIGNORED || $scope.VA.StatusScan == StatusScan.NOSCAN))
                $scope.VA.Css_ValidUntil = $scope.VA.Css_ValidUntil + " " + borderStyle;
            else
                $scope.VA.Css_ValidUntil = $scope.VA.Css_ValidUntil + " " + borderStyleWarning;
        }

        $scope.InitializeMrz = function () {
            $scope.setWarningCss();
            $scope.SetShowDeleteScan();
            $scope.setIssuingState();
            $scope.setPersonalDataNationality();
            $scope.setsexValue();

        }
        $scope.SetShowDeleteScan = function () {

            $scope.ShowDeleteScan = $scope.VA.StatusScan == StatusScan.WARNING || $scope.VA.StatusScan == StatusScan.OK || $scope.VA.StatusScan == StatusScan.OKIGNORED || $scope.VA.StatusScan == StatusScan.OKOVERWRITTEN;

        }


        $scope.addClickScanPicture = function () {
            $scope.IsScanPictureClick = $scope.VA.StatusId > 1 /*&& ($scope.VA.StatusScan != StatusScan.NOTAPPLICABLE)*/
        }

        $scope.filterExemptionList = function () {
            var dateOfApp = $scope.VA.DateOfApplication;
            if ($scope.VA.StatusId < 3)
                dateOfApp = convertDate(new Date());
            if ($scope.VA.Application_VisaTypeRequestedId !== null && $scope.VA.Application_VisaTypeRequestedId > 0) {
                if ($scope.VA.Personal_Data_BirthDate !== '' && $scope.VA.Application_VisaTypeRequestedId !== null && $scope.VA.Application_MemberStateOfDestinationId !== null) {
                    CodeTypeService.getExemptionByVisaType($scope.VA.Application_VisaTypeRequestedId, $scope.VA.Personal_Data_BirthDate, dateOfApp, $scope.VA.AppId, $scope.VA.Application_MemberStateOfDestinationId).then(function (data) {
                        $scope.FingerprintExemptions = data.data.Exemptions;
                        $scope.canEditFingerprintExemption = true;
                        if ($scope.FingerprintExemptions !== undefined && $scope.FingerprintExemptions.length > 0 && $scope.FingerprintExemptions[0].CanBeManuallySelected === false) {
                            $scope.VA.Application_FingerprintExemptionId = $scope.FingerprintExemptions[0].Value;
                            $scope.canEditFingerprintExemption = false;
                        }
                        $scope.needFingerprintExemptionReason = false;
                        $scope.VA.Application_FingerprintExemptionReason_Mandatory = false;
                        var findExemptionInList = false;
                        for (var i = 0; i < $scope.FingerprintExemptions.length; i++) {
                            if ($scope.VA.Application_FingerprintExemptionId != undefined && $scope.FingerprintExemptions[i].Value === $scope.VA.Application_FingerprintExemptionId) {
                                findExemptionInList = true;
                                if ($scope.FingerprintExemptions[i].ExemptionReasonRequired) {
                                    $scope.VA.Application_FingerprintExemptionReason_Mandatory = true;
                                    $scope.needFingerprintExemptionReason = true;
                                }
                                break;
                            }
                        }
                        if (!findExemptionInList)
                            $scope.VA.Application_FingerprintExemptionId = null;
                        $scope.UpdateFingerPrintPicture();
                        $scope.BuildBioModLink();
                    });
                }
            }
        }

        $scope.filterVacList = function () {

            $scope.FilteredVacs = [];

            for (i = 0; i < $scope.Lists.VacTypes.length; i++) {
                vac = $scope.Lists.VacTypes[i];

                if ($scope.VA.SelectedVacCountry != undefined && $scope.VA.SelectedVacCountry !== "") {
                    if (vac.CountryId == $scope.VA.SelectedVacCountry) {
                        $scope.FilteredVacs.push(vac);
                    }
                    else {
                        if (vac.Value == $scope.VA.VacId) {
                            $scope.VA.VacId = undefined;
                        }
                    }
                }
                else
                    $scope.FilteredVacs.push(vac);
            }
            if (!($scope.VA.SelectedVacCountry > 0)) {
                $scope.VA.SelectedVacCountry = undefined;
            }
            if (!($scope.VA.SelectedVacCountry > 0) || $scope.FilteredVacs[0].CountryId != $scope.VA.SelectedVacCountry || ($scope.FilteredVacs.length > 1 && $scope.showDialog == false)) {
                $scope.VA.VacId = undefined;
            }

            else if (!$scope.VA.Edit) {
                if ($scope.FilteredVacs[0] && $scope.FilteredVacs.length == 1) {
                    $scope.VA.VacId = $scope.FilteredVacs[0].Value;
                    // if ($scope.VA.)
                    if ($scope.VA.SelectedVacCountry == undefined || $scope.VA.SelectedVacCountry != $scope.FilteredVacs[0].CountryId) {
                        $scope.VA.SelectedVacCountry = $scope.FilteredVacs[0].CountryId;
                    }
                }
            }
            else {
                $scope.VA.Edit = false;
            }

        }

        $scope.filterBrexit = function () {
            return function (item) {
                if (item.Iso === 'BEL')
                    return false;
                if ($scope.TravelDocumentTypeAllowingAllKindCountries.includes($scope.VA.TravelDocument_DocumentTypeId))
                    return true;
                if (item.Iso != 'GBR' || $scope.VA.Application_VisaTypeRequestedId == 3) {
                    return true;
                }
                return false;
            };
        };








        // TODO: add lo-dash (or underscore) to deal with collections (done that way to limitate impacts)
        var getCountryNameFromCountryList = function (id, countryList) {
            for (var i = 0; i < countryList.length; ++i) {
                if (countryList[i].Value == id)
                    return countryList[i].Iso;
            }
        }

        // TODO: modify existing ngAddress directive (done that way to limitate impacts)
        $scope.$watch('VA.Personal_Data_Address.CountryId', function (newValue, oldValue, scope) {
            scope.isPermitForResidenceRequired();
        });
        $scope.isPermitForResidenceRequired = function () {
            var nationality = $scope.VA.Personal_Data_NationalityId;
            var country = $scope.VA.Personal_Data_Address;
            if (nationality && country.CountryId && nationality > 0 && country.CountryId > 0) {
                if (getCountryNameFromCountryList(nationality, $scope.Lists.NationalityNonEUTypes) == getCountryNameFromCountryList(country.CountryId, $scope.Lists.CountryNonSchengenTypes)) {
                    $scope.VA.PermitForResidenceRequired = false;
                }
                else {
                    $scope.VA.PermitForResidenceRequired = true;
                }
            }
            else {
                $scope.VA.PermitForResidenceRequired = false;
            }
        }



        $scope.DisplayDocumentList = function (CanHandleDocument) {
            if ( //$scope.anyDocument === true &&

                CanHandleDocument) {
                $window.location.href = '/' + $window.location.pathname.replace(/^\/([^\/]*).*$/, '$1') + '/VisaApplication/DocumentsByVacore/' + AppId;
            }
        }


        $scope.$watch('VA.Application_VisaTypeRequestedId', function (newValue, oldValue, scope) {
            scope.isPermitForDestinationRequired();
        });
        $scope.isPermitForDestinationRequired = function () {
            var visaRequestType = $scope.VA.Application_VisaTypeRequestedId;
            if (visaRequestType && visaRequestType === 1) {
                $scope.VA.PermitForDestinationRequired = true;
            }
            else {
                $scope.VA.PermitForDestinationRequired = false;
            }
        }
        //$scope.uploadFile = function () {

        //    var file = $scope.myFile;
        //    console.log('file is ');
        //    console.dir(file);
        //    $scope.path = "http://localhost:17982/nl/VisaApplication//UploadFile";
        //    var fd = new FormData();
        //    fd.append('image', file);

        //    $http({
        //        method: "POST",
        //        url: $scope.path,
        //        data: fd,  // pass in data as strings
        //        headers: {
        //            'Content-Type': undefined
        //        },
        //        transformRequest: angular.identity
        //    });

        //};
        $scope.filterOtherNationalities = function (selectedCountry) {
            return function (item) {
                if (item.Value == selectedCountry) {
                    return true;
                }
                for (i = 0; i < $scope.VA.Personal_Data_Other_Nationalities.length; i++) {
                    if ($scope.VA.Personal_Data_Other_Nationalities[i] == item.Value) {
                        return false;
                    }
                }
                return true;
            };
        };

    }]);

app.filter('escape', function () {
    return window.encodeURIComponent;
});

app.directive('fileModel', ['$parse', function ($parse) {
    return {
        restrict: 'A',
        link: function (scope, element, attrs) {
            var model = $parse(attrs.fileModel);
            var modelSetter = model.assign;

            element.bind('change', function () {
                scope.$apply(function () {
                    modelSetter(scope, element[0].files[0]);
                });
            });
        }
    };
}]);
app.directive('ngConfirmClick', [
    function () {
        return {
            link: function (scope, element, attr) {
                var msg = attr.ngConfirmClick || "Are you sure?";
                var clickAction = attr.confirmedClick;
                element.bind('click', function (event) {
                    if (window.confirm(msg)) {
                        scope.$eval(clickAction)
                    }
                });
            }
        };
    }
]);

app.directive('capitalize', ['accentRemoveService', function (accentRemoveService) {
    return {
        require: 'ngModel',
        link: function (scope, element, attrs, modelCtrl) {
            var capitalize = function (inputValue) {
                // if (inputValue == undefined || inputValue == null) inputValue = '';
                if (inputValue == undefined || inputValue == null) return;// /*inputValue*/ = '';

                var capitalized = accentRemoveService.removeAccent(inputValue).toUpperCase();
                var selection = element[0].selectionStart;
                modelCtrl.$setViewValue(capitalized);
                modelCtrl.$render();
                // set back the cursor after rendering
                element[0].selectionStart = selection;
                element[0].selectionEnd = selection;

                return capitalized;
            }
            modelCtrl.$parsers.push(capitalize);
            capitalize(scope[attrs.ngModel]); // capitalize initial value
        }
    };
}]);






// app.service('fileUpload', ['$https:', function ($https:) {
//    this.uploadFileToUrl = function(file, uploadUrl) {
//       var fd = new FormData();
//       fd.append('file', file);

//       $https:.post(uploadUrl, fd, {
//          transformRequest: angular.identity,
//          headers: {'Content-Type': undefined}
//       })
//       .success(function() {
//       })
//       .error(function() {
//       });
//    }
// }]);



//// The directive to get a file upload






//app.directive('capitalizee', ['accentRemoveService', function(accentRemoveService) {
//    return {
//    require: 'ngModel',
//        link: function (scope, element, attrs, modelCtrl) {
//            var capitalize = function (inputValue) {

//                if(inputValue == undefined || inputValue == null) inputValue = '';

//                var capitalized = accentRemoveService.removeAccent(inputValue).toUpperCase();
//                var selection = element[0].selectionStart;
//                modelCtrl.$setViewValue(capitalized);
//                modelCtrl.$render();
//                // set back the cursor after rendering
//                element[0].selectionStart = selection;
//                element[0].selectionEnd = selection;

//                return capitalized;
//                //return inputValue;
//            }
//            modelCtrl.$parsers.push(capitalize);
//            capitalize(scope[attrs.ngModel]); // capitalize initial value
//        }
//        };
//        }]);





//app.directive('ngConfirmClick', [
//    function () {
//        return {
//            link: function (scope, element, attr) {
//                var msg = attr.ngConfirmClick || "Are you sure?";
//                var clickAction = attr.confirmedClick;
//                element.bind('click', function (event) {
//                    if (window.confirm(msg)) {
//                        scope.$eval(clickAction)
//                    }
//                });
//            }
//        };
//    }]);

//Prevent submit, back and adjust scroll on tab key
function stopKey(evt) {
    var rx = /INPUT|TEXTAREA/i;
    var rxT = /RADIO|CHECKBOX|SUBMIT/i;
    var rxTa = /TEXTAREA/i;
    var preventKeyPress;
    if (evt.keyCode === 13) {
        // prevent submit on key Enter
        // preventKeyPress = true;
        var c = evt.srcElement || evt.target;
        if (rxTa.test(evt.target.tagName)) {
            preventKeyPress = c.readOnly || c.disabled;
        } else {
            preventKeyPress = true;
        }
    } else if (evt.keyCode === 8) {
        // prevent previous page on key Backspace
        var d = evt.srcElement || evt.target;
        if (rx.test(evt.target.tagName)) {
            var preventPressBasedOnType = false;
            if (d.attributes["type"]) {
                preventPressBasedOnType = rxT.test(d.attributes["type"].value);
            }
            preventKeyPress = d.readOnly || d.disabled || preventPressBasedOnType;
        } else {
            preventKeyPress = true;
        }
    } else if (evt.keyCode === 9) {
        preventKeyPress = false;
        var rect = document.activeElement.getBoundingClientRect();
        if (typeof rect != "undefined" && rect)
            if ((window.innerHeight - rect.bottom) < 100)
                window.scrollBy(0, (window.innerHeight / 2));
    } else {
        preventKeyPress = false;
    }

    if (preventKeyPress) evt.preventDefault();
}

document.onkeydown = stopKey;

function AddScrollSpy() {
    $("#scrollBlock").scrollspy({ target: "#sidebar", offset: 55 });
}

function AddScrollCorrection() {
    // When our page loads, check to see if it contains and anchor
    scroll_if_anchor(window.location.hash);

    // Intercept all anchor clicks
    $("body").on("click", "a[data-toggle!=tab]", scroll_if_anchor);
}

function scroll_if_anchor(href) {
    href = typeof (href) === "string" ? href : $(this).attr("href");

    // You could easily calculate this dynamically if you prefer
    var fromTop = 55;
    if (typeof href != "undefined" && href)
        if (href.indexOf("#") === 0) {
            var $target = $(href);

            // Older browser without pushState might flicker here, as they momentarily
            // jump to the wrong position (IE < 10)
            if ($target.length) {
                $("html, body").animate({
                    scrollTop: $target.offset().top - fromTop
                });
                if (history && "pushState" in history) {
                    history.pushState({
                    }, document.title, window.location.pathname + href);
                    return false;
                }
            }
        }
}

