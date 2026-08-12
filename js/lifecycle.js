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

export function register(dotNetRef) {
    // Re-registering replaces the old listener rather than stacking a second.
    unregister();

    handler = dotNetRef;
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);
    watchHeader();
}

export function unregister() {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("online", onOnline);

    if (headerObserver) {
        headerObserver.disconnect();
        headerObserver = null;
    }

    handler = null;
}
