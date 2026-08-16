// Makes the assistant panel draggable by its header.
//
// The panel sits over the trip it is talking about, which is exactly where it
// is sometimes in the way: reading an answer about the budget while the budget
// is behind the panel. Docking it to one corner only moves the problem to that
// corner, so it moves wherever the reader puts it, and stays there.
//
// Only on a window wide enough for the panel to be a panel. Below that it is a
// full-screen sheet, where dragging would either do nothing or drag it
// off-screen.

const DESKTOP = "(min-width: 1024px)";

/** Kept out of the corners rather than out of the viewport: a panel with only a
 *  pixel on screen is lost. */
const MARGIN = 24;

let bound = null;

/**
 * @param {HTMLElement} panel the element to move
 * @param {string} storageKey where to remember its position
 */
export function attach(panel, storageKey) {
    if (!panel) {
        return;
    }

    detach();

    const handle = panel.querySelector("[data-drag-handle]") ?? panel;
    const state = { panel, handle, storageKey, pointerId: null, startX: 0, startY: 0, left: 0, top: 0 };

    const onPointerDown = (event) => {
        // A phone gets the sheet, not the panel.
        if (!window.matchMedia(DESKTOP).matches) {
            return;
        }

        // Buttons in the header are controls, not grab points.
        if (event.target.closest("[data-drag-ignore], button, a, input, textarea, select")) {
            return;
        }

        const box = panel.getBoundingClientRect();

        state.pointerId = event.pointerId;
        state.startX = event.clientX;
        state.startY = event.clientY;
        state.left = box.left;
        state.top = box.top;

        // Anchoring to the top-left for the whole drag: the panel is normally
        // positioned from the bottom-right, and mixing the two makes it jump
        // the moment it is picked up.
        place(panel, box.left, box.top);

        try {
            handle.setPointerCapture(event.pointerId);
        } catch {
            // Capture keeps the drag alive when the pointer outruns the header.
            // Without it the drag still works, it just gives up at the edges.
        }

        panel.classList.add("dragging");
        event.preventDefault();
    };

    const onPointerMove = (event) => {
        if (state.pointerId !== event.pointerId) {
            return;
        }

        const box = panel.getBoundingClientRect();
        const left = state.left + (event.clientX - state.startX);
        const top = state.top + (event.clientY - state.startY);

        place(panel, ...clamp(left, top, box.width, box.height));
    };

    const onPointerUp = (event) => {
        if (state.pointerId !== event.pointerId) {
            return;
        }

        state.pointerId = null;
        panel.classList.remove("dragging");

        try {
            handle.releasePointerCapture(event.pointerId);
        } catch {
            // The pointer may already be gone; nothing to release.
        }

        remember(panel, storageKey);
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("resize", onResize);

    bound = { handle, onPointerDown, onPointerMove, onPointerUp };

    restore(panel, storageKey);

    function onResize() {
        if (!panel.isConnected || !window.matchMedia(DESKTOP).matches) {
            return;
        }

        const box = panel.getBoundingClientRect();

        // A window that shrank can leave the panel off the edge, and a position
        // saved on a big monitor can arrive on a laptop.
        if (panel.style.left) {
            place(panel, ...clamp(box.left, box.top, box.width, box.height));
            remember(panel, storageKey);
        }
    }
}

export function detach() {
    if (!bound) {
        return;
    }

    bound.handle.removeEventListener("pointerdown", bound.onPointerDown);
    bound.handle.removeEventListener("pointermove", bound.onPointerMove);
    bound.handle.removeEventListener("pointerup", bound.onPointerUp);
    bound.handle.removeEventListener("pointercancel", bound.onPointerUp);
    bound = null;
}

function place(panel, left, top) {
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
}

function clamp(left, top, width, height) {
    const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    const maxTop = Math.max(MARGIN, window.innerHeight - height - MARGIN);

    return [
        Math.min(Math.max(left, MARGIN), maxLeft),
        Math.min(Math.max(top, MARGIN), maxTop),
    ];
}

function remember(panel, storageKey) {
    try {
        localStorage.setItem(
            storageKey,
            JSON.stringify({ left: parseInt(panel.style.left, 10), top: parseInt(panel.style.top, 10) }),
        );
    } catch {
        // Storage denied. The panel still moves; it just forgets.
    }
}

function restore(panel, storageKey) {
    if (!window.matchMedia(DESKTOP).matches) {
        return;
    }

    let saved = null;

    try {
        saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    } catch {
        saved = null;
    }

    if (!saved || typeof saved.left !== "number" || typeof saved.top !== "number") {
        return;
    }

    const box = panel.getBoundingClientRect();
    place(panel, ...clamp(saved.left, saved.top, box.width, box.height));
}
