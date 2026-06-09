app.directive('scrollspyReflist', function () {
    return {
        restrict: 'E',
        //transclude: true,
        replace: true,
        scope: {
            listModel: '=list',            
        },

        template:
            '<li ng-repeat="ref in listModel | filter:{Sponsor:true}"  data-scrollspy-listen="ReferencePerson{{$index}}"><a>' +
            //'<li data-scrollspy-listen="ReferencePerson{{$index}}" class="nav-sub"><a href="#ReferencePerson{{$index}}" class="linkScrollSpy">{{tother}}<i class="fa fa-angle-right iconMargin"></i>' +
            '<span ng-repeat="subType in Lists.ActorSubTypes | filter:{Value:ref.ActorSubType}:true">{{subType.Text}}</span>' +
            '</a></li>', //uses the url /Adress to get the template controls
            };
});