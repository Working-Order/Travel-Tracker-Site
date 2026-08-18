// The radial menu: the app's floating actions on an arc around one anchor.
//
// Blazor owns the markup and the clicks. Everything here is the motion the
// markup cannot express: the rail sweeping in, the ring of actions spinning
// between pages, and the blob that chases whichever action is under the
// pointer. Those are simulated per frame, so a stylesheet cannot do them and a
// round trip to .NET would arrive a frame late.
//
// Ported from the study-guide dock in FE-Practice, with three changes worth
// knowing about. It hangs off the bottom-right corner rather than the
// bottom-left, because that is the corner this app's floating buttons already
// lived in and moving them across the screen would be a change nobody asked
// for. It sizes its ring to however many actions are registered instead of a
// fixed six. And it answers to a thumb as well as a pointer: press to open,
// drag along the arc to turn it.

/** How many actions sit on the arc at once. A page turn moves exactly this
 *  many, so the visible set always lands snapped rather than half-turned. */
const VISIBLE = 3;

/** Radians between neighbouring slots -- three of them spanning a quarter turn
 *  from beside the anchor to above it. */
const SLOT_ANGLE = Math.PI / 4;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const FINE_POINTER = "(hover: hover) and (pointer: fine)";

/** Long enough to cross the gap between two buttons without the dock deciding
 *  the pointer has left it. */
const CLOSE_DELAY = 450;

/** A drag this far along the arc is a page turn rather than a press. */
const SWIPE_DISTANCE = 34;

/** Air between the outside of a button and the label naming it. */
const TIP_GAP = 10;

let live = null;

/**
 * @param {HTMLElement} dock the element Blazor rendered
 */
export function attach(dock) {
    detach();

    if (!dock) {
        return;
    }

    live = build(dock);
}

export function detach() {
    live?.destroy();
    live = null;
}

function build(dock) {
    const anchor = dock.querySelector(".rad-anchor");
    const items = dock.querySelector(".rad-items");
    const bubbleLead = dock.querySelector(".rad-bubble-lead");
    const bubbleTail = dock.querySelector(".rad-bubble-tail");
    const dots = Array.from(dock.querySelectorAll(".rad-pager-dot"));

    if (!anchor || !items) {
        return null;
    }

    const reduced = window.matchMedia(REDUCED_MOTION);
    const fine = window.matchMedia(FINE_POINTER);

    // The tooltip lives on the body because the dock clips its own overflow --
    // which is what cuts the arc flush against the window edge -- and a pill
    // inside it would be cut off with everything else. Being outside the
    // element Blazor rendered also keeps it clear of Blazor's diffing.
    const tip = document.createElement("div");
    tip.className = "rad-tip";
    document.body.appendChild(tip);

    let closeTimer = null;
    let open = false;

    // A changed action list is rebuilt rather than patched, and the element it
    // is rebuilt around is the same one the last instance was driving. Anything
    // that instance left on it belongs to a menu that no longer exists, so the
    // dock is put back to shut before this one starts believing it is.
    dock.classList.remove("rad-open", "rad-blob-on", "rad-turning");
    anchor.setAttribute("aria-expanded", "false");

    // --- opening and closing ------------------------------------------------

    function setOpen(next) {
        clearCloseTimer();

        if (open === next) {
            return;
        }

        open = next;
        dock.classList.toggle("rad-open", open);
        anchor.setAttribute("aria-expanded", String(open));

        if (!open) {
            settleRingNow();
            dismissBlob();
        }
    }

    function clearCloseTimer() {
        if (closeTimer) {
            clearTimeout(closeTimer);
            closeTimer = null;
        }
    }

    function scheduleClose() {
        clearCloseTimer();
        closeTimer = setTimeout(() => {
            closeTimer = null;
            setOpen(false);
        }, CLOSE_DELAY);
    }

    const onAnchorClick = (event) => {
        // The anchor is only ever a latch. In the menu this came from it also
        // navigated home on a second press, which meant the same button did
        // two things depending on a state the user could not see.
        event.preventDefault();
        setOpen(!open);
    };

    // Hover opens it on a mouse, where there is a pointer to hover with. On a
    // touch screen every "hover" is really a tap that is about to become a
    // click, and opening on it would make the anchor unpressable.
    const onAnchorEnter = () => {
        if (fine.matches) {
            setOpen(true);
        }
    };

    const onDockEnter = () => {
        if (open) {
            clearCloseTimer();
        }
    };

    const onDockLeave = () => {
        if (fine.matches) {
            scheduleClose();
        }
    };

    const onFocusIn = (event) => {
        setOpen(true);
        showTip(event.target.closest("[data-rad-tip]"));
    };

    const onFocusOut = (event) => {
        if (!dock.contains(event.relatedTarget)) {
            scheduleClose();
        }

        hideTip();
    };

    const onDocumentPointerDown = (event) => {
        if (!dock.contains(event.target)) {
            setOpen(false);
        }
    };

    const onKeyDown = (event) => {
        if (event.key === "Escape" && open) {
            setOpen(false);
            anchor.focus();
        }
    };

    // Choosing something closes the menu. The click itself is Blazor's.
    const onItemsClick = () => setOpen(false);

    anchor.addEventListener("click", onAnchorClick);
    anchor.addEventListener("mouseenter", onAnchorEnter);
    dock.addEventListener("mouseenter", onDockEnter);
    dock.addEventListener("mouseleave", onDockLeave);
    dock.addEventListener("focusin", onFocusIn);
    dock.addEventListener("focusout", onFocusOut);
    items.addEventListener("click", onItemsClick);
    document.addEventListener("pointerdown", onDocumentPointerDown);
    document.addEventListener("keydown", onKeyDown);

    // --- geometry -----------------------------------------------------------
    //
    // Everything is measured from the corner the anchor sits in, which is the
    // bottom-right one: x runs back towards the middle of the screen, so the
    // arc is laid out along negative x.

    function metrics() {
        const box = dock.getBoundingClientRect();
        const styles = getComputedStyle(dock);

        // Built from the two lengths rather than read from --rad-center, which
        // the stylesheet derives with calc(). A custom property keeps whatever
        // was written in it until something uses it in a real declaration, so
        // what comes back here is the text "calc(...)" and not a number.
        const inset = parseFloat(styles.getPropertyValue("--rad-inset")) || 8;
        const size = parseFloat(styles.getPropertyValue("--rad-size")) || 52;
        const center = inset + size / 2;
        const radius = parseFloat(styles.getPropertyValue("--rad-gap")) || 62;

        return { cx: box.width - center, cy: box.height - center, radius, size };
    }

    function buttons() {
        return Array.from(items.querySelectorAll(".rad-button"));
    }

    /** Slots on the ring: enough whole pages to hold every action. */
    function slots() {
        return Math.max(VISIBLE, Math.ceil(buttons().length / VISIBLE) * VISIBLE);
    }

    function wrap(value) {
        const size = slots();
        return ((value % size) + size) % size;
    }

    function pageOf(offset) {
        return Math.floor(wrap(offset) / VISIBLE);
    }

    // --- the ring -----------------------------------------------------------
    //
    // Each action holds a fixed index on a ring; ringOffset is how far that
    // ring has been turned, counted in slots. A page turn springs the offset by
    // three, so actions sweep along the arc and out through one end while the
    // next three come in at the other.

    let ringOffset = 0;
    let ringTarget = 0;
    let ringVelocity = 0;
    let ringRaf = null;
    let ringLast = 0;

    function positionRing(offset) {
        const { radius } = metrics();

        buttons().forEach((button) => {
            let rel = wrap(Number(button.dataset.radIndex) - offset);

            // The slot immediately behind the arc is read as -1 rather than as
            // the far end of the ring, so an action leaving by the near end
            // fades out there instead of jumping to the other end to do it.
            // Only when there is somewhere to leave to: on a single page every
            // slot is a visible one, and wrapping any of them would blank it.
            if (slots() > VISIBLE && rel > slots() - 2) {
                rel -= slots();
            }

            const angle = rel * SLOT_ANGLE;

            // Full presence across the three slots, fading over one slot-width
            // past either end so nothing pops in or out at the arc's mouth.
            const fade = rel < 0 ? 1 + rel : rel > VISIBLE - 1 ? VISIBLE - rel : 1;
            const presence = Math.max(0, Math.min(1, fade));

            button.style.transform =
                `translate(${-Math.cos(angle) * radius}px, ${-Math.sin(angle) * radius}px) ` +
                `scale(${0.5 + presence * 0.5})`;
            button.style.opacity = String(presence);
            button.style.visibility = presence > 0.01 ? "visible" : "hidden";
        });
    }

    function finalizeRing() {
        ringRaf = null;
        ringTarget = wrap(ringTarget);
        ringOffset = ringTarget;
        ringVelocity = 0;
        dock.classList.remove("rad-turning");

        const page = pageOf(ringTarget);

        // Hand the buttons back to the stylesheet's open/close animations.
        buttons().forEach((button) => {
            button.style.transform = "";
            button.style.opacity = "";
            button.style.visibility = "";
            button.classList.toggle("rad-off-page", Math.floor(Number(button.dataset.radIndex) / VISIBLE) !== page);
        });

        updateDots();
        rehover();
    }

    /** Snaps a turn in flight, so closing never leaves a button stranded on the
     *  inline styles the animation was driving. */
    function settleRingNow() {
        if (!ringRaf) {
            return;
        }

        cancelAnimationFrame(ringRaf);
        finalizeRing();
    }

    function ringTick(now) {
        const dt = Math.min((now - ringLast) / 1000, 1 / 30);
        ringLast = now;

        [ringOffset, ringVelocity] = spring(ringOffset, ringVelocity, ringTarget, 130, 17, dt);

        if (Math.abs(ringOffset - ringTarget) < 0.01 && Math.abs(ringVelocity) < 0.05) {
            finalizeRing();
            return;
        }

        positionRing(ringOffset);
        ringRaf = requestAnimationFrame(ringTick);
    }

    function turnPage(direction) {
        if (slots() <= VISIBLE) {
            return;
        }

        ringTarget += VISIBLE * (direction > 0 ? 1 : -1);
        dismissBlob();
        updateDots();

        if (reduced.matches) {
            settleRingNow();
            ringTarget = wrap(ringTarget);
            finalizeRing();
            return;
        }

        dock.classList.add("rad-turning");

        if (!ringRaf) {
            ringLast = performance.now();
            ringRaf = requestAnimationFrame(ringTick);
        }
    }

    function goToPage(page) {
        const current = pageOf(ringTarget);

        if (page === current) {
            return;
        }

        // The shorter way round, so pressing the last dot from the first does
        // not wind the whole ring past every page in between.
        const total = slots() / VISIBLE;
        const forward = (page - current + total) % total;
        const backward = (current - page + total) % total;
        const steps = forward <= backward ? forward : -backward;

        for (let i = 0; i < Math.abs(steps); i += 1) {
            turnPage(Math.sign(steps));
        }
    }

    function updateDots() {
        const page = pageOf(ringTarget);
        dots.forEach((dot) => dot.classList.toggle("rad-pager-dot-active", Number(dot.dataset.radPage) === page));
    }

    const onDotClick = (event) => goToPage(Number(event.currentTarget.dataset.radPage));

    dots.forEach((dot) => dot.addEventListener("click", onDotClick));

    // --- the blob -----------------------------------------------------------
    //
    // Under-damped springs rather than transitions: a lead blob chases the
    // button being pointed at like a weight on a spring, a tail blob chases the
    // lead a beat behind, and each stretches along its own velocity so fast
    // means long and thin. The goo filter in the markup melts the overlapping
    // pair into one body that necks as it travels and wobbles as it lands.

    const blob = {
        started: false,
        el: null,
        x: 0, y: 0, vx: 0, vy: 0,
        x2: 0, y2: 0, vx2: 0, vy2: 0,
        tx: 0, ty: 0,
        scale: 0, vs: 0, targetScale: 0,
    };

    let blobRaf = null;
    let blobLast = 0;
    let blobHideTimer = null;

    function dockCenterOf(el) {
        const box = dock.getBoundingClientRect();
        const rect = el.getBoundingClientRect();

        return { x: rect.left + rect.width / 2 - box.left, y: rect.top + rect.height / 2 - box.top };
    }

    /** Pins a point to the rail, so the blob travels around the arc rather than
     *  taking the chord across the middle of it. */
    function ontoRail(point) {
        const { cx, cy, radius } = metrics();
        const dx = point.x - cx;
        const dy = point.y - cy;
        const length = Math.hypot(dx, dy) || 1;

        return { x: cx + (dx / length) * radius, y: cy + (dy / length) * radius };
    }

    /** The same pinning applied mid-flight, with the velocity that pulled the
     *  blob off the rail taken back out of it. */
    function holdToRail(x, y, vx, vy) {
        const { cx, cy, radius } = metrics();
        const dx = x - cx;
        const dy = y - cy;
        const length = Math.hypot(dx, dy) || 1;
        const ux = dx / length;
        const uy = dy / length;
        const outward = vx * ux + vy * uy;

        return { x: cx + ux * radius, y: cy + uy * radius, vx: vx - ux * outward, vy: vy - uy * outward };
    }

    function blobTransform(x, y, vx, vy, scale, stretchDivisor) {
        const speed = Math.hypot(vx, vy);
        const angle = speed > 1 ? Math.atan2(vy, vx) : 0;
        const stretch = Math.min(speed / stretchDivisor, 0.55);

        // Volume-preserving: as long as it grows one way it thins the other.
        return `translate(${x}px, ${y}px) translate(-50%, -50%) ` +
            `rotate(${angle}rad) scale(${Math.max(scale, 0) * (1 + stretch)}, ${Math.max(scale, 0) / (1 + stretch)})`;
    }

    function blobTick(now) {
        // Clamped, so a tab that was in the background does not come back with
        // a two-minute step and throw the integration across the screen.
        const dt = Math.min((now - blobLast) / 1000, 1 / 30);
        blobLast = now;

        // Read the target every frame rather than once: a button still flying
        // out on the fan animation is somewhere new each time, and the blob
        // should follow it in rather than wait at where it will end up.
        if (blob.el) {
            const point = ontoRail(dockCenterOf(blob.el));
            blob.tx = point.x;
            blob.ty = point.y;
        }

        [blob.x, blob.vx] = spring(blob.x, blob.vx, blob.tx, 190, 17, dt);
        [blob.y, blob.vy] = spring(blob.y, blob.vy, blob.ty, 190, 17, dt);

        const lead = holdToRail(blob.x, blob.y, blob.vx, blob.vy);
        blob.x = lead.x;
        blob.y = lead.y;
        blob.vx = lead.vx;
        blob.vy = lead.vy;

        [blob.x2, blob.vx2] = spring(blob.x2, blob.vx2, blob.x, 150, 19, dt);
        [blob.y2, blob.vy2] = spring(blob.y2, blob.vy2, blob.y, 150, 19, dt);

        const tail = holdToRail(blob.x2, blob.y2, blob.vx2, blob.vy2);
        blob.x2 = tail.x;
        blob.y2 = tail.y;
        blob.vx2 = tail.vx;
        blob.vy2 = tail.vy;

        [blob.scale, blob.vs] = spring(blob.scale, blob.vs, blob.targetScale, 170, 21, dt);

        bubbleLead.style.transform = blobTransform(blob.x, blob.y, blob.vx, blob.vy, blob.scale, 700);
        bubbleTail.style.transform = blobTransform(blob.x2, blob.y2, blob.vx2, blob.vy2, blob.scale * 0.9, 800);

        const settled = Math.hypot(blob.vx, blob.vy) < 2
            && Math.hypot(blob.vx2, blob.vy2) < 2
            && Math.abs(blob.vs) < 0.02
            && Math.hypot(blob.tx - blob.x, blob.ty - blob.y) < 0.5
            && Math.abs(blob.targetScale - blob.scale) < 0.005;

        if (settled) {
            blobRaf = null;
            return;
        }

        blobRaf = requestAnimationFrame(blobTick);
    }

    function kickBlob() {
        if (blobRaf || !bubbleLead || !bubbleTail) {
            return;
        }

        blobLast = performance.now();
        blobRaf = requestAnimationFrame(blobTick);
    }

    function showBlob(button) {
        if (reduced.matches || !bubbleLead) {
            return;
        }

        if (blobHideTimer) {
            clearTimeout(blobHideTimer);
            blobHideTimer = null;
        }

        dock.classList.add("rad-blob-on");

        const target = ontoRail(dockCenterOf(button));

        if (!blob.started) {
            blob.x = blob.x2 = target.x;
            blob.y = blob.y2 = target.y;
            blob.tx = target.x;
            blob.ty = target.y;
            blob.started = true;
        }

        blob.el = button;
        blob.targetScale = 1;
        kickBlob();
    }

    /** Crossing the gap between two buttons un-hovers everything for a moment.
     *  Without this pause the blob would collapse on every swap instead of
     *  flowing along the rail to the next one. */
    function hideBlob() {
        if (blobHideTimer) {
            return;
        }

        blobHideTimer = setTimeout(() => {
            blobHideTimer = null;
            dropBlob();
        }, 140);
    }

    /** No pause: for a menu that is closing, where the pointer may never leave
     *  in a way the browser reports. */
    function dismissBlob() {
        if (blobHideTimer) {
            clearTimeout(blobHideTimer);
            blobHideTimer = null;
        }

        hideTip();
        dropBlob();
    }

    function dropBlob() {
        if (!blob.started) {
            return;
        }

        blob.el = null;
        blob.targetScale = 0;
        dock.classList.remove("rad-blob-on");
        kickBlob();
    }

    // --- the tooltip --------------------------------------------------------

    // The label goes straight out along the same spoke its action sits on,
    // beyond the ring.
    //
    // Put where a tooltip usually goes -- floating just above the thing it
    // names -- it lands on top of the next action along instead, because on a
    // quarter circle the space above one button is where its neighbour lives.
    // Outside the ring there is nothing to cover: every action sits at one
    // radius, so anything past that radius is clear by construction. It also
    // reads as belonging to the button it is in line with, rather than to
    // whichever one it happens to be floating over.
    function showTip(target) {
        const text = target?.dataset.radTip;

        if (!text || !open) {
            return;
        }

        tip.textContent = text;
        tip.classList.add("rad-tip-on");

        const box = dock.getBoundingClientRect();
        const { cx, cy, radius, size } = metrics();
        const originX = box.left + cx;
        const originY = box.top + cy;

        const rect = target.getBoundingClientRect();
        const alongX = rect.left + rect.width / 2 - originX;
        const alongY = rect.top + rect.height / 2 - originY;
        const length = Math.hypot(alongX, alongY) || 1;
        const ux = alongX / length;
        const uy = alongY / length;

        // Out past the button, then out again by half the label measured along
        // the direction it is heading. Without that second part a wide label on
        // a flat spoke would reach back over the button it names, and a tall
        // one would do the same going straight up.
        const clear = radius + size / 2 + TIP_GAP;
        const reach = clear + (Math.abs(ux) * tip.offsetWidth + Math.abs(uy) * tip.offsetHeight) / 2;

        const halfWidth = tip.offsetWidth / 2;
        const halfHeight = tip.offsetHeight / 2;

        tip.style.left = `${clamp(originX + ux * reach, halfWidth + 8, window.innerWidth - halfWidth - 8)}px`;
        tip.style.top = `${clamp(originY + uy * reach, halfHeight + 8, window.innerHeight - halfHeight - 8)}px`;
    }

    function hideTip() {
        tip.classList.remove("rad-tip-on");
    }

    // --- pointing at things -------------------------------------------------

    let lastPointer = null;

    const onPointerOver = (event) => {
        const target = event.target.closest("[data-rad-tip]");

        if (!target || !dock.contains(target)) {
            return;
        }

        showTip(target);

        const button = target.closest(".rad-button");

        if (button && button !== anchor) {
            showBlob(button);
        } else {
            hideBlob();
        }
    };

    const onPointerOut = (event) => {
        const target = event.target.closest("[data-rad-tip]");

        if (!target) {
            return;
        }

        hideTip();

        const button = target.closest(".rad-button");

        if (button && button !== anchor) {
            hideBlob();
        }
    };

    const onPointerMove = (event) => {
        lastPointer = { x: event.clientX, y: event.clientY };
    };

    /** A page turn moves the menu under a pointer that has not moved, so
     *  nothing reports as newly hovered when it lands. This puts the blob and
     *  the tooltip back on whatever is now under the pointer. */
    function rehover() {
        if (!lastPointer || !open || !fine.matches) {
            return;
        }

        const under = document.elementFromPoint(lastPointer.x, lastPointer.y);
        const target = under?.closest?.("[data-rad-tip]");

        if (!target || !dock.contains(target)) {
            return;
        }

        showTip(target);

        const button = target.closest(".rad-button");

        if (button && button !== anchor) {
            showBlob(button);
        }
    }

    dock.addEventListener("pointerover", onPointerOver);
    dock.addEventListener("pointerout", onPointerOut);
    dock.addEventListener("pointermove", onPointerMove);

    // --- turning the ring by hand -------------------------------------------
    //
    // A wheel where there is one. On a touch screen, a drag along the arc:
    // up-and-left brings the next page round, which is the same direction the
    // actions themselves travel, so the ring follows the finger rather than
    // opposing it.

    let wheelPooled = 0;
    let wheelReset = null;
    let lastTurn = 0;

    const onWheel = (event) => {
        if (!open || slots() <= VISIBLE) {
            return;
        }

        event.preventDefault();
        lastPointer = { x: event.clientX, y: event.clientY };

        let delta = event.deltaY || event.deltaX || 0;

        // Firefox reports lines and, rarely, pages. Both need to become pixels
        // before they can be compared against a pixel threshold.
        if (event.deltaMode === 1) {
            delta *= 16;
        } else if (event.deltaMode === 2) {
            delta *= 120;
        }

        if (!delta) {
            return;
        }

        // Pooled, so one flick of a trackpad -- which arrives as a long tail of
        // small deltas -- turns one page rather than every page there is.
        if (wheelPooled && Math.sign(delta) !== Math.sign(wheelPooled)) {
            wheelPooled = 0;
        }

        wheelPooled += delta;
        clearTimeout(wheelReset);
        wheelReset = setTimeout(() => { wheelPooled = 0; }, 240);

        const now = performance.now();

        if (Math.abs(wheelPooled) < 40 || now - lastTurn < 280) {
            return;
        }

        lastTurn = now;
        wheelPooled = 0;
        turnPage(delta > 0 ? 1 : -1);
    };

    dock.addEventListener("wheel", onWheel, { passive: false });

    let drag = null;

    const onDragStart = (event) => {
        if (!open || event.pointerType === "mouse" || slots() <= VISIBLE) {
            return;
        }

        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, turned: false };
    };

    const onDragMove = (event) => {
        if (!drag || drag.id !== event.pointerId || drag.turned) {
            return;
        }

        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;

        // Along the arc, which runs up and to the right from the far slot back
        // towards the anchor's corner. Combining both axes means a finger that
        // travels roughly the right way counts, rather than only one that
        // traces the curve exactly.
        const along = dx - dy;

        if (Math.abs(along) < SWIPE_DISTANCE) {
            return;
        }

        drag.turned = true;
        turnPage(along > 0 ? 1 : -1);
    };

    const onDragEnd = (event) => {
        if (!drag || drag.id !== event.pointerId) {
            return;
        }

        // A drag that turned the ring was not a press on whatever it started
        // on, so the click it is about to become is swallowed.
        if (drag.turned) {
            armSwallow();
        }

        drag = null;
    };

    // Capture, because Blazor listens for clicks at the document root: by the
    // time a bubbling handler saw this one the button's callback would already
    // have run. Disarmed on a timer as well as on use -- a finger lifted off
    // the edge of the dock produces no click at all, and a swallower left
    // armed would eat the next real press instead.
    let swallowTimer = null;

    function armSwallow() {
        dock.addEventListener("click", swallow, true);
        clearTimeout(swallowTimer);
        swallowTimer = setTimeout(disarmSwallow, 400);
    }

    function disarmSwallow() {
        clearTimeout(swallowTimer);
        swallowTimer = null;
        dock.removeEventListener("click", swallow, true);
    }

    const swallow = (event) => {
        event.stopPropagation();
        event.preventDefault();
        disarmSwallow();
    };

    // A press on a touch screen is the closest thing it has to a hover, so it
    // is what the blob answers to there.
    const onPressBlob = (event) => {
        if (event.pointerType === "mouse") {
            return;
        }

        const button = event.target.closest(".rad-button");

        if (button && button !== anchor) {
            showBlob(button);
        }
    };

    dock.addEventListener("pointerdown", onDragStart);
    dock.addEventListener("pointerdown", onPressBlob);
    dock.addEventListener("pointermove", onDragMove);
    dock.addEventListener("pointerup", onDragEnd);
    dock.addEventListener("pointercancel", onDragEnd);

    updateDots();
    finalizeRing();

    return {
        destroy() {
            clearCloseTimer();
            disarmSwallow();
            clearTimeout(wheelReset);

            if (blobHideTimer) {
                clearTimeout(blobHideTimer);
            }

            if (blobRaf) {
                cancelAnimationFrame(blobRaf);
            }

            if (ringRaf) {
                cancelAnimationFrame(ringRaf);
            }

            anchor.removeEventListener("click", onAnchorClick);
            anchor.removeEventListener("mouseenter", onAnchorEnter);
            dock.removeEventListener("mouseenter", onDockEnter);
            dock.removeEventListener("mouseleave", onDockLeave);
            dock.removeEventListener("focusin", onFocusIn);
            dock.removeEventListener("focusout", onFocusOut);
            dock.removeEventListener("pointerover", onPointerOver);
            dock.removeEventListener("pointerout", onPointerOut);
            dock.removeEventListener("pointermove", onPointerMove);
            dock.removeEventListener("pointerdown", onDragStart);
            dock.removeEventListener("pointerdown", onPressBlob);
            dock.removeEventListener("pointermove", onDragMove);
            dock.removeEventListener("pointerup", onDragEnd);
            dock.removeEventListener("pointercancel", onDragEnd);
            dock.removeEventListener("wheel", onWheel);
            items.removeEventListener("click", onItemsClick);
            dots.forEach((dot) => dot.removeEventListener("click", onDotClick));
            document.removeEventListener("pointerdown", onDocumentPointerDown);
            document.removeEventListener("keydown", onKeyDown);

            tip.remove();
        },
    };
}

/** Keeps a label on screen when a spoke points at an edge. */
function clamp(value, low, high) {
    return Math.min(Math.max(value, low), high);
}

/**
 * One step of a damped spring, integrated semi-implicitly. Chosen
 * under-damped -- c below twice the root of k -- so an arrival overshoots
 * slightly and is pulled back rather than easing to a dead stop.
 */
function spring(position, velocity, target, k, c, dt) {
    const next = velocity + (k * (target - position) - c * velocity) * dt;

    return [position + next * dt, next];
}
