import fs from "node:fs";
import path from "node:path";
import { VISION_MASTER_PROMPT, decidirAccionVisual } from "./modules/VisionReasoning.js";

export { VISION_MASTER_PROMPT };

export default class VisionHelper {
  constructor({
    tempDir = path.resolve(process.cwd(), "temp")
  } = {}) {
    this.tempDir = tempDir;
  }

  async analizarElemento(page, selector, prompt = VISION_MASTER_PROMPT) {
    if (!page) {
      throw new Error("VisionHelper requiere una instancia valida de page.");
    }

    const safePrompt = String(prompt ?? VISION_MASTER_PROMPT).trim();
    if (!safePrompt) {
      throw new Error("El prompt no puede estar vacio.");
    }

    const screenshotName = `vision-${Date.now()}-${Math.floor(Math.random() * 100000)}.png`;
    const screenshotPath = path.join(this.tempDir, screenshotName);

    await fs.promises.mkdir(this.tempDir, { recursive: true });

    const safeSelector = selector ? String(selector).trim() : "";

    try {
      if (safeSelector) {
        const target = page.locator(safeSelector).first();
        await target.waitFor({ state: "visible", timeout: 15000 });
        await page.waitForTimeout(3000);
        await target.screenshot({ type: "png", path: screenshotPath });
      } else {
        await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(3000);
        await page.screenshot({ type: "png", fullPage: false, path: screenshotPath });
      }

      const imageBuffer = await fs.promises.readFile(screenshotPath);
      const base64Image = imageBuffer.toString("base64");

      const responseData = await decidirAccionVisual(base64Image, safePrompt);

      if (responseData && typeof responseData === "object" && !Array.isArray(responseData)) {
        return responseData;
      }

      return String(responseData ?? "").trim();
    } finally {
      await fs.promises.unlink(screenshotPath).catch(() => {});
    }
  }
}