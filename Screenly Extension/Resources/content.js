const screenlyState = {
    prepared: false,
    originalScrollX: 0,
    originalScrollY: 0,
    originalHtmlScrollBehavior: null,
    originalBodyScrollBehavior: null,
    originalHistoryScrollRestoration: null,
    captureStyleElement: null,
    feedbackHost: null,
    feedbackHideTimer: null,
    suppressedElements: [],
    suppressedElementSet: new WeakSet()
};

browser.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) {
        return undefined;
    }

    return handleMessage(message)
        .then((value) => ({ ok: true, ...value }))
        .catch((error) => ({
            ok: false,
            error: {
                code: error.code || "capture_failed",
                message: error.message || "Screenly could not capture this page.",
                developerMessage: error.developerMessage || String(error)
            }
        }));
});

async function handleMessage(message) {
    switch (message.type) {
    case "SCREENLY_PING":
        return {};

    case "SCREENLY_PREPARE_CAPTURE":
        prepareCapture();
        return {
            originalScrollX: screenlyState.originalScrollX,
            originalScrollY: screenlyState.originalScrollY,
            metrics: collectMetrics()
        };

    case "SCREENLY_GET_METRICS":
        return collectMetrics();

    case "SCREENLY_PRELOAD_LAZY_CONTENT":
        return preloadLazyContent(Number(message.maxDurationMs) || 12_000);

    case "SCREENLY_SCROLL_TO":
        return scrollToPosition(Number(message.x) || 0, Number(message.y) || 0, Boolean(message.suppressFixed));

    case "SCREENLY_RESTORE_CAPTURE":
        restoreCapture();
        return {};

    case "SCREENLY_SHOW_FEEDBACK":
        showFeedback(message.state || "capturing", message.message || "Capturing");
        return {};

    case "SCREENLY_HIDE_FEEDBACK":
        hideFeedback();
        return {};

    default:
        throw contentError("invalid_message", "Screenly sent an unsupported page request.");
    }
}

function prepareCapture() {
    if (screenlyState.prepared) {
        return;
    }

    const html = document.documentElement;
    const body = document.body;

    screenlyState.prepared = true;
    screenlyState.originalScrollX = window.scrollX;
    screenlyState.originalScrollY = window.scrollY;
    screenlyState.originalHtmlScrollBehavior = html.style.getPropertyValue("scroll-behavior");
    screenlyState.originalBodyScrollBehavior = body?.style.getPropertyValue("scroll-behavior") || null;

    installCaptureStyles();
    html.style.setProperty("scroll-behavior", "auto", "important");
    body?.style.setProperty("scroll-behavior", "auto", "important");

    if ("scrollRestoration" in history) {
        screenlyState.originalHistoryScrollRestoration = history.scrollRestoration;
        history.scrollRestoration = "manual";
    }
}

async function preloadLazyContent(maxDurationMs) {
    prepareCapture();

    const startedAt = performance.now();
    let metrics = collectMetrics();
    const step = Math.max(240, Math.floor(metrics.viewportHeight * 0.75));
    let y = 0;

    while (y <= Math.max(0, metrics.pageHeight - metrics.viewportHeight)) {
        window.scrollTo(screenlyState.originalScrollX, y);
        await waitForPaint(120);
        metrics = collectMetrics();
        if (performance.now() - startedAt > maxDurationMs) {
            break;
        }
        y += step;
    }

    return collectMetrics();
}

async function scrollToPosition(x, y, suppressFixed) {
    prepareCapture();

    if (suppressFixed) {
        suppressFixedAndStickyElements();
    }

    const metrics = collectMetrics();
    const clampedX = clamp(x, 0, Math.max(0, metrics.pageWidth - metrics.viewportWidth));
    const clampedY = clamp(y, 0, Math.max(0, metrics.pageHeight - metrics.viewportHeight));

    window.scrollTo(clampedX, clampedY);
    await waitForScrollToSettle(clampedX, clampedY, 700);
    await waitForPaint(140);

    if (suppressFixed) {
        suppressFixedAndStickyElements();
        await waitForPaint(80);
    }

    return collectMetrics();
}

function restoreCapture() {
    if (!screenlyState.prepared) {
        return;
    }

    restoreFixedAndStickyElements();
    removeCaptureStyles();

    const html = document.documentElement;
    const body = document.body;

    window.scrollTo(screenlyState.originalScrollX, screenlyState.originalScrollY);

    restoreStyleProperty(html, "scroll-behavior", screenlyState.originalHtmlScrollBehavior);
    if (body) {
        restoreStyleProperty(body, "scroll-behavior", screenlyState.originalBodyScrollBehavior);
    }

    if ("scrollRestoration" in history && screenlyState.originalHistoryScrollRestoration) {
        history.scrollRestoration = screenlyState.originalHistoryScrollRestoration;
    }

    screenlyState.prepared = false;
    screenlyState.originalHtmlScrollBehavior = null;
    screenlyState.originalBodyScrollBehavior = null;
    screenlyState.originalHistoryScrollRestoration = null;
}

function collectMetrics() {
    const documentElement = document.documentElement;
    const body = document.body;
    const visualViewport = window.visualViewport;
    const viewportWidth = Math.round(visualViewport?.width || window.innerWidth || documentElement.clientWidth || 1);
    const viewportHeight = Math.round(visualViewport?.height || window.innerHeight || documentElement.clientHeight || 1);

    const pageWidth = Math.ceil(Math.max(
        documentElement.scrollWidth,
        documentElement.offsetWidth,
        documentElement.clientWidth,
        body?.scrollWidth || 0,
        body?.offsetWidth || 0,
        viewportWidth
    ));

    const pageHeight = Math.ceil(Math.max(
        documentElement.scrollHeight,
        documentElement.offsetHeight,
        documentElement.clientHeight,
        body?.scrollHeight || 0,
        body?.offsetHeight || 0,
        viewportHeight
    ));

    return {
        href: location.href,
        title: document.title,
        pageWidth,
        pageHeight,
        viewportWidth,
        viewportHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        maxScrollX: Math.max(0, pageWidth - viewportWidth),
        maxScrollY: Math.max(0, pageHeight - viewportHeight),
        devicePixelRatio: window.devicePixelRatio || 1
    };
}

function suppressFixedAndStickyElements() {
    const elements = Array.from(document.body?.getElementsByTagName("*") || []);
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    for (const element of elements) {
        if (element === document.documentElement || element === document.body) {
            continue;
        }
        if (screenlyState.suppressedElementSet.has(element)) {
            continue;
        }

        const style = getComputedStyle(element);
        if (!shouldSuppressViewportElement(style, element, viewportWidth, viewportHeight)) {
            continue;
        }

        if (!intersectsViewport(element.getBoundingClientRect(), viewportWidth, viewportHeight)) {
            continue;
        }

        screenlyState.suppressedElements.push({
            element,
            visibility: element.style.getPropertyValue("visibility"),
            visibilityPriority: element.style.getPropertyPriority("visibility")
        });
        screenlyState.suppressedElementSet.add(element);
        element.style.setProperty("visibility", "hidden", "important");
    }
}

function shouldSuppressViewportElement(style, element, viewportWidth, viewportHeight) {
    const position = style.position;
    if (position !== "fixed" && position !== "sticky") {
        return false;
    }

    const rect = element.getBoundingClientRect();
    if (!intersectsViewport(rect, viewportWidth, viewportHeight)) {
        return false;
    }

    if (position === "fixed") {
        return true;
    }

    const maxStickyChromeHeight = viewportHeight * 0.35;
    if (rect.height > maxStickyChromeHeight) {
        return false;
    }

    const topInset = cssPixelValue(style.top);
    const bottomInset = cssPixelValue(style.bottom);
    const pinnedToTop = style.top !== "auto" && rect.top <= topInset + 3;
    const pinnedToBottom = style.bottom !== "auto" && rect.bottom >= viewportHeight - bottomInset - 3;

    return pinnedToTop || pinnedToBottom;
}

function intersectsViewport(rect, viewportWidth, viewportHeight) {
    return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= 0 &&
        rect.right >= 0 &&
        rect.top <= viewportHeight &&
        rect.left <= viewportWidth;
}

function restoreFixedAndStickyElements() {
    for (const record of screenlyState.suppressedElements) {
        restoreStyleProperty(record.element, "visibility", record.visibility, record.visibilityPriority);
    }
    screenlyState.suppressedElements = [];
    screenlyState.suppressedElementSet = new WeakSet();
}

function installCaptureStyles() {
    if (screenlyState.captureStyleElement?.isConnected) {
        return;
    }

    const style = document.createElement("style");
    style.dataset.screenlyCapture = "true";
    style.textContent = `
html,
body {
    scroll-behavior: auto !important;
    overflow-anchor: none !important;
}

*,
*::before,
*::after {
    scroll-snap-align: none !important;
    scroll-snap-stop: normal !important;
    scroll-snap-type: none !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    animation-play-state: paused !important;
}`;

    (document.head || document.documentElement).append(style);
    screenlyState.captureStyleElement = style;
}

function removeCaptureStyles() {
    screenlyState.captureStyleElement?.remove();
    screenlyState.captureStyleElement = null;
}

function showFeedback(state, message) {
    const host = ensureFeedbackHost();
    const root = host.shadowRoot;
    const panel = root.getElementById("panel");
    const loadingIcon = root.getElementById("loading-icon");
    const spinner = root.getElementById("spinner");
    const errorIcon = root.getElementById("error-icon");
    const label = root.getElementById("label");

    if (screenlyState.feedbackHideTimer) {
        clearTimeout(screenlyState.feedbackHideTimer);
        screenlyState.feedbackHideTimer = null;
    }

    panel.className = `panel ${state === "error" ? "error" : "capturing"}`;
    loadingIcon.hidden = state === "error";
    spinner.hidden = state === "error";
    errorIcon.hidden = state !== "error";
    label.textContent = message;
    host.hidden = false;

    if (state === "error") {
        screenlyState.feedbackHideTimer = setTimeout(() => {
            hideFeedback();
        }, 4_000);
    }
}

function hideFeedback() {
    if (screenlyState.feedbackHideTimer) {
        clearTimeout(screenlyState.feedbackHideTimer);
        screenlyState.feedbackHideTimer = null;
    }
    screenlyState.feedbackHost?.remove();
    screenlyState.feedbackHost = null;
}

function ensureFeedbackHost() {
    if (screenlyState.feedbackHost?.isConnected) {
        return screenlyState.feedbackHost;
    }

    const host = document.createElement("div");
    host.dataset.screenlyFeedback = "true";
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.left = "50%";
    host.style.bottom = "24px";
    host.style.transform = "translateX(-50%)";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none";

    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
        <style>
            :host {
                color-scheme: light dark;
            }

            .panel {
                min-height: 36px;
                display: inline-flex;
                align-items: center;
                gap: 4px;
                max-width: min(420px, calc(100vw - 32px));
                padding: 4px 8px 4px 4px;
                border: 0;
                border-radius: 999px;
                background: rgb(255 255 255);
                color: rgb(0 0 0);
                font: 14px/20px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
                font-weight: 510;
                letter-spacing: 0;
                box-shadow: 0 8px 12px 12px rgb(246 246 246 / 0.48);
            }

            .icon-container {
                width: 28px;
                height: 28px;
                flex: 0 0 auto;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 4px;
                border-radius: 999px;
                background: rgb(246 246 246);
                overflow: hidden;
            }

            .spinner {
                width: 16px;
                height: 16px;
                border: 2px solid rgb(0 0 0 / 0.14);
                border-top-color: rgb(0 0 0);
                border-radius: 50%;
                animation: screenly-spin 800ms linear infinite;
            }

            .spinner[hidden] {
                display: none;
            }

            .icon-container[hidden] {
                display: none;
            }

            .error-icon {
                background: rgb(251 218 218);
                color: rgb(255 96 92);
            }

            .error-icon[hidden] {
                display: none;
            }

            .error-icon svg {
                display: block;
                width: 16px;
                height: 16px;
            }

            .label {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            @media (prefers-color-scheme: dark) {
                .panel {
                    background: rgb(35 35 37);
                    color: rgb(245 245 247);
                    box-shadow: 0 8px 18px 12px rgb(0 0 0 / 0.26);
                }

                .icon-container {
                    background: rgb(50 50 53);
                }

                .spinner {
                    border-color: rgb(245 245 247 / 0.22);
                    border-top-color: rgb(245 245 247);
                }

                .error-icon {
                    background: rgb(88 38 38);
                    color: rgb(255 105 97);
                }
            }

            @keyframes screenly-spin {
                to {
                    transform: rotate(360deg);
                }
            }
        </style>
        <div id="panel" class="panel capturing">
            <span id="loading-icon" class="icon-container">
                <span id="spinner" class="spinner" aria-hidden="true"></span>
            </span>
            <span id="error-icon" class="icon-container error-icon" aria-hidden="true" hidden>
                <svg viewBox="0 0 16 16" fill="none">
                    <path d="M8 2.25L14.25 13H1.75L8 2.25Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                    <path d="M8 6.25V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    <path d="M8 11.75H8.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                </svg>
            </span>
            <span id="label" class="label">Capturing</span>
        </div>
    `;

    (document.documentElement || document.body).append(host);
    screenlyState.feedbackHost = host;
    return host;
}

function restoreStyleProperty(element, property, value, priority = "") {
    if (!value) {
        element.style.removeProperty(property);
    } else {
        element.style.setProperty(property, value, priority);
    }
}

function waitForPaint(extraDelay = 0) {
    return new Promise((resolve) => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (extraDelay > 0) {
                    setTimeout(resolve, extraDelay);
                } else {
                    resolve();
                }
            });
        });
    });
}

async function waitForScrollToSettle(targetX, targetY, timeoutMs) {
    const startedAt = performance.now();
    let lastX = window.scrollX;
    let lastY = window.scrollY;
    let stableFrames = 0;

    while (performance.now() - startedAt < timeoutMs) {
        await waitForPaint(30);

        const currentX = window.scrollX;
        const currentY = window.scrollY;
        const closeToTarget = Math.abs(currentX - targetX) <= 1 && Math.abs(currentY - targetY) <= 1;
        const stoppedMoving = Math.abs(currentX - lastX) <= 0.5 && Math.abs(currentY - lastY) <= 0.5;

        stableFrames = stoppedMoving ? stableFrames + 1 : 0;
        if (closeToTarget || stableFrames >= 2) {
            return;
        }

        lastX = currentX;
        lastY = currentY;
    }
}

function cssPixelValue(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

function contentError(code, message, developerMessage) {
    const error = new Error(message);
    error.code = code;
    error.developerMessage = developerMessage;
    return error;
}
