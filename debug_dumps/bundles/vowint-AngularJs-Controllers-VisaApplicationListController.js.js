app.controller('visaApplicationListController', ['$scope', '$http', '$compile', '$window', 'messageService', '$sanitize', 'CodeTypeService',
    function ($scope, $http, $compile, $window, messageService, $sanitize, CodeTypeService) {
        var rowCompiler = function (nRow, aData, iDataIndex) {
            var linker = $compile(nRow);
            var element = linker($scope);
            nRow = element;
        };

        var renderActionIcon = function (cellValue) {
            var hasApplicationNumber = typeof (cellValue.AppNum) !== "undefined" && cellValue.AppNum !== null;
           
            var editLink = "";
            var printLink = "";
            var groupLink = "";
            if (cellValue.StId > 1)
                printLink = "<button type='button' class='btn btn-primary btn-sm' ng-click='printVA(&#39;" + cellValue.Id + "&#39;)'><span class='glyphicon glyphicon-print'></span></button>";
            if (cellValue.outsourcerUser  && hasApplicationNumber)
            {
                editLink = "<button type='button' class='btn btn-primary btn-sm'";
                editLink = editLink + " ng-click='ShowUserDetailModal(&#39;" + cellValue.AppNum + "&#39,&#39;" + cellValue.LName + "&#39,&#39;" +
                    cellValue.FName + "&#39,&#39;" + cellValue.MobileNumber + "&#39,&#39;" + cellValue.PhoneNumber + "&#39,&#39;" + cellValue.Email + "&#39; )' >" +
                    "<span class='glyphicon glyphicon-user'/></button>";
                printLink = "";
                  
            }
            else {
                editLink = "<button type='button' class='btn btn-primary btn-sm' ng-click='editVA(&#39;" + cellValue.Id + "&#39;)'><span class='glyphicon glyphicon-pencil'></span></button>";
            }
            
            
            if (cellValue.StId == 2)
            {
                if (cellValue.EAppointmentReady)
                    if (cellValue.EappointmentUrl)
                    {

                        groupLink = "<button type='button' class='btn btn-primary btn-sm' ng-click='groupVAEapp(&#39;" + cellValue.Id + "&#39,&#39;"
                    + cellValue.GroupId + "&#39;)'><span class='fa fa-calendar'></span></button>";
                    }
                    else
                    {                     
                            if (!(cellValue.GroupId == 'NA' && cellValue.SubGroupId == 'NA')) {
                                groupLink = "<button type='button' class='btn btn-primary btn-sm' ng-click='groupVA(&#39;" + cellValue.Id + "&#39,&#39;"
                                    + cellValue.CompanyPrefix + "&#39,&#39;"
                                    + cellValue.GroupId + "&#39;)'><span class='fa fa-calendar'></span></button>";
                            }
                            else
                            {
                                groupLink = "<button type='button' class='btn btn-primary btn-sm' ng-click='SingleApplicationNeverClicked(&#39;"
                                    + cellValue.CompanyPrefix + "&#39,&#39;"
                                    + cellValue.Id + "&#39;)'><span class='fa fa-calendar'></span></button>";
                            }
                    }
                    
                else if (cellValue.ShowAppointementSystemOutsourcerUrl)
                    groupLink = "<button type='button' class='btn btn-primary btn-sm' ng-click='openVacWebsite(&#39;" + cellValue.AppointementSystemOutsourcerUrl + "&#39)'><span class='fa fa-calendar'></span></button>";

            }
                
            var actionHtml = editLink + groupLink + printLink;
            return actionHtml;
        };

        var renderStartDate;
        var renderEndDate;

        $scope.roleName = '';
        $scope.VisaStatusId;
        $scope.SearchParam;

        $scope.editVA = function (AppId) {
            $window.location.href = '/' + $window.location.pathname.replace(/^\/([^\/]*).*$/, '$1') + '/VisaApplication/Edit/' + AppId;
        };

        $scope.printVA = function (AppId) {
            $window.open('/VisaApplication/PrintVA?AppId=' + AppId, '_blank');
        };


        $scope.ShowUserDetailModal = function (AppNum, LName, FName, MobileNumber, PhoneNumber, Email)
        {
            $scope.requester = new Object();
            $scope.requester.AppNum = (AppNum !== 'null') ? AppNum : '-';
            $scope.requester.Name = (LName !== 'null') ? LName : '-';
            $scope.requester.FirstName = (FName !== 'null') ? FName : '-';
             
            $scope.requester.MobileNumber = (MobileNumber !== 'null') ?  MobileNumber : '-';

            $scope.requester.PhoneNumber = (PhoneNumber !== 'null') ? PhoneNumber : '-';
            $scope.requester.Email = (Email !== 'null') ? Email : '-';
            $('#detailVisaRequestModal').addClass("md-show");
        }
        $scope.openVacWebsite = function (AppointementSystemOutsourcerUrl) {
            $window.open(AppointementSystemOutsourcerUrl, '_blank');
        }
        $scope.groupVAEapp = function (vaCoreId) {


            $http({
                method: 'Get',
                url: '/Common/GetEAppointmentUrl',
                params: { 'id': vaCoreId },
                cache: false
            }).success(function (data) {
                window.open(data.url, '_blank');

            }).error(function () {
            });
            

        }
        $scope.groupVA = function (AppId,CompanyPrefix, GroupId) {
            //if (subGroupId === undefined || subGroupId === null || subGroupId === 'null') {

            //    $http({
            //        method: 'POST',
            //        url: '/VisaApplication/CreateRdv',
            //        params: { 'Id': AppId },
            //        headers: { 'Content-Type': "application/x-www-form-urlencoded" },
            //        cache: false
            //    }).success(function (data) {
            //        if (data.Success === false) {
            //            //to do manage false message
            //        }

            //    }).error(function () {
            //    });
            //}

            //// to do logic to set subgroupid <> outsource not outsourcer
            if (GroupId !== 'NA')
            {
                
                //var href = '/' + $window.location.pathname.replace(/^\/([^\/]*).*$/, '$1') + '/VisaApplication/IndexGroupByVacoreId/' + AppId;
                $window.location.href = '/' + $window.location.pathname.replace(/^\/([^\/]*).*$/, '$1') + '/VisaApplication/IndexGroupByVacoreId/' + AppId;
            }
            else
            {
                if (CompanyPrefix === 'MSH' || CompanyPrefix === 'BEL') {

                    $http({
                        method: 'POST',
                        url: '/VisaApplication/ManageRdv',
                        params: { 'Id': AppId },
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
                        method: 'POST',
                        url: '/VisaApplication/CreateRdv',
                        params: { 'Id': AppId },
                        headers: { 'Content-Type': "application/x-www-form-urlencoded" },
                        cache: false
                    })
                        .success(function (data) {
                            if (data.EappUrl !== undefined && data.EappUrl !== "") {
                                var eappUrl = data.EappUrl;
                                $window.open(eappUrl, '_blank');
                            }
                            else {
                                var outsourcerWebsite = data.appointmentUrl.concat(data.infoToSent);
                                $window.open(outsourcerWebsite, '_blank');
                            }                      
                   
                        });
                }  
            }
        }
        
        $scope.SingleApplicationNeverClicked = function (CompanyPrefix, AppId) {
            $http({
                method: 'POST',
                url: '/VisaApplication/CreateRdv',
                params: { 'Id': AppId },
                headers: { 'Content-Type': "application/x-www-form-urlencoded" },
                cache: false
            }).success(function (data) {
                var requestdata = { info: data.infoToSent };
                //if (CompanyPrefix === 'VFS' ) {
                if (data.EappUrl !== undefined && data.EappUrl !== "") {
                    var eappUrl = data.EappUrl;
                    $window.open(eappUrl, '_blank');
                }
                else {
                    var outsourcerWebsite = data.appointmentUrl.concat(data.infoToSent);
                    $window.open(outsourcerWebsite, '_blank');
                }
                   
                //}
                //else
                //{
                //    $.post(data.appointmentUrl,
                //   requestdata,
                //   function (data) {
                //       var w = window.open('about:blank');
                //       w.document.open();
                //       w.document.write(data);
                //       w.document.close();
                //   });
                //}


            }).error(function () {
            });
        }
        var renderNameColumn = function (data, type, full, meta) {
            var name = "";
            if (full.LName !== null) name = name + "<strong>" + $sanitize(full.LName) + "</strong> ";
            if (full.FName !== null) name = name + $sanitize(full.FName);
            return name;
        };

        var renderBiometricsIcon = function (data, type, full, meta) {
            // var popover="<div class=&#39;"popover&#39;" ng-show="showPopover"><span>{{ popover.title }}</span>{{ popover.message }}</div>"
            var signGreenLittle="<i class='fa fa-check fa-1 signGreenLittle'></i>" ;
            var signRedLittle = "<i class='fa fa-times  signRedLittle'></i>";

            //facial image check
            var facialImageIcon = full.BioMetric.FacialImage == true ? signGreenLittle : signRedLittle;
            
            var liveOrScan = full.BioMetric.LiveCapture == true ? full.BioMetric.FacialImageLiveText : full.BioMetric.FacialImage == true ? full.BioMetric.FacialImageScanText : '';
            var biometricsIcon = '<a style="font-size: 9px;font-weight: bold;"data-trigger="focus" data-photo="' + full.BioMetric.FacialImageText + " :" + liveOrScan + " " + facialImageIcon;
            

            //fingerprint check
            var fingerPrintText;
            if (full.BioMetric.FingerPrintExemption == true)
                fingerPrintText = full.BioMetric.FingerprintExemption+" - "+ full.BioMetric.FingerPrintExemptionDescription
            else
                if (full.BioMetric.FiveYearsExemption == true)
                    fingerPrintText = full.BioMetric.FiftyNineMonthText + " : ";
                else
                    fingerPrintText = full.BioMetric.FingerprintText;
            fingerPrintText = fingerPrintText + " : ";
            var fingerPrintIcon = (full.BioMetric.FingerPrint == true || full.BioMetric.FingerPrintFingerPrintExemption == true || full.Fingerprints5yearsRule==true) ? signGreenLittle : signRedLittle;
            biometricsIcon = biometricsIcon + '" data-fingerprints="' + fingerPrintText + fingerPrintIcon;



            var passportText = full.BioMetric.MrzText + " : ";
            var passportTextStatus = "";
            var passportIcon = signGreenLittle ;
            if (full.BioMetric.MrzMandatory == false && full.BioMetric.PassportScan==false)
            {
                passportTextStatus = full.BioMetric.MrzMessageNotNecessary;
                passportIcon = signGreenLittle ;
            }
            else
            {
                if (full.BioMetric.PassportScan==false)
                {
                    passportTextStatus = full.BioMetric.Ignored == true ? full.BioMetric.MrzMessageIgnoreMissingScan : full.BioMetric.MrzMessageMissingScan;
                    passportIcon = (full.BioMetric.Ignored == true) ? signGreenLittle : signRedLittle;
                }
                else
                {
                    if (full.BioMetric.Ignored==true)
                    {
                        passportTextStatus = full.BioMetric.MrzMessageIgnoreDifference;
                        passportIcon = signGreenLittle ;
                    }
                    else
                    {
                        if (full.BioMetric.Overwritten == true) {
                            passportTextStatus = full.BioMetric.MrzMessageOKOverwritten;
                            passportIcon = signGreenLittle;
                        }
                        else
                        {
                            passportTextStatus = full.BioMetric.MrzShengenMatch == true ? full.BioMetric.MrzMessageOK : full.BioMetric.MrzMessageDifference;
                            passportIcon = (full.BioMetric.MrzShengenMatch == true) ? signGreenLittle : signRedLittle;
                        }
                    }
                }
            }
            
            biometricsIcon = biometricsIcon + '" data-mrz="' + passportText + passportTextStatus + passportIcon + '" data-placement="bottom" class="visa-list-icon" data-toggle="popover" data-content=" "  href="#">';
            var completeIcon = '<i class="fa fa-exclamation-triangle  signRed"/></a>';

            if (full.Hb)
                completeIcon = '<i class="fa fa-check signGreen"/></a>';

            biometricsIcon = biometricsIcon + completeIcon;
            $(biometricsIcon).data("complete", full);



           // var Vow = cellValue.VOWId;
           // var popup = " ng-mouseover='show" + Vow + "=true;' ng-mouseleave='show" + Vow + "=false;'>";
           //// popup = popup + "<div class='popover' ng-show=show" + Vow + "><span>" + cellValue.FName + "</span>popover.message</div>";
           // popup = popup + "<div class='popover' ng-show=show" + Vow + "><span>" + cellValue.FName + "</span>popover.message</div>";


         //   biometricsIcon = biometricsIcon + popup + "</i>";


            return biometricsIcon;
        };

        //renderStartDate = new Date().getTime();
        //window.onload = getRenderTime;

        var closemodals = function (event) {
            var myModal = $(event.target).closest(".md-modal");
            myModal.removeClass("md-show");
            $('#visaApplicationList').removeClass("bg-opacity-50");
        };
        $scope.closemodal = closemodals; //pointer closeModal

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
                    'actionName': 'ListOfApplications',
                    'time': time
                },
            }).success(function (data) {

            });
        }

        CodeTypeService.getAllVisaStatusTypes()
        .success(function (visaStatusType) {
            $scope.visaStatusType = visaStatusType;
        })
          .error(function (error) {
              $scope.status = 'Unable to load visa status types: ' + error.message;
          });

        $scope.canGetApplications = function () {
            return (!!this.VisaStatus || !!this.SearchParam);
        }
       
        $scope.getApplications = function () {
            
            renderStartDate = new Date().getTime();

            if ($scope.canGetApplications() === false) {
                return;
            }

            var result = new Array();

            $("#VisaStatus option:selected").each(function () {
                result.push($(this).val());
            });

            var selectedVisaStatus = result.join(", ");

            if (selectedVisaStatus != null) {
                $scope.VisaStatusId = selectedVisaStatus;
            } else {
                $scope.VisaStatusId = "";
            }

            if (this.SearchParam != null) {
                $scope.SearchParam = this.SearchParam;
            } else {
                $scope.SearchParam = "";
            }
            $scope.SearchParam = this.SearchParam;

            if ($.fn.dataTable.isDataTable('#vaList')) {
                table = $('#vaList').DataTable();
                table.ajax.reload();
            }
            else {

                $scope.table = $('#vaList').dataTable(
                        {
                            order: [[0, 'desc']],
                            "autoWidth": false,
                            "processing": true,
                            "serverSide": true,
                            "bFilter": false,
                            "initComplete": function (a, b) {


                            },

                            "drawCallback": function (settings) {
                                $(".visa-list-icon").popover({
                                    template: '<div style="z-index:999; position:absolute;width : 300px;font-size: 10px;font-weight: 400;  color: rgb(51, 51, 51);  " class="popover" role="tooltip"><div class="arrow"></div><h3 class="popover-title"></h3><div class="popover-content"></div></div>'
                                });

                                $('.visa-list-icon').on('shown.bs.popover', function (a, b, c) {
                                    $(".popover-content").append('' + $(this).data("photo") + '<br />')
                                    $(".popover-content").append('' + $(this).data("fingerprints") + '<br />')
                                    $(".popover-content").append('' + $(this).data("mrz") + '<br />')
                                });
                                getRenderTime();
                            },
                            "ajax": {
                                url: "/VisaApplication/ListOfApplications",
                                data: function (d) {
                                    d.includeNew = true;
                                    d.visaStatusIds = $scope.VisaStatusId;
                                    d.searchParam = $scope.SearchParam;
                                }
                            },
                            "createdRow": rowCompiler,
                            "columnDefs": [
                                {
                                    
                                    "targets": 0,
                                    "name": "VOWUniqueId",
                                    "data": "VOWId"
                                },
                                {
                                    "targets": 1,
                                    "name": "OSUniqueId",
                                    "data": "OSId"
                                },
                                {
                                    "targets": 2,
                                    "name": "Vac",
                                    "data": "Vac"
                                },
                                {
                                    "targets": 3,
                                    "orderable": false,
                                    "render": renderNameColumn
                                },
                                {
                                    "targets": 4,
                                    "name": "Status",
                                    "data": "St",
                                    "searchable": false,
                                    "orderable": false
                                },
                                {
                                    "targets": 5,
                                    "name": "HasBiometrics",
                                    "data": { "Hb": "Hb" },
                                    "searchable": false,
                                    "orderable": false,
                                    "render": renderBiometricsIcon,
                                    "width": "50px",
                                    "className": "align-center"
                                },
                                {
                                    "targets": 6,
                                    "data": { "Id": "Id" },
                                    "searchable": false,
                                    "orderable": false,
                                    "render": renderActionIcon
                                }
                            ],
                            "language": {
                                "url": "/VisaApplication/DataTables"
                            }
                        });
            }

            $('#vaList').css('visibility', 'visible');
        }

        //JQuery.DataTable
        var myTable = $('#vaMyList').dataTable(
                {
                    order: [[0, 'desc']],
                    "autoWidth": false,
                    "processing": true,
                    "serverSide": true,              
                    "ajax": "/VisaApplication/MyList",
                    "createdRow": rowCompiler,
                    "columnDefs": [
                        {
                            "targets": 0,
                            "name": "VOWUniqueId",
                            "data": "VOWId"                           
                        },
                        {
                            "targets": 1,
                            "name": "ApplicationNumber",
                            "data": "AppNum"
                        },
                        {
                            "targets": 2,
                            "orderable": false,
                            "render": renderNameColumn
                        },
                        {
                            "targets": 3,
                            "name": "Status",
                            "data": "St",
                            "searchable": false,
                            "orderable": false
                        },
                        {
                            "targets": 4,
                            "searchable": false,
                            "orderable": false,
                            "data": { "Id": "Id" },
                            "render": renderActionIcon
                        }
                    ],
                    "language": {
                        "url": "/VisaApplication/DataTables"
                    }
                });
    }]);