app.service('messageService', [function () {
    this.sendErrorMessage = function (message) {
        //TODO: logging?
        $.gritter.add({
            position: 'bottom-right',
            //title: 'Success',
            text: message,
            class_name: 'danger'
        });
    };
    
    this.sendInfoMessage = function (message) {
        //TODO: logging?
        $.gritter.add({
            position: 'bottom-right',
            //title: 'Success',
            text: message,
            class_name: 'info'
        });
    };
    
    this.sendWarningMessage = function (message) {
        //TODO: logging?
        $.gritter.add({
            position: 'bottom-right',
            //title: 'Success',
            text: message,
            class_name: 'warning'
        });
    };
    
    this.sendSuccessMessage = function (message) {
        //TODO: logging?
        $.gritter.add({
            position: 'bottom-right',
            //title: 'Success',
            text: message,
            class_name: 'success'
        });
    };
}]);