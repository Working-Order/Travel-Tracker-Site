// Tells the app when it comes back to the foreground or regains a connection.
//
// A phone almost never cold-starts an installed PWA -- it resumes one. Without
// this the app only ever synced at launch, so a trip invitation sent while the
// app sat in the background did not appear until it was fully reloaded.

let handler = null;

function notify(reason) {
    if (!handler) {
        return;
    }

    // The .NET side throttles, so firing on every foreground is fine. Failures
    // are swallowed: the component may already have been disposed during
    // navigation, and a rejected interop call must not surface as a page error.
    handler.invokeMethodAsync("OnAppResumed", reason).catch(() => { });
}

function onVisibilityChange() {
    if (document.visibilityState === "visible") {
        notify("visible");
    }
}

function onOnline() {
    notify("online");
}

// Publishes the sticky header's real height as --header-h.
//
// Anything that sticks below the header needs to know how tall it is, and that
// varies: a subtitle adds a line, and inside a trip the section nav adds
// another. Hardcoding an offset means the progress bar hides behind the header
// on exactly the pages where it matters most, so it gets measured instead.
let headerObserver = null;

function watchHeader() {
    const apply = () => {
        const header = document.querySelector(".shell-header");
        if (header) {
            document.documentElement.style.setProperty(
                "--header-h", `${Math.round(header.getBoundingClientRect().height)}px`);
        }
    };

    apply();

    if (typeof ResizeObserver === "undefined") {
        return;
    }

    headerObserver = new ResizeObserver(apply);

    // The header element is replaced on every navigation, so observe the shell
    // and re-measure whenever anything inside it changes size.
    const shell = document.querySelector(".shell") || document.body;
    headerObserver.observe(shell);
}

// Keeps the trip section nav where the user left it.
//
// That nav sits inside the header, and the header is replaced on every
// navigation for the reason above -- so each move between sections handed the
// user a brand new scroll container parked back at Overview. Tapping a section
// near the right-hand end, Flights or Calendar, scrolled the strip back to the
// start under their finger.
//
// The offset is therefore held out here, where it outlives the element, and
// reapplied to each new nav as it appears. Should the restored offset leave the
// active chip out of sight -- opening a different trip, or arriving deep in the
// list from a link -- that chip is centred instead, so the nav never opens on a
// section the user cannot see.
let tripNavScroll = 0;
let tripNavObserver = null;

function onTripNavScroll(event) {
    tripNavScroll = event.currentTarget.scrollLeft;
}

function adoptTripNav() {
    const nav = document.querySelector(".trip-nav");

    // Already wired: Blazor kept the element across this render, and with it the
    // scroll position, so there is nothing to restore.
    if (!nav || nav.dataset.scrollBound === "true") {
        return;
    }

    nav.dataset.scrollBound = "true";

    // Assigning past the end clamps, and the assignment itself fires scroll,
    // so tripNavScroll settles on the value actually reachable.
    nav.scrollLeft = tripNavScroll;

    const active = nav.querySelector("a.active");

    if (active) {
        const start = active.offsetLeft;
        const end = start + active.offsetWidth;

        if (start < nav.scrollLeft || end > nav.scrollLeft + nav.clientWidth) {
            nav.scrollLeft = start - (nav.clientWidth - active.offsetWidth) / 2;
        }
    }

    nav.addEventListener("scroll", onTripNavScroll, { passive: true });
}

function watchTripNav() {
    adoptTripNav();

    if (typeof MutationObserver === "undefined") {
        return;
    }

    // Same reasoning as the header observer: watch the shell, because the nav
    // itself is not the thing that survives.
    tripNavObserver = new MutationObserver(adoptTripNav);

    const shell = document.querySelector(".shell") || document.body;
    tripNavObserver.observe(shell, { childList: true, subtree: true });
}

export function register(dotNetRef) {
    // Re-registering replaces the old listener rather than stacking a second.
    unregister();

    handler = dotNetRef;
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);
    watchHeader();
    watchTripNav();
}

export function unregister() {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("online", onOnline);

    if (headerObserver) {
        headerObserver.disconnect();
        headerObserver = null;
    }

    if (tripNavObserver) {
        tripNavObserver.disconnect();
        tripNavObserver = null;
    }

    handler = null;
}
