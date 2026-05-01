export class ScreenlyError extends Error {
    constructor(code, message, developerMessage) {
        super(message || userMessageForCode(code));
        this.name = "ScreenlyError";
        this.code = code;
        this.developerMessage = developerMessage;
    }
}

const USER_MESSAGES = {
    invalid_mode: "Choose a capture mode and try again.",
    invalid_message: "Screenly could not process the request.",
    unknown_command: "Screenly could not process the request.",
    unsupported_page: "Screenly cannot capture this Safari page.",
    permission_denied: "Screenly does not have access to this website.",
    content_script_unavailable: "Screenly does not have access to this website.",
    capture_api_failed: "Safari blocked the screenshot for this tab.",
    capture_failed: "Screenly could not capture this page.",
    page_navigated: "The page navigated before capture finished.",
    page_resized: "The page kept changing during capture.",
    page_too_large: "This page is too large to capture as one PNG.",
    stitch_failed: "Screenly could not stitch the full-page screenshot.",
    capture_not_found: "Screenly could not find the captured screenshot.",
    export_cancelled: "Export cancelled.",
    export_failed: "Screenly could not export the PNG.",
    clipboard_failed: "Screenly could not copy the image to the clipboard.",
    concurrent_capture: "A screenshot is already being captured.",
    capture_interrupted: "Capture was interrupted before it finished.",
    native_error: "Screenly could not complete the request."
};

const RECOVERY_MESSAGES = {
    invalid_mode: "Choose FullPage Screenshot or Visible Area.",
    invalid_message: "Try again. If it repeats, reload the tab.",
    unknown_command: "Try again after restarting Safari.",
    unsupported_page: "Open a normal website tab. Safari settings, extension pages, private browser pages, and some protected pages cannot be captured.",
    permission_denied: "In Safari, allow Screenly for this website, then try again.",
    content_script_unavailable: "In Safari, allow Screenly for this website, then reload the page and try again.",
    capture_api_failed: "Reload the page and try again. Some protected media or browser pages cannot be captured.",
    capture_failed: "Reload the page and try again. Visible Area may still work if FullPage fails.",
    page_navigated: "Wait for the page to finish loading and keep the same tab active while Screenly captures it.",
    page_resized: "Wait for animations or lazy content to settle, then try again. If it repeats, use Visible Area.",
    page_too_large: "Use Visible Area, zoom out, or capture a shorter page.",
    stitch_failed: "Try FullPage again. If the page is dynamic, use Visible Area.",
    capture_not_found: "Capture the page again; the temporary screenshot is no longer available.",
    export_cancelled: "No file was saved.",
    export_failed: "Try Export again. If Safari blocks it, drag the preview image or use Copy.",
    clipboard_failed: "Try Copy again. If macOS asks for clipboard access, allow it.",
    concurrent_capture: "Wait for the current capture to finish before starting another.",
    capture_interrupted: "Keep the target tab open and active until the preview opens.",
    native_error: "Restart Screenly and Safari, then try again."
};

const FULL_PAGE_FALLBACK_CODES = new Set([
    "capture_failed",
    "page_resized",
    "page_too_large",
    "stitch_failed"
]);

const RETRYABLE_CAPTURE_CODES = new Set([
    "capture_api_failed",
    "capture_interrupted",
    "page_navigated"
]);

export function userMessageForCode(code) {
    return USER_MESSAGES[code] || USER_MESSAGES.capture_failed;
}

export function recoveryMessageForCode(code, context = {}) {
    if (code === "page_too_large" && context.mode === "fullPage") {
        return "Use Visible Area, zoom out, or capture a shorter page.";
    }
    if (code === "page_resized" && context.mode === "fullPage") {
        return "Wait for the page to stop changing, then try FullPage again. If it repeats, use Visible Area.";
    }
    return RECOVERY_MESSAGES[code] || RECOVERY_MESSAGES.capture_failed;
}

export function errorPresentation(error, context = {}) {
    const normalized = normalizeError(error, context.fallbackCode || "capture_failed");
    return {
        code: normalized.code,
        title: userMessageForCode(normalized.code),
        detail: recoveryMessageForCode(normalized.code, context),
        action: recoveryActionForCode(normalized.code, context),
        developerMessage: normalized.developerMessage || normalized.message
    };
}

export function recoveryActionForCode(code, context = {}) {
    if (context.surface !== "popup") {
        return null;
    }

    if (context.mode === "fullPage" && FULL_PAGE_FALLBACK_CODES.has(code)) {
        return {
            label: "Try Visible Area",
            mode: "visible"
        };
    }

    if (RETRYABLE_CAPTURE_CODES.has(code) && context.mode) {
        return {
            label: "Try Again",
            mode: context.mode
        };
    }

    return null;
}

export function normalizeError(error, fallbackCode = "capture_failed") {
    if (error instanceof ScreenlyError) {
        return error;
    }

    if (error && typeof error === "object" && "code" in error) {
        return new ScreenlyError(
            error.code || fallbackCode,
            error.message || userMessageForCode(error.code || fallbackCode),
            error.developerMessage
        );
    }

    return new ScreenlyError(
        fallbackCode,
        userMessageForCode(fallbackCode),
        typeof error?.message === "string" ? error.message : String(error)
    );
}
