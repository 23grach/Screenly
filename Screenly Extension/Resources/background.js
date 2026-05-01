import { ScreenlyError, normalizeError, userMessageForCode } from "./errors.js";
import { sendNative } from "./native.js";

const CAPTURE_CHUNK_CHARS = 512 * 1024;
const READABLE_MODES = new Set(["visible", "fullPage"]);
const COMMAND_MODES = new Map([
    ["capture-full-page", "fullPage"],
    ["capture-visible-area", "visible"]
]);
const MAX_CANVAS_PIXELS = 120_000_000;
const MAX_LONG_EDGE = 65_000;
const SCROLL_SETTLE_MS = 260;
const TILE_OVERLAP_RATIO = 0.12;

let activeCapture = null;

browser.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "START_CAPTURE") {
        return undefined;
    }

    return startCapture(message.mode)
        .then((result) => ({ ok: true, ...result }))
        .catch((error) => {
            const normalized = normalizeError(error, "capture_failed");
            console.error("Screenly capture failed", normalized);
            return {
                ok: false,
                error: {
                    code: normalized.code,
                    message: userMessageForCode(normalized.code),
                    developerMessage: normalized.developerMessage || normalized.message
                }
            };
        });
});

if (browser.commands?.onCommand) {
    browser.commands.onCommand.addListener((command) => {
        const mode = COMMAND_MODES.get(command);
        if (!mode) {
            return;
        }

        runShortcutCapture(mode);
    });
}

async function runShortcutCapture(mode) {
    let tab = null;

    try {
        tab = await activeTab();
        validateCapturableTab(tab);
        await showPageFeedback(tab.id, "capturing", "Capturing");
        await startCapture(mode, { tab });
        await hidePageFeedback(tab.id);
    } catch (error) {
        const normalized = normalizeError(error, "capture_failed");
        console.error("Screenly shortcut capture failed", normalized);
        if (tab?.id) {
            await showPageFeedback(tab.id, "error", userMessageForCode(normalized.code));
        }
    }
}

async function startCapture(mode, options = {}) {
    if (!READABLE_MODES.has(mode)) {
        throw new ScreenlyError("invalid_mode", "Invalid capture mode.");
    }
    if (activeCapture) {
        throw new ScreenlyError("concurrent_capture", "A screenshot is already being captured.");
    }

    const tab = options.tab || await activeTab();
    validateCapturableTab(tab);

    activeCapture = { tabId: tab.id, startedAt: Date.now() };
    let prepared = false;

    try {
        emitProgress("Preparing page...");
        await pingContentScript(tab.id);
        const preparation = await sendTabMessage(tab.id, { type: "SCREENLY_PREPARE_CAPTURE" });
        prepared = true;

        const initialMetrics = await sendTabMessage(tab.id, { type: "SCREENLY_GET_METRICS" });
        const begin = await sendNative("beginSession", { mode });

        emitProgress(mode === "visible" ? "Capturing visible area..." : "Preparing full page...");
        const result = mode === "visible"
            ? await captureVisibleArea(tab, begin)
            : await captureFullPage(tab, begin, preparation, initialMetrics);

        emitProgress("Opening preview...");
        const previewURL = new URL(browser.runtime.getURL("preview.html"));
        previewURL.searchParams.set("id", result.captureId);
        previewURL.searchParams.set("title", tab.title || "");
        await browser.tabs.create({
            url: previewURL.href
        });

        return {
            captureId: result.captureId,
            width: result.width,
            height: result.height
        };
    } finally {
        if (prepared) {
            try {
                await sendTabMessage(tab.id, { type: "SCREENLY_RESTORE_CAPTURE" });
            } catch (error) {
                console.warn("Screenly could not restore page state", error);
            }
        }
        activeCapture = null;
    }
}

async function showPageFeedback(tabId, state, message) {
    try {
        await browser.tabs.sendMessage(tabId, {
            type: "SCREENLY_SHOW_FEEDBACK",
            state,
            message
        });
    } catch (error) {
        console.warn("Screenly could not show page feedback", error);
    }
}

async function hidePageFeedback(tabId) {
    try {
        await browser.tabs.sendMessage(tabId, {
            type: "SCREENLY_HIDE_FEEDBACK"
        });
    } catch (error) {
        console.warn("Screenly could not hide page feedback", error);
    }
}

async function captureVisibleArea(tab, session) {
    await assertTargetTabStillActive(tab);
    const dataUrl = await captureVisibleTab(tab.windowId);
    const info = await uploadSegment(session.sessionId, 0, dataUrl);

    const segment = {
        index: 0,
        sourceWidth: info.width,
        sourceHeight: info.height,
        cropX: 0,
        cropY: 0,
        cropWidth: info.width,
        cropHeight: info.height,
        destX: 0,
        destY: 0,
        destWidth: info.width,
        destHeight: info.height
    };

    return sendNative("finalizeSession", {
        sessionId: session.sessionId,
        captureId: session.captureId,
        mode: "visible",
        outputWidth: info.width,
        outputHeight: info.height,
        segments: [segment]
    });
}

async function captureFullPage(tab, session, preparation, initialMetrics) {
    emitProgress("Loading page content...");
    await sendTabMessage(tab.id, {
        type: "SCREENLY_PRELOAD_LAZY_CONTENT",
        maxDurationMs: 12_000
    });

    const metrics = await readStableMetrics(tab.id);
    validatePageIsStable(initialMetrics, metrics, true);
    preflightEstimatedSize(metrics);

    const yPositions = buildVerticalPositions(metrics);
    const segments = [];
    const captures = [];
    let scaleY = null;
    let outputWidth = null;
    let outputHeight = null;
    let expectedTileHeight = null;

    for (let index = 0; index < yPositions.length; index += 1) {
        emitProgress(`Capturing ${index + 1} of ${yPositions.length}...`);
        const requestedY = yPositions[index];
        const scrolledMetrics = await sendTabMessage(tab.id, {
            type: "SCREENLY_SCROLL_TO",
            x: preparation.originalScrollX,
            y: requestedY,
            suppressFixed: index > 0
        });

        validateCaptureStillOnSamePage(metrics, scrolledMetrics);
        await delay(SCROLL_SETTLE_MS);
        await assertTargetTabStillActive(tab);

        const dataUrl = await captureVisibleTab(tab.windowId);
        const info = await uploadSegment(session.sessionId, index, dataUrl);

        if (scaleY === null) {
            scaleY = info.height / scrolledMetrics.viewportHeight;
            outputWidth = info.width;
            outputHeight = Math.round(metrics.pageHeight * scaleY);
            expectedTileHeight = info.height;
            validateOutputSize(outputWidth, outputHeight);
        } else {
            if (Math.abs(info.width - outputWidth) > 1 || Math.abs(info.height - expectedTileHeight) > 2) {
                throw new ScreenlyError("page_resized", "The page changed size while Screenly was capturing it.");
            }
        }

        captures.push({
            index,
            info,
            metrics: scrolledMetrics
        });
    }

    segments.push(...buildStitchSegments(captures, outputWidth, outputHeight, scaleY));

    emitProgress("Building PNG...");
    return sendNative("finalizeSession", {
        sessionId: session.sessionId,
        captureId: session.captureId,
        mode: "fullPage",
        outputWidth,
        outputHeight,
        segments
    });
}

async function activeTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length || typeof tabs[0].id !== "number") {
        throw new ScreenlyError("unsupported_page", "Screenly could not find an active Safari tab.");
    }
    return tabs[0];
}

function validateCapturableTab(tab) {
    const url = tab.url || "";
    if (!/^(https?|file):/i.test(url)) {
        throw new ScreenlyError("unsupported_page", "This Safari page cannot be captured.");
    }
}

async function pingContentScript(tabId) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < 1_500) {
        try {
            const response = await browser.tabs.sendMessage(tabId, { type: "SCREENLY_PING" });
            if (response && response.ok) {
                return;
            }
        } catch (error) {
            lastError = error;
        }
        await delay(150);
    }
    throw new ScreenlyError(
        "content_script_unavailable",
        "Screenly cannot access this page. Check Safari website permissions for the extension.",
        lastError ? String(lastError.message || lastError) : undefined
    );
}

async function sendTabMessage(tabId, message) {
    try {
        const response = await browser.tabs.sendMessage(tabId, message);
        if (response && response.ok === false) {
            throw new ScreenlyError(response.error?.code || "capture_failed", response.error?.message || "Screenly could not capture this page.", response.error?.developerMessage);
        }
        return response;
    } catch (error) {
        if (error instanceof ScreenlyError) {
            throw error;
        }
        throw new ScreenlyError(
            "content_script_unavailable",
            "Screenly cannot access this page. Check Safari website permissions for the extension.",
            String(error?.message || error)
        );
    }
}

async function readStableMetrics(tabId) {
    let chosenMetrics = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const metrics = await sendTabMessage(tabId, { type: "SCREENLY_GET_METRICS" });
        if (!chosenMetrics || metrics.pageHeight > chosenMetrics.pageHeight) {
            chosenMetrics = metrics;
        }
        if (attempt < 2) {
            await delay(250);
        }
    }

    return chosenMetrics;
}

async function assertTargetTabStillActive(tab) {
    let current;
    try {
        current = await browser.tabs.get(tab.id);
    } catch (error) {
        throw new ScreenlyError("capture_interrupted", "The captured tab was closed before Screenly finished.", String(error?.message || error));
    }
    if (!current.active || current.windowId !== tab.windowId) {
        throw new ScreenlyError("capture_interrupted", "The active tab changed before Screenly finished capturing.");
    }
}

async function captureVisibleTab(windowId) {
    try {
        return await browser.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (error) {
        throw new ScreenlyError("capture_api_failed", "Safari could not capture the visible tab.", String(error?.message || error));
    }
}

async function uploadSegment(sessionId, segmentIndex, dataUrl) {
    const marker = "base64,";
    const markerIndex = dataUrl.indexOf(marker);
    if (!dataUrl.startsWith("data:image/png") || markerIndex < 0) {
        throw new ScreenlyError("capture_failed", "Safari returned an invalid screenshot image.");
    }

    const base64 = dataUrl.slice(markerIndex + marker.length);
    for (let offset = 0; offset < base64.length; offset += CAPTURE_CHUNK_CHARS) {
        const chunk = base64.slice(offset, offset + CAPTURE_CHUNK_CHARS);
        await sendNative("appendSegmentChunk", {
            sessionId,
            segmentIndex,
            chunk
        });
    }

    return sendNative("finishSegment", {
        sessionId,
        segmentIndex
    });
}

function buildVerticalPositions(metrics) {
    const viewportHeight = Math.max(1, metrics.viewportHeight);
    const maxScrollY = Math.max(0, metrics.pageHeight - viewportHeight);
    const step = Math.max(1, Math.floor(viewportHeight * (1 - TILE_OVERLAP_RATIO)));
    const positions = [];
    let y = 0;

    while (y < maxScrollY) {
        positions.push(Math.round(y));
        y += step;
    }

    positions.push(Math.round(maxScrollY));
    return [...new Set(positions)].sort((a, b) => a - b);
}

function buildStitchSegments(captures, outputWidth, outputHeight, scaleY) {
    const sortedCaptures = captures
        .slice()
        .sort((left, right) => left.metrics.scrollY - right.metrics.scrollY);

    const uniqueCaptures = [];
    for (const capture of sortedCaptures) {
        const previous = uniqueCaptures[uniqueCaptures.length - 1];
        if (previous && Math.abs(previous.metrics.scrollY - capture.metrics.scrollY) <= 1) {
            continue;
        }
        uniqueCaptures.push(capture);
    }

    if (!uniqueCaptures.length) {
        throw new ScreenlyError("capture_failed", "Screenly did not capture any page segments.");
    }

    const firstY = uniqueCaptures[0].metrics.scrollY;
    if (Math.abs(firstY) > 2) {
        throw new ScreenlyError("page_resized", "The page did not scroll to the top before capture.");
    }

    const segments = [];
    for (let index = 0; index < uniqueCaptures.length; index += 1) {
        const capture = uniqueCaptures[index];
        const nextCapture = uniqueCaptures[index + 1];
        const destY = Math.max(0, Math.round(capture.metrics.scrollY * scaleY));
        const nextDestY = nextCapture
            ? Math.max(destY + 1, Math.round(nextCapture.metrics.scrollY * scaleY))
            : outputHeight;
        const requestedStripeHeight = nextDestY - destY;

        if (requestedStripeHeight > capture.info.height + 2) {
            throw new ScreenlyError("page_resized", "The page skipped while Screenly was capturing it.");
        }

        const remainingHeight = outputHeight - destY;
        if (remainingHeight <= 0) {
            continue;
        }

        const cropHeight = Math.max(1, Math.min(capture.info.height, requestedStripeHeight, remainingHeight));
        const cropWidth = Math.max(1, Math.min(capture.info.width, outputWidth));

        segments.push({
            index: capture.index,
            sourceWidth: capture.info.width,
            sourceHeight: capture.info.height,
            cropX: 0,
            cropY: 0,
            cropWidth,
            cropHeight,
            destX: 0,
            destY,
            destWidth: cropWidth,
            destHeight: cropHeight
        });
    }

    return segments;
}

function validatePageIsStable(baseline, current, allowHeightGrowth) {
    validateSamePageGeometry(baseline, current);

    if (!allowHeightGrowth) {
        const tolerance = Math.max(128, baseline.viewportHeight * 0.25);
        if (Math.abs(baseline.pageHeight - current.pageHeight) > tolerance) {
            throw new ScreenlyError("page_resized", "The page height changed while Screenly was capturing it.");
        }
    }
}

function validateCaptureStillOnSamePage(baseline, current) {
    validateSamePageGeometry(baseline, current);
}

function validateSamePageGeometry(baseline, current) {
    if (baseline.href !== current.href) {
        throw new ScreenlyError("page_navigated", "The page navigated before Screenly finished capturing.");
    }
    if (Math.abs(baseline.viewportWidth - current.viewportWidth) > 2 || Math.abs(baseline.viewportHeight - current.viewportHeight) > 2) {
        throw new ScreenlyError("page_resized", "The page viewport changed while Screenly was capturing it.");
    }
    if (Math.abs(baseline.pageWidth - current.pageWidth) > 4) {
        throw new ScreenlyError("page_resized", "The page width changed while Screenly was capturing it.");
    }
}

function preflightEstimatedSize(metrics) {
    const scale = Math.max(1, metrics.devicePixelRatio || 1);
    const estimatedWidth = Math.ceil(metrics.viewportWidth * scale);
    const estimatedHeight = Math.ceil(metrics.pageHeight * scale);
    if (estimatedWidth > MAX_LONG_EDGE || estimatedHeight > MAX_LONG_EDGE || estimatedWidth * estimatedHeight > MAX_CANVAS_PIXELS * 1.15) {
        throw new ScreenlyError("page_too_large", "This page is too large to capture as one PNG.");
    }
}

function validateOutputSize(width, height) {
    if (width > MAX_LONG_EDGE || height > MAX_LONG_EDGE || width * height > MAX_CANVAS_PIXELS) {
        throw new ScreenlyError("page_too_large", "This page is too large to capture as one PNG.");
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitProgress(message, details = {}) {
    browser.runtime.sendMessage({
        type: "CAPTURE_PROGRESS",
        message,
        ...details
    }).catch(() => {});
}
