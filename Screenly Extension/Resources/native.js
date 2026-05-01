import { normalizeError, ScreenlyError } from "./errors.js";

const NATIVE_APP_IDENTIFIER = "gr-ch.Screenly";

export async function sendNative(command, payload = {}) {
    let response;

    try {
        response = await browser.runtime.sendNativeMessage(NATIVE_APP_IDENTIFIER, {
            command,
            ...payload
        });
    } catch (error) {
        throw new ScreenlyError("native_error", "Screenly could not contact its native helper.", String(error?.message || error));
    }

    if (!response || response.ok !== true) {
        throw normalizeError(response?.error || new Error("Native command failed."), response?.error?.code || "native_error");
    }

    return response;
}
