$(function () {
    AddScrollSpy();
    AddScrollCorrection();
});

function AddScrollSpy() {
    $("body").scrollspy({ target: "#sidebar" , offset: 50});
}

function AddScrollCorrection() {
    // When our page loads, check to see if it contains and anchor
    scroll_if_anchor(window.location.hash);

    // Intercept all anchor clicks
    $("body").on("click", "a[data-toggle!=tab]", scroll_if_anchor);
}

function scroll_if_anchor(href) {
    href = typeof (href) == "string" ? href : $(this).attr("href");

    // You could easily calculate this dynamically if you prefer
    var fromTop = 30;
    if (href != null)
        if (href.indexOf("#") == 0) {
            var $target = $(href);

            // Older browser without pushState might flicker here, as they momentarily
            // jump to the wrong position (IE < 10)
            if ($target.length) {
                $("html, body").animate({ scrollTop: $target.offset().top - fromTop });
                if (history && "pushState" in history) {
                    history.pushState({}, document.title, window.location.pathname + href);
                    return false;
                }
            }
        }
}