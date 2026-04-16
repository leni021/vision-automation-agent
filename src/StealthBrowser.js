import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const REAL_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.124 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.94 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0"
];

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 }
];

const randomInt = (min, max) => {
  const safeMin = Number.isFinite(min) ? Math.floor(min) : 0;
  const safeMax = Number.isFinite(max) ? Math.floor(max) : safeMin;

  if (safeMax <= safeMin) {
    return safeMin;
  }

  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
};

const pickRandom = (items) => items[randomInt(0, items.length - 1)];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function humanLikeDelay(min = 400, max = 1200) {
  const safeMin = Math.max(0, Number(min) || 0);
  const safeMax = Math.max(safeMin, Number(max) || safeMin);
  await sleep(randomInt(safeMin, safeMax));
}

export async function smoothType(page, selector, text) {
  const value = String(text ?? "");
  const target = page.locator(selector).first();

  await target.waitFor({ state: "visible", timeout: 15000 });
  await target.click({ delay: randomInt(40, 120) });

  for (const char of value) {
    await page.keyboard.type(char, { delay: randomInt(50, 150) });

    if (Math.random() < 0.08) {
      await humanLikeDelay(80, 260);
    }
  }
}

export default class StealthBrowser {
  constructor({ headless = false, slowMo = 0 } = {}) {
    this.headless = headless;
    this.slowMo = slowMo;
    this.browser = null;
    this.context = null;
    this.userAgent = null;
    this.storageStatePath = null;
    this.storageStateLoaded = false;
  }

  rotateUserAgent() {
    this.userAgent = pickRandom(REAL_USER_AGENTS);
    return this.userAgent;
  }

  async launch({ storageStatePath = null } = {}) {
    const selectedUserAgent = this.rotateUserAgent();
    const viewport = pickRandom(VIEWPORTS);
    this.storageStatePath = storageStatePath ? String(storageStatePath) : null;
    this.storageStateLoaded = Boolean(this.storageStatePath && fs.existsSync(this.storageStatePath));

    this.browser = await chromium.launch({
      headless: this.headless,
      slowMo: this.slowMo,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox"
      ]
    });

    const contextOptions = {
      userAgent: selectedUserAgent,
      viewport,
      locale: "es-AR",
      timezoneId: "America/Argentina/Buenos_Aires",
      geolocation: { longitude: -58.3816, latitude: -34.6037 },
      permissions: ["geolocation"],
      colorScheme: "light"
    };

    if (this.storageStateLoaded) {
      contextOptions.storageState = this.storageStatePath;
    }

    this.context = await this.browser.newContext(contextOptions);

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined
      });

      Object.defineProperty(navigator, "languages", {
        get: () => ["es-AR", "es", "en-US", "en"]
      });

      Object.defineProperty(navigator, "platform", {
        get: () => "Win32"
      });
    });

    return {
      browser: this.browser,
      context: this.context,
      userAgent: selectedUserAgent,
      storageStatePath: this.storageStatePath,
      storageStateLoaded: this.storageStateLoaded
    };
  }

  async saveStorageState(storageStatePath = this.storageStatePath) {
    if (!this.context || !storageStatePath) {
      return false;
    }

    try {
      const stateDir = path.dirname(storageStatePath);
      if (stateDir && stateDir !== ".") {
        fs.mkdirSync(stateDir, { recursive: true });
      }

      await this.context.storageState({ path: storageStatePath });
      this.storageStatePath = storageStatePath;
      this.storageStateLoaded = true;
      return true;
    } catch {
      return false;
    }
  }

  async newPage() {
    if (!this.context) {
      throw new Error("El contexto del navegador no esta inicializado. Ejecuta launch() primero.");
    }

    const page = await this.context.newPage();
    page.setDefaultTimeout(30000);

    await page.mouse.move(randomInt(120, 540), randomInt(80, 360), {
      steps: randomInt(10, 30)
    });

    return page;
  }

  async humanMouseSweep(page) {
    const viewport = page.viewportSize() ?? { width: 1366, height: 768 };
    const maxX = Math.max(120, viewport.width - 60);
    const maxY = Math.max(120, viewport.height - 60);

    let currentX = randomInt(60, maxX);
    let currentY = randomInt(60, maxY);

    const sweeps = randomInt(2, 5);
    for (let index = 0; index < sweeps; index += 1) {
      const nextX = randomInt(60, maxX);
      const nextY = randomInt(60, maxY);

      await page.mouse.move(currentX, currentY, { steps: randomInt(6, 16) });
      await page.mouse.move(nextX, nextY, { steps: randomInt(12, 24) });
      await humanLikeDelay(120, 380);

      currentX = nextX;
      currentY = nextY;
    }
  }

  async humanReadScroll(page) {
    const scrollCycles = randomInt(2, 4);

    for (let index = 0; index < scrollCycles; index += 1) {
      await page.mouse.wheel(0, randomInt(240, 680));
      await humanLikeDelay(260, 900);

      if (Math.random() > 0.72) {
        await page.mouse.wheel(0, randomInt(-260, -120));
        await humanLikeDelay(200, 560);
      }
    }
  }

  async close() {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}