import fs from "node:fs";
import path from "node:path";

const MANUAL_LOGIN_HOME_URL = "**/candidate/home**";
const MANUAL_LOGIN_TIMEOUT_MS = 120000;

export default class SessionManager {
  constructor({
    page,
    log = () => {},
    authStatePath = null
  } = {}) {
    this.page = page;
    this.log = log;
    this.authStatePath = authStatePath;
  }

  isPageClosed(page = this.page) {
    if (!page) {
      return true;
    }

    if (typeof page.isClosed === "function") {
      return page.isClosed();
    }

    return false;
  }

  async waitForManualLoginAndPersistSession({
    page = this.page,
    authStatePath = this.authStatePath,
    expectedHomeUrl = MANUAL_LOGIN_HOME_URL,
    timeoutMs = MANUAL_LOGIN_TIMEOUT_MS
  } = {}) {
    if (!page || this.isPageClosed(page)) {
      return false;
    }

    const safeAuthPath = String(authStatePath ?? "").trim();
    if (!safeAuthPath) {
      throw new Error("No se definio la ruta de authState para guardar la sesion manual.");
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 25000 }).catch(() => {});

    console.log("[Intervención Humana] Por favor, inicia sesión manualmente en la ventana del navegador. El bot te esperará hasta 2 minutos...");

    await page.waitForURL(expectedHomeUrl, { timeout: timeoutMs });

    const context = page.context();
    const stateDir = path.dirname(safeAuthPath);
    if (stateDir && stateDir !== ".") {
      await fs.promises.mkdir(stateDir, { recursive: true }).catch(() => {});
    }

    await context.storageState({ path: safeAuthPath });

    console.log("[Sistema] Sesión manual capturada con éxito. Iniciando bucle de postulación automática.");
    this.log("Sesion manual persistida en disco.");

    return true;
  }
}
