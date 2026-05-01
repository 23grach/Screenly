import { ScreenlyError, errorPresentation } from "./errors.js";
import { sendNative } from "./native.js";

const READ_CHUNK_BYTES = 512 * 1024;
const COPY_CHUNK_BYTES = 384 * 1024;

const image = document.getElementById("preview-image");
const statusElement = document.getElementById("status");
const errorElement = document.getElementById("error");
const errorTitleElement = document.getElementById("error-title");
const errorDetailElement = document.getElementById("error-detail");
const metadataElement = document.getElementById("metadata");
const exportButton = document.getElementById("export-button");
const copyButton = document.getElementById("copy-button");

let captureId = null;
let pageTitle = "";
let objectURL = null;
let currentBlob = null;
let nativeCaptureDeleted = false;

window.addEventListener("pagehide", cleanupPreviewResources);
window.addEventListener("beforeunload", cleanupPreviewResources);

function cleanupPreviewResources() {
    if (objectURL) {
        URL.revokeObjectURL(objectURL);
        objectURL = null;
    }
    deleteNativeCapture("page-close");
}

exportButton.addEventListener("click", async () => {
    await withAction(exportButton, async () => {
        setStatus("Exporting...");
        await exportPNG();
        setStatus("Export started.");
    });
});

copyButton.addEventListener("click", async () => {
    await withAction(copyButton, async () => {
        setStatus("Copying...");
        await copyPNGToClipboard();
        setStatus("Copied.");
    });
});

loadPreview().catch((error) => {
    const presentation = errorPresentation(error, { fallbackCode: "capture_failed" });
    setError(presentation);
    setStatus("");
    console.error("Screenly preview failed", presentation);
});

async function loadPreview() {
    const params = new URLSearchParams(location.search);
    captureId = params.get("id");
    pageTitle = params.get("title") || "";
    if (!captureId) {
        throw new Error("Missing capture id.");
    }

    const chunks = [];
    let offset = 0;
    let totalBytes = null;

    while (totalBytes === null || offset < totalBytes) {
        const response = await sendNative("readCaptureChunk", {
            captureId,
            offset,
            length: READ_CHUNK_BYTES
        });

        if (totalBytes === null) {
            totalBytes = Number(response.totalBytes);
            metadataElement.textContent = formatBytes(totalBytes);
        }

        const bytesRead = Number(response.bytesRead);
        if (!Number.isFinite(bytesRead) || bytesRead <= 0) {
            throw new ScreenlyError("capture_not_found", "Screenly could not read the captured screenshot.");
        }

        chunks.push(base64ToBytes(response.chunk || ""));
        offset += bytesRead;
        setStatus(progressMessage(offset, totalBytes));

        if (response.done) {
            break;
        }
    }

    currentBlob = new Blob(chunks, { type: "image/png" });
    objectURL = URL.createObjectURL(currentBlob);

    await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = objectURL;
    });

    image.classList.add("is-loaded");
    document.body.classList.add("is-loaded");
    metadataElement.textContent = `${image.naturalWidth} x ${image.naturalHeight} px - ${formatBytes(totalBytes)}`;
    await deleteNativeCapture("preview-loaded");
    setStatus("");
    exportButton.disabled = false;
    copyButton.disabled = false;
}

async function exportPNG() {
    if (!currentBlob || !objectURL) {
        throw new ScreenlyError("export_failed", "Screenly could not export the PNG.");
    }

    const filename = filenameForExport();

    if (browser.downloads && typeof browser.downloads.download === "function") {
        try {
            await browser.downloads.download({
                url: objectURL,
                filename,
                saveAs: true
            });
            return;
        } catch (error) {
            console.warn("Screenly browser download export failed; trying link fallback.", error);
        }
    }

    downloadWithAnchor(objectURL, filename);
}

async function copyPNGToClipboard() {
    if (!currentBlob) {
        throw new ScreenlyError("clipboard_failed", "Screenly could not copy the image to the clipboard.");
    }

    let clipboardSessionId = null;
    try {
        const begin = await sendNative("beginClipboardCopy", {
            byteLength: currentBlob.size
        });
        clipboardSessionId = begin.clipboardSessionId;

        for (let offset = 0; offset < currentBlob.size; offset += COPY_CHUNK_BYTES) {
            const chunk = currentBlob.slice(offset, offset + COPY_CHUNK_BYTES);
            const bytes = new Uint8Array(await chunk.arrayBuffer());
            await sendNative("appendClipboardChunk", {
                clipboardSessionId,
                chunk: bytesToBase64(bytes)
            });
        }

        await sendNative("finishClipboardCopy", { clipboardSessionId });
    } catch (error) {
        if (clipboardSessionId) {
            sendNative("deleteClipboardCopy", { clipboardSessionId }).catch(() => {});
        }
        throw error;
    }
}

async function withAction(button, action) {
    const buttons = [exportButton, copyButton];
    buttons.forEach((item) => { item.disabled = true; });
    setError("");

    try {
        await action();
    } catch (error) {
        const presentation = errorPresentation(error, { fallbackCode: "native_error" });
        setError(presentation);
        setStatus("");
        console.error("Screenly preview action failed", presentation);
    } finally {
        buttons.forEach((item) => { item.disabled = !currentBlob; });
        button.focus();
    }
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) {
        return "";
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function progressMessage(offset, totalBytes) {
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
        return "Loading preview...";
    }
    const percent = Math.min(99, Math.max(1, Math.round((offset / totalBytes) * 100)));
    return `Loading preview ${percent}%...`;
}

function filenameForExport() {
    const now = new Date();
    const stamp = [
        String(now.getDate()).padStart(2, "0"),
        String(now.getMonth() + 1).padStart(2, "0"),
        now.getFullYear()
    ].join("-") + " " + [
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0")
    ].join("-");

    const title = sanitizedFilenamePart(pageTitle);
    return title ? `Screenly - ${title} - ${stamp}.png` : `Screenly - ${stamp}.png`;
}

function sanitizedFilenamePart(value) {
    return value
        .normalize("NFKC")
        .replace(/[\\/:*?"<>|]/g, " ")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^\.+|\.+$/g, "")
        .slice(0, 120);
}

function downloadWithAnchor(url, filename) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
}

async function deleteNativeCapture(reason) {
    if (!captureId || nativeCaptureDeleted) {
        return;
    }

    try {
        await sendNative("deleteCapture", { captureId, reason });
        nativeCaptureDeleted = true;
    } catch (error) {
        console.warn("Screenly could not delete temporary capture yet.", error);
    }
}

function setStatus(message) {
    statusElement.textContent = message;
}

function setError(presentation) {
    if (!presentation) {
        errorTitleElement.textContent = "";
        errorDetailElement.textContent = "";
        errorElement.hidden = true;
        return;
    }

    errorTitleElement.textContent = presentation.title;
    errorDetailElement.textContent = presentation.detail;
    errorElement.hidden = false;
}
