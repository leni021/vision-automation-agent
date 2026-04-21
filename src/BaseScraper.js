import fs from "node:fs";
import path from "node:path";
import { smoothType } from "./StealthBrowser.js";
import FormManager from "./modules/FormManager.js";
import NavigationHelper from "./modules/NavigationHelper.js";
import VisionReasoning, { VISUAL_DECISION_PROMPT } from "./modules/VisionReasoning.js";
import ApplicationWorkflow from "./modules/ApplicationWorkflow.js";

const DEFAULT_DESCRIPTION_SELECTORS = ["section[class*='description']", "div[class*='description']", "article", "main", "body"];
const DEFAULT_TITLE_SELECTORS = ["h1", "[class*='job-title']", "[data-testid*='job-title']", "[class*='title']"];
const DEFAULT_COMPANY_SELECTORS = ["[class*='company']", "[data-testid*='company']", "a[href*='empresa']", "h2"];
const DEFAULT_JOB_TITLE_KEYWORDS = ["node", "javascript", "developer", "desarrollador", "programador", "trainee", "junior", "backend", "fullstack"];
const DEFAULT_BLOCKED_JOB_TITLE_KEYWORDS = [
  "soporte",
  "redes",
  "ventas",
  "negocios",
  "comercial",
  "business",
  "ejecutivo",
  "sales",
  "marketing",
  "ecommerce",
  "vendedor",
  "cnc",
  "torno",
  "laser",
  "punzonadora",
  "maquinado",
  "inyeccion",
  "operario",
  "movil",
  "mobile",
  "android",
  "ios",
  "react native",
  "flutter",
  "xamarin",
  "ionic",
  "swift",
  "kotlin"
];

const DEFAULT_SALARY_KEYWORDS = ["sueldo", "pretendido", "bruto"];

const DEFAULT_SUCCESS_TEXT_PATTERNS = ["postulacion enviada", "ya te postulaste", "exito"];

const LOGIN_BARRIER_VISION_PROMPT = "Analiza esta pantalla de postulacion. ¿El boton principal visible dice 'Login', 'Ingresar' o 'Crear CV' en lugar de 'Postularme'? Responde estrictamente con SI o NO.";

const normalizeForMatch = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const randomInt = (min, max) => {
  const safeMin = Math.floor(Number(min) || 0);
  const safeMax = Math.floor(Number(max) || safeMin);

  if (safeMax <= safeMin) {
    return safeMin;
  }

  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
};

const escapeSelectorText = (value) => String(value ?? "").replace(/"/g, "\\\"").trim();

export default class BaseScraper {
  constructor({
    page,
    credentials,
    portalName,
    readDelayMinMs = 10000,
    readDelayMaxMs = 20000,
    authStatePath = null,
    authStateLoaded = false,
    jobTitleKeywords = DEFAULT_JOB_TITLE_KEYWORDS
  }) {
    if (new.target === BaseScraper) {
      throw new Error("BaseScraper es abstracta y debe extenderse.");
    }

    this.page = page;
    this.credentials = credentials;
    this.portalName = portalName;
    this.readDelayMinMs = Math.max(0, Number(readDelayMinMs) || 10000);
    this.readDelayMaxMs = Math.max(this.readDelayMinMs, Number(readDelayMaxMs) || this.readDelayMinMs);
    this.authStatePath = authStatePath ? String(authStatePath) : null;
    this.authStateLoaded = Boolean(authStateLoaded);
    this.jobTitleKeywords = [...new Set((jobTitleKeywords ?? DEFAULT_JOB_TITLE_KEYWORDS)
      .map((keyword) => normalizeForMatch(keyword))
      .filter(Boolean))];

    this.navigationHelper = new NavigationHelper({
      page: this.page,
      normalizeForMatch
    });

    this.formManager = new FormManager({
      page: this.page,
      normalizeForMatch,
      delayFn: (min, max) => this.navigationHelper.delay(min, max),
      randomIntFn: randomInt,
      salaryKeywords: DEFAULT_SALARY_KEYWORDS
    });

    this.visionReasoning = new VisionReasoning({
      page: this.page,
      normalizeForMatch,
      log: (message) => this.log(message),
      tempDir: path.resolve(process.cwd(), "temp")
    });

    this.applicationWorkflow = new ApplicationWorkflow({
      page: this.page,
      log: (message) => this.log(message),
      clickFirst: (...args) => this.clickFirst(...args),
      fillFirst: (...args) => this.fillFirst(...args),
      fillVisibleTextareas: (...args) => this.fillVisibleTextareas(...args),
      fillSalaryExpectedFields: (...args) => this.fillSalaryExpectedFields(...args),
      detectSuccessfulApplication: (...args) => this.detectSuccessfulApplication(...args),
      decideVisualAction: (...args) => this.decidirAccionVisual(...args),
      clickByTextObjective: (...args) => this.clickByTextObjective(...args),
      checkLoginBarrier: (...args) => this.detectLoginBarrierByVision(...args),
      onRequireLogin: async () => {
        if (typeof this.login === "function") {
          await this.login();
          return true;
        }

        return false;
      },
      delay: (...args) => this.navigationHelper.delay(...args),
      cleanupTemp: () => this.visionReasoning.cleanupTempFiles()
    });
  }

  log(message) {
    console.log(`[${this.portalName}] ${message}`);
  }

  isRelevantJobTitle(title) {
    const normalizedTitle = normalizeForMatch(title);
    if (!normalizedTitle) {
      return false;
    }

    if (this.isBlacklistedJobTitle(normalizedTitle)) {
      return false;
    }

    return this.jobTitleKeywords.some((keyword) => normalizedTitle.includes(keyword));
  }

  getBlacklistedTermForTitle(title) {
    const normalizedTitle = normalizeForMatch(title);
    if (!normalizedTitle) {
      return "";
    }

    const formManagerTerm =
      this.formManager && typeof this.formManager.getBlacklistedTermForTitle === "function"
        ? this.formManager.getBlacklistedTermForTitle(normalizedTitle)
        : "";

    if (formManagerTerm) {
      return formManagerTerm;
    }

    return DEFAULT_BLOCKED_JOB_TITLE_KEYWORDS.find((keyword) => normalizedTitle.includes(keyword)) || "";
  }

  isBlacklistedJobTitle(title) {
    return Boolean(this.getBlacklistedTermForTitle(title));
  }

  async persistSessionState() {
    if (!this.authStatePath) {
      return false;
    }

    try {
      const stateDir = path.dirname(this.authStatePath);
      if (stateDir && stateDir !== ".") {
        fs.mkdirSync(stateDir, { recursive: true });
      }

      await this.page.context().storageState({ path: this.authStatePath });
      this.authStateLoaded = true;
      this.log(`Sesion persistida en ${this.authStatePath}`);
      return true;
    } catch (error) {
      this.log(`No se pudo persistir storageState: ${error.message}`);
      return false;
    }
  }

  async safeGoto(url, options = {}) {
    try {
      await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
        ...options
      });
      return true;
    } catch (error) {
      this.log(`No se pudo abrir URL: ${url}. Detalle: ${error.message}`);
      return false;
    }
  }

  async clickFirst(selectors, timeout = 7000) {
    for (const selector of selectors) {
      try {
        const locator = this.page.locator(selector).first();
        await locator.waitFor({ state: "visible", timeout });
        await locator.click({ delay: randomInt(35, 140) });
        await this.navigationHelper.delay(120, 420);
        return selector;
      } catch (error) {
        continue;
      }
    }

    return null;
  }

  async fillFirst(selectors, value, options = {}) {
    const {
      timeout = 7000,
      clearBefore = true,
      useSmoothType = true
    } = options;

    const textValue = String(value ?? "");

    for (const selector of selectors) {
      try {
        const locator = this.page.locator(selector).first();
        await locator.waitFor({ state: "visible", timeout });
        await locator.click({ delay: randomInt(35, 140) });

        if (clearBefore) {
          await this.page.keyboard.press("Control+A").catch(() => {});
          await this.page.keyboard.press("Backspace").catch(() => {});
        }

        if (useSmoothType) {
          await smoothType(this.page, selector, textValue);
        } else {
          await locator.fill(textValue, { timeout });
        }

        await this.navigationHelper.delay(120, 420);
        return selector;
      } catch (error) {
        continue;
      }
    }

    return null;
  }

  async extractText(selectors, timeout = 3000) {
    for (const selector of selectors) {
      try {
        const rawText = await this.page.locator(selector).first().textContent({ timeout });
        const text = String(rawText ?? "").replace(/\s+/g, " ").trim();

        if (text) {
          return text;
        }
      } catch (error) {
        continue;
      }
    }

    return "";
  }

  async extractJobLinks(linkRules, maxLinks = 30, options = {}) {
    const titleKeywords = options.titleKeywords ?? this.jobTitleKeywords;
    return this.navigationHelper.extractJobLinks(linkRules, maxLinks, { titleKeywords });
  }

  async collectLinksFromSearch(options = {}) {
    const {
      linkRules,
      maxLinks = 30,
      paginationSelectors = [],
      maxPages = 3,
      titleKeywords = this.jobTitleKeywords,
      returnObjects = false
    } = options;

    return this.navigationHelper.collectLinksFromSearch({
      linkRules,
      maxLinks,
      paginationSelectors,
      maxPages,
      titleKeywords,
      returnObjects,
      clickFirst: (selectors, timeout) => this.clickFirst(selectors, timeout)
    });
  }

  async humanReadingPattern() {
    await this.navigationHelper.humanReadingPattern();
  }

  async openJobAndRead(jobUrl) {
    const opened = await this.safeGoto(jobUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    if (!opened) {
      return null;
    }

    await this.navigationHelper.delay(this.readDelayMinMs, this.readDelayMaxMs);
    await this.humanReadingPattern();

    return {
      url: jobUrl,
      description: await this.extractText(DEFAULT_DESCRIPTION_SELECTORS, 5000),
      puesto: await this.extractText(DEFAULT_TITLE_SELECTORS, 4000),
      empresa: await this.extractText(DEFAULT_COMPANY_SELECTORS, 4000)
    };
  }

  async getTextareaAnswer(containerSelector, shortAnswerFallback = "", questionContext = "") {
    return String(shortAnswerFallback ?? "").trim();
  }

  async fillVisibleTextareas(value, timeout = 2500) {
    return this.formManager.fillVisibleTextareas(
      value,
      this.getTextareaAnswer.bind(this),
      timeout
    );
  }

  async fillSalaryExpectedFields(salaryValue, keywords = DEFAULT_SALARY_KEYWORDS) {
    return this.formManager.fillSalaryExpectedFields(salaryValue, keywords);
  }

  async fillByObjective(targetText, rawValue, keywords = DEFAULT_SALARY_KEYWORDS, timeout = 7000) {
    return this.formManager.fillByObjective(targetText, rawValue, keywords, timeout);
  }

  async clickByTextObjective(targetText, timeout = 7000) {
    const text = String(targetText ?? "").trim();
    if (!text) {
      return false;
    }

    try {
      const locator = this.page.getByText(text, { exact: false }).first();
      await locator.waitFor({ state: "visible", timeout });
      await locator.click({ delay: randomInt(35, 140) });
      await this.navigationHelper.delay(120, 420);
      return true;
    } catch (error) {
      // no-op
    }

    const escapedText = escapeSelectorText(text);
    const selectorClicked = await this.clickFirst(
      [
        `button:has-text("${escapedText}")`,
        `a:has-text("${escapedText}")`,
        `label:has-text("${escapedText}")`
      ],
      timeout
    );

    return Boolean(selectorClicked);
  }

  async toggleCheckboxByObjective(targetText, timeout = 7000) {
    const text = String(targetText ?? "").trim();
    if (!text) {
      return false;
    }

    try {
      const checkbox = this.page.getByLabel(text, { exact: false }).first();
      await checkbox.waitFor({ state: "visible", timeout });

      const inputType = await checkbox.getAttribute("type").catch(() => "");
      if (String(inputType ?? "").toLowerCase() === "checkbox") {
        await checkbox.check({ timeout }).catch(async () => {
          await checkbox.click({ delay: randomInt(35, 120) });
        });
        await this.navigationHelper.delay(120, 320);
        return true;
      }
    } catch (error) {
      // no-op
    }

    const escapedText = escapeSelectorText(text);

    try {
      const label = this.page.locator(`label:has-text("${escapedText}")`).first();
      await label.waitFor({ state: "visible", timeout });
      await label.click({ delay: randomInt(35, 120) });
      await this.navigationHelper.delay(120, 320);
      return true;
    } catch (error) {
      // no-op
    }

    return false;
  }

  async detectSuccessfulApplication(successTextPatterns = []) {
    return this.navigationHelper.hasSuccessMessage([
      ...DEFAULT_SUCCESS_TEXT_PATTERNS,
      ...(successTextPatterns ?? [])
    ]);
  }

  parseVisionYesNo(rawAnswer) {
    const normalized = normalizeForMatch(rawAnswer);

    if (!normalized) {
      return null;
    }

    if (normalized.startsWith("si")) {
      return true;
    }

    if (normalized.startsWith("no")) {
      return false;
    }

    if (normalized.includes(" si") || normalized.includes("sí")) {
      return true;
    }

    if (normalized.includes(" no")) {
      return false;
    }

    return null;
  }

  async detectLoginBarrierByVision(prompt = LOGIN_BARRIER_VISION_PROMPT) {
    const rawAnswer = await this.visionReasoning.askPrompt(prompt, {
      fullPage: false
    }).catch(() => "");

    return this.parseVisionYesNo(rawAnswer) === true;
  }

  async ejecutarDecisionVisual(decision, {
    shortAnswerFallback = "",
    sueldoPretendido = "600000",
    salaryFieldKeywords = DEFAULT_SALARY_KEYWORDS,
    actionDelayMs = 2000
  } = {}) {
    const fallbackText = String(shortAnswerFallback ?? "").trim();
    const fallbackSalary = String(sueldoPretendido ?? "600000").replace(/\D/g, "") || "600000";

    if (!decision) {
      await this.navigationHelper.delay(actionDelayMs, actionDelayMs);
      return { accion: "esperar", objetivo: "", valor: "", executed: false };
    }

    if (decision.accion === "esperar") {
      await this.navigationHelper.delay(actionDelayMs, actionDelayMs);
      return { ...decision, executed: true };
    }

    if (decision.accion === "click") {
      let clicked = await this.clickByTextObjective(decision.objetivo, 7000);
      if (!clicked) {
        clicked = await this.toggleCheckboxByObjective(decision.objetivo, 7000);
      }

      await this.navigationHelper.delay(actionDelayMs, actionDelayMs);
      return { ...decision, executed: clicked };
    }

    const objectiveText = normalizeForMatch(decision.objetivo);
    const isSalaryObjective = (salaryFieldKeywords ?? []).some((keyword) =>
      objectiveText.includes(normalizeForMatch(keyword))
    );

    let valueToWrite = String(decision.valor ?? "").trim();
    if (isSalaryObjective && !valueToWrite) {
      valueToWrite = fallbackSalary;
    }

    if (!valueToWrite) {
      valueToWrite = fallbackText || fallbackSalary;
    }

    const wrote = await this.fillByObjective(decision.objetivo, valueToWrite, salaryFieldKeywords, 7000);
    await this.navigationHelper.delay(actionDelayMs, actionDelayMs);

    return {
      ...decision,
      valor: valueToWrite,
      executed: wrote
    };
  }

  async decidirAccionVisual({
    prompt = VISUAL_DECISION_PROMPT,
    shortAnswerFallback = "",
    sueldoPretendido = "600000",
    salaryFieldKeywords = DEFAULT_SALARY_KEYWORDS,
    actionDelayMs = 2000
  } = {}) {
    const decision = await this.visionReasoning.decidirAccionVisual(prompt);
    return this.ejecutarDecisionVisual(decision, {
      shortAnswerFallback,
      sueldoPretendido,
      salaryFieldKeywords,
      actionDelayMs
    });
  }

  async submitApplicationFlow(config, message, shortAnswerFallback = "") {
    return this.applicationWorkflow.submitApplicationFlow(config, message, shortAnswerFallback);
  }

  async waitForVisionIdle() {
    if (!this.visionReasoning || typeof this.visionReasoning.waitForIdle !== "function") {
      return;
    }

    await this.visionReasoning.waitForIdle();
  }

  isApplicationSessionLimitReached() {
    if (!this.applicationWorkflow || typeof this.applicationWorkflow.isSessionLimitReached !== "function") {
      return false;
    }

    return this.applicationWorkflow.isSessionLimitReached();
  }

  getApplicationSessionCount() {
    if (!this.applicationWorkflow || typeof this.applicationWorkflow.getSessionSuccessfulApplications !== "function") {
      return 0;
    }

    return this.applicationWorkflow.getSessionSuccessfulApplications();
  }

  consumeFastExitOnPostApplyFlag() {
    if (!this.applicationWorkflow || typeof this.applicationWorkflow.consumeFastExitOnPostApplyFlag !== "function") {
      return false;
    }

    return this.applicationWorkflow.consumeFastExitOnPostApplyFlag();
  }
}
