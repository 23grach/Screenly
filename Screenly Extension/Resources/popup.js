import { errorPresentation, normalizeError } from "./errors.js";

const captureButtons = Array.from(document.querySelectorAll(".capture-option"));
const statusElement = document.getElementById("status");
const errorElement = document.getElementById("error");
const errorTitleElement = document.getElementById("error-title");
const errorDetailElement = document.getElementById("error-detail");
const errorActionButton = document.getElementById("error-action");
const spinner = document.getElementById("spinner");

let isCapturing = false;

for (const button of captureButtons) {
    button.addEventListener("click", async () => {
        const mode = button.dataset.mode;
        if (mode) {
            await startCapture(mode);
        }
    });
}

errorActionButton.addEventListener("click", async () => {
    const mode = errorActionButton.dataset.mode;
    if (mode) {
        await startCapture(mode);
    }
});

async function startCapture(mode) {
    if (isCapturing) {
        return;
    }

    setBusy(true);
    setStatus(mode === "fullPage" ? "Capturing full page..." : "Capturing visible area...");
    setError("");

    try {
        const response = await browser.runtime.sendMessage({
            type: "START_CAPTURE",
            mode
        });

        if (!response || response.ok !== true) {
            const error = response?.error;
            throw normalizeError(error || new Error("Capture failed."), error?.code || "capture_failed");
        }

        setStatus("Preview opened.");
        window.setTimeout(() => window.close(), 350);
    } catch (error) {
        const presentation = errorPresentation(error, {
            fallbackCode: "capture_failed",
            mode,
            surface: "popup"
        });
        setError(presentation);
        setStatus("");
        console.error("Screenly popup capture failed", presentation);
    } finally {
        setBusy(false);
    }
}

browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "CAPTURE_PROGRESS" && isCapturing) {
        setStatus(message.message || "");
    }
});

function setBusy(busy) {
    isCapturing = busy;
    spinner.hidden = !busy;
    for (const button of captureButtons) {
        button.disabled = busy;
    }
    errorActionButton.disabled = busy;
}

function setStatus(message) {
    statusElement.textContent = message;
}

function setError(presentation) {
    if (!presentation) {
        errorTitleElement.textContent = "";
        errorDetailElement.textContent = "";
        errorActionButton.textContent = "";
        delete errorActionButton.dataset.mode;
        errorActionButton.hidden = true;
        errorElement.hidden = true;
        return;
    }

    errorTitleElement.textContent = presentation.title;
    errorDetailElement.textContent = presentation.detail;
    if (presentation.action) {
        errorActionButton.textContent = presentation.action.label;
        errorActionButton.dataset.mode = presentation.action.mode;
        errorActionButton.hidden = false;
    } else {
        errorActionButton.textContent = "";
        delete errorActionButton.dataset.mode;
        errorActionButton.hidden = true;
    }
    errorElement.hidden = false;
}
