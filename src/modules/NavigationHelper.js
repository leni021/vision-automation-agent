import { humanLikeDelay } from "../StealthBrowser.js";

const DEFAULT_SUCCESS_PATTERNS = [
  "postulacion enviada",
  "postulacion realizada",
  "ya te postulaste",
  "te has postulado",
  "exito"
];

const DEFAULT_ERROR_PATTERNS = [
  "error",
  "obligatorio",
  "invalido",
  "rechazado",
  "intentalo nuevamente"
];

const QR_HINT_SELECTORS = [
  "[class*='qr']",
  "[id*='qr']",
  "img[src*='qr']",
  "canvas[aria-label*='QR']",
  "div:has-text('codigo QR')",
  "div:has-text('Código QR')",
  "div:has-text('Escanea')"
];

const MODAL_CLOSE_SELECTORS = [
  "button[aria-label='Cerrar']",
  "button[title='Cerrar']",
  "button:has-text('Cerrar')",
  "button:has-text('No, gracias')",
  "button:has-text('Entendido')",
  "button:has-text('Saltar')",
  "[data-testid*='close']",
  "[class*='modal'] [class*='close']",
  "[class*='popup'] [class*='close']"
];

const fallbackNormalize = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export default class NavigationHelper {
  constructor({
    page,
    normalizeForMatch = fallbackNormalize
  } = {}) {
    this.page = page;
    this.normalizeForMatch = normalizeForMatch;
  }

  normalize(value) {
    return this.normalizeForMatch(value);
  }

  static async humanLikeDelay(min = 120, max = 420) {
    await humanLikeDelay(min, max);
  }

  static async closeIntrusiveModals(page) {
    if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
      return false;
    }

    let hasQrSignals = false;
    for (const selector of QR_HINT_SELECTORS) {
      const visible = await page.locator(selector).first().isVisible().catch(() => false);
      if (visible) {
        hasQrSignals = true;
        break;
      }
    }

    let closedSomething = false;

    for (const selector of MODAL_CLOSE_SELECTORS) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);

      if (!visible) {
        continue;
      }

      const enabled = await locator.isEnabled().catch(() => true);
      if (!enabled) {
        continue;
      }

      await locator.click({ timeout: 2000 }).then(() => {
        closedSomething = true;
      }).catch(() => {});

      await page.waitForTimeout(180).catch(() => {});
    }

    if (!closedSomething && hasQrSignals) {
      await page.keyboard.press("Escape").then(() => {
        closedSomething = true;
      }).catch(() => {});
      await page.waitForTimeout(180).catch(() => {});
    }

    return closedSomething;
  }

  async delay(min = 120, max = 420) {
    await NavigationHelper.humanLikeDelay(min, max);
  }

  async humanReadingPattern() {
    const viewport = this.page.viewportSize() ?? { width: 1366, height: 768 };
    const maxX = Math.max(120, viewport.width - 60);
    const maxY = Math.max(120, viewport.height - 60);

    const sweeps = 2 + Math.floor(Math.random() * 3);
    for (let index = 0; index < sweeps; index += 1) {
      await this.page.mouse.move(
        60 + Math.floor(Math.random() * Math.max(1, maxX - 59)),
        60 + Math.floor(Math.random() * Math.max(1, maxY - 59)),
        { steps: 8 + Math.floor(Math.random() * 13) }
      );
      await this.delay(120, 360);
    }

    const scrollSteps = 2 + Math.floor(Math.random() * 3);
    for (let index = 0; index < scrollSteps; index += 1) {
      await this.page.mouse.wheel(0, 250 + Math.floor(Math.random() * 451));
      await this.delay(180, 620);
    }
  }

  getNormalizedPatterns(extraPatterns = [], defaultPatterns = []) {
    return [...new Set([
      ...defaultPatterns,
      ...(extraPatterns ?? [])
    ]
      .map((pattern) => this.normalize(pattern))
      .filter(Boolean))];
  }

  async getBodyTextNormalized() {
    const rawBodyText = await this.page.textContent("body").catch(() => "");
    return this.normalize(rawBodyText);
  }

  async extractJobLinks(linkRules, maxLinks = 30, { titleKeywords = [], returnObjects = false } = {}) {
    const safeMaxLinks = Math.max(1, Number(maxLinks) || 30);
    const matchers = (linkRules ?? []).map((rule) => (rule instanceof RegExp ? rule : new RegExp(rule, "i")));
    const normalizedKeywords = [...new Set((titleKeywords ?? [])
      .map((keyword) => this.normalize(keyword))
      .filter(Boolean))];
    const shouldFilterByTitle = normalizedKeywords.length > 0;

    const anchors = await this.page.$$eval("a[href]", (rawAnchors) =>
      rawAnchors
        .map((anchor) => ({
          href: anchor.href,
          text: (anchor.textContent || "").replace(/\s+/g, " ").trim(),
          titleAttr: (anchor.getAttribute("title") || "").trim(),
          ariaLabel: (anchor.getAttribute("aria-label") || "").trim(),
          dataTitle: (anchor.getAttribute("data-title") || "").trim()
        }))
        .filter((anchor) => typeof anchor.href === "string" && anchor.href.length > 0)
    );

    const links = new Map();
    for (const anchor of anchors) {
      if (!matchers.some((matcher) => matcher.test(anchor.href))) {
        continue;
      }

      const rawTitle = `${anchor.text} ${anchor.titleAttr} ${anchor.ariaLabel} ${anchor.dataTitle}`
        .replace(/\s+/g, " ")
        .trim();

      if (shouldFilterByTitle) {
        const candidateTitle = this.normalize(rawTitle);

        if (!candidateTitle || !normalizedKeywords.some((keyword) => candidateTitle.includes(keyword))) {
          continue;
        }
      }

      const cleanUrl = anchor.href.split("#")[0];
      if (!links.has(cleanUrl)) {
        links.set(cleanUrl, rawTitle);
      }

      if (links.size >= safeMaxLinks) {
        break;
      }
    }

    if (returnObjects) {
      return [...links.entries()].map(([url, puesto]) => ({ url, puesto }));
    }

    return [...links.keys()];
  }

  async collectLinksFromSearch({
    linkRules,
    maxLinks = 30,
    paginationSelectors = [],
    maxPages = 3,
    titleKeywords = [],
    returnObjects = false,
    clickFirst
  } = {}) {
    const safeMaxPages = Math.max(1, Number(maxPages) || 1);
    const collected = returnObjects ? new Map() : new Set();
    let pageCounter = 1;
    let staleCycles = 0;

    while (pageCounter <= safeMaxPages && collected.size < maxLinks) {
      const beforeCount = collected.size;
      const remaining = Math.max(1, Number(maxLinks) - collected.size);
      const links = await this.extractJobLinks(linkRules, remaining, {
        titleKeywords,
        returnObjects
      });

      for (const link of links) {
        if (collected.size >= maxLinks) {
          break;
        }

        if (returnObjects) {
          const safeUrl = String(link?.url ?? "").trim();
          if (!safeUrl) {
            continue;
          }

          if (!collected.has(safeUrl)) {
            collected.set(safeUrl, String(link?.puesto ?? "").trim());
          }
        } else {
          collected.add(link);
        }
      }

      staleCycles = collected.size === beforeCount ? staleCycles + 1 : 0;

      if (collected.size >= maxLinks || pageCounter >= safeMaxPages || staleCycles >= 2) {
        break;
      }

      if ((paginationSelectors ?? []).length === 0 || typeof clickFirst !== "function") {
        break;
      }

      const nextSelector = await clickFirst(paginationSelectors, 6000);
      if (!nextSelector) {
        break;
      }

      await this.page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
      await this.delay(1000, 2500);
      pageCounter += 1;
    }

    if (returnObjects) {
      return [...collected.entries()].map(([url, puesto]) => ({ url, puesto }));
    }

    return [...collected];
  }

  async detectStatusMessage({
    successPatterns = [],
    errorPatterns = []
  } = {}) {
    const bodyText = await this.getBodyTextNormalized();
    const normalizedSuccessPatterns = this.getNormalizedPatterns(successPatterns, DEFAULT_SUCCESS_PATTERNS);
    const normalizedErrorPatterns = this.getNormalizedPatterns(errorPatterns, DEFAULT_ERROR_PATTERNS);

    const matchedSuccess = normalizedSuccessPatterns.find((pattern) => bodyText.includes(pattern)) || "";
    const matchedError = normalizedErrorPatterns.find((pattern) => bodyText.includes(pattern)) || "";

    return {
      isSuccess: Boolean(matchedSuccess),
      isError: Boolean(matchedError),
      matchedSuccess,
      matchedError,
      bodyText
    };
  }

  async hasSuccessMessage(successPatterns = []) {
    const status = await this.detectStatusMessage({ successPatterns });
    return status.isSuccess;
  }
}
