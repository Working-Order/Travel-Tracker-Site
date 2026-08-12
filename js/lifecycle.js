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

export function register(dotNetRef) {
    // Re-registering replaces the old listener rather than stacking a second.
    unregister();

    handler = dotNetRef;
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);
}

export function unregister() {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("online", onOnline);
    handler = null;
}
