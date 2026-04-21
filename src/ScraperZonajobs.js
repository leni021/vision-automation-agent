import BaseScraper from "./BaseScraper.js";
import { humanLikeDelay } from "./StealthBrowser.js";
import { SUELDO_PRETENDIDO } from "./ContentEngine.js";
import VisionHelper, { VISION_MASTER_PROMPT } from "./VisionHelper.js";

const DEFAULT_QUERIES = ["Desarrollador Junior", "Programador Trainee", "Backend Junior"];
const VISION_FALLBACK_TEXT = "Tengo experiencia práctica en Node.js, React y SQLite, desarrollando soluciones reales con foco en backend y automatización.";

const normalizeLocation = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

export default class ScraperZonajobs extends BaseScraper {
  constructor({
    page,
    credentials,
    readDelayMinMs,
    readDelayMaxMs,
    authStatePath,
    authStateLoaded
  }) {
    super({
      page,
      credentials,
      portalName: "Zonajobs",
      readDelayMinMs,
      readDelayMaxMs,
      authStatePath,
      authStateLoaded
    });

    this.baseUrl = "https://www.zonajobs.com.ar";
    this.visionHelper = new VisionHelper();
  }

  async getTextareaAnswer(containerSelector, shortAnswerFallback = "", questionContext = "") {
    const fallbackText = String(shortAnswerFallback ?? "").trim() || VISION_FALLBACK_TEXT;
    const compactQuestionContext = String(questionContext ?? "").replace(/\s+/g, " ").trim().slice(0, 380);
    const visionPrompt = compactQuestionContext
      ? `Responde solo esta pregunta del formulario: "${compactQuestionContext}".`
      : VISION_MASTER_PROMPT;

    try {
      const aiResponse = await this.visionHelper.analizarElemento(
        this.page,
        containerSelector,
        visionPrompt
      );

      if (aiResponse && typeof aiResponse === "object" && !Array.isArray(aiResponse)) {
        const accion = String(aiResponse.accion ?? "").trim().toLowerCase();
        const valor = String(aiResponse.valor ?? "").trim();

        if ((accion === "texto" || accion === "click") && valor) {
          return { accion, valor };
        }
      }

      const cleaned = String(aiResponse ?? "").trim();
      if (cleaned) {
        return cleaned;
      }

      return { accion: "texto", valor: fallbackText };
    } catch (error) {
      this.log(`VisionHelper fallo al responder pregunta. Fallback aplicado. Detalle: ${error.message}`);
      return { accion: "texto", valor: fallbackText };
    }
  }

  async hasActiveSession() {
    const opened = await this.safeGoto(`${this.baseUrl}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    if (!opened) {
      return false;
    }

    await this.page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    await humanLikeDelay(900, 2000);

    const hasLoginAccess = await this.page
      .locator("a[href*='/login'], a:has-text('Ingresar'), button:has-text('Ingresar')")
      .first()
      .isVisible()
      .catch(() => false);

    return !hasLoginAccess;
  }

  async findVisibleInput(selectors, timeout = 15000) {
    const start = Date.now();

    for (const selector of selectors) {
      const remaining = Math.max(800, timeout - (Date.now() - start));

      try {
        const locator = this.page.locator(selector).last();
        await locator.waitFor({ state: "visible", timeout: remaining });

        const isDisabled = await locator.evaluate((element) =>
          element.hasAttribute("disabled") ||
          element.getAttribute("aria-disabled") === "true" ||
          element.closest("[aria-hidden='true']") !== null
        );

        if (!isDisabled) {
          return locator;
        }
      } catch (error) {
        continue;
      }
    }

    return null;
  }

  async typeLikeHuman(locator, text) {
    await locator.focus();
    await this.page.keyboard.press("Control+A").catch(() => {});
    await this.page.keyboard.press("Backspace").catch(() => {});

    for (const char of String(text ?? "")) {
      await this.page.keyboard.type(char, {
        delay: 50 + Math.floor(Math.random() * 101)
      });

      if (Math.random() < 0.08) {
        await humanLikeDelay(80, 220);
      }
    }
  }

  async login() {
    if (this.authStateLoaded) {
      this.log("storageState detectado. Validando sesion vigente.");
      const sessionReady = await this.hasActiveSession();
      if (sessionReady) {
        this.log("Sesion reutilizada desde storageState. Login omitido.");
        return;
      }

      this.log("storageState expirado o invalido. Se ejecuta login completo.");
    }

    if (!this.credentials?.email || !this.credentials?.password) {
      throw new Error("Faltan credenciales de Zonajobs.");
    }

    const opened = await this.safeGoto(`${this.baseUrl}/login`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    if (!opened) {
      throw new Error("No se pudo abrir la pantalla de login de Zonajobs.");
    }

    const emailSelector = await this.fillFirst(
      [
        "input[type='email']",
        "input[name='email']",
        "input[name='username']",
        "#email"
      ],
      this.credentials.email
    );

    const passwordSelector = await this.fillFirst(
      ["input[type='password']", "input[name='password']", "#password"],
      this.credentials.password
    );

    if (!emailSelector || !passwordSelector) {
      throw new Error("No se pudieron completar campos de login de Zonajobs.");
    }

    const submitSelector = await this.clickFirst(
      [
        "button[type='submit']",
        "button:has-text('Ingresar')",
        "button:has-text('Iniciar sesion')",
        "input[type='submit']"
      ],
      10000
    );

    if (!submitSelector) {
      throw new Error("No se encontro boton de ingreso en Zonajobs.");
    }

    await this.page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    await humanLikeDelay(2000, 4500);

    const bodyText = String(await this.page.textContent("body").catch(() => "")).toLowerCase();
    if (bodyText.includes("datos incorrectos") || bodyText.includes("credenciales invalidas")) {
      throw new Error("Zonajobs rechazo las credenciales.");
    }

    await this.persistSessionState();

    this.log("Login ejecutado.");
  }

  async runUiSearch(query, location) {
    const opened = await this.safeGoto(`${this.baseUrl}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    if (!opened) {
      return false;
    }

    await this.page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    await humanLikeDelay(1000, 2400);

    const queryInput = await this.findVisibleInput(
      [
        "input[id^='react-select-'][aria-label='Buscar empleo por puesto o palabra clave']:not([disabled])",
        "input[aria-label='Buscar empleo por puesto o palabra clave']:not([disabled])",
        "input[aria-label*='puesto o palabra clave']:not([disabled])",
        "input[placeholder*='Puesto']:not([disabled])",
        "input[name='q']:not([disabled])"
      ],
      20000
    );

    if (!queryInput) {
      this.log("No se encontro el input principal de busqueda en Zonajobs.");
      return false;
    }

    await this.typeLikeHuman(queryInput, query);
    await humanLikeDelay(260, 820);

    const isNationalSearch = normalizeLocation(location).includes("argentina");

    if (!isNationalSearch) {
      const locationInput = await this.findVisibleInput(
        [
          "input[id^='react-select-'][aria-label='Lugar de trabajo']:not([disabled])",
          "input[id^='react-select-'][aria-label='Todo el pais']:not([disabled])",
          "input[id^='react-select-'][aria-label='Todo el país']:not([disabled])",
          "input[aria-label*='Lugar de trabajo']:not([disabled])",
          "input[aria-label*='Todo el pais']:not([disabled])",
          "input[aria-label*='Todo el país']:not([disabled])",
          "input[name='l']:not([disabled])"
        ],
        12000
      );

      if (locationInput) {
        await this.typeLikeHuman(locationInput, location);
        await humanLikeDelay(320, 900);
        await this.page.keyboard.press("Enter").catch(() => {});
        await humanLikeDelay(260, 800);
      }
    }

    const clicked = await this.clickFirst(
      [
        "button#buscarTrabajo",
        "button[aria-label='Buscar']",
        "button:has-text('Buscar trabajo')",
        "button:has-text('Buscar')",
        "button[type='submit']"
      ],
      8000
    );

    if (!clicked) {
      await this.page.keyboard.press("Enter").catch(() => {});
    }

    await this.page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    await humanLikeDelay(1800, 3200);
    return true;
  }

  async searchOffers({ queries = DEFAULT_QUERIES, location = "Argentina", maxLinks = 30 } = {}) {
    const uniqueOffers = new Map();
    const linkRules = [
      /zonajobs\.com\.ar\/empleos\/[a-z0-9-]+\.html(\?.*)?$/i,
      /\/empleos\/[a-z0-9-]+\.html(\?.*)?$/i
    ];

    const paginationSelectors = [
      "a[rel='next']",
      "a[aria-label='Siguiente']",
      "button[aria-label='Siguiente']",
      "a[href*='page=']",
      "a:has-text('Siguiente')",
      "button:has-text('Siguiente')"
    ];

    for (const query of queries) {
      if (uniqueOffers.size >= maxLinks) {
        break;
      }

      this.log(`Busqueda por query: ${query}`);
      const uiSearchOk = await this.runUiSearch(query, location);
      if (!uiSearchOk) {
        this.log("No se pudo ejecutar la busqueda por UI.");
        continue;
      }

      let links = await this.collectLinksFromSearch({
        linkRules,
        maxLinks: maxLinks - uniqueOffers.size,
        paginationSelectors,
        maxPages: 3,
        titleKeywords: this.jobTitleKeywords,
        returnObjects: true
      });

      links = links.filter((entry) => {
        const url = typeof entry === "string" ? entry : entry?.url;
        return /zonajobs\.com\.ar\/empleos\/[a-z0-9-]+\.html/i.test(String(url ?? "")) &&
          !/empleos-busqueda|empleos\.html(\?|$)|seniority|listado-empresas/i.test(String(url ?? ""));
      });

      for (const entry of links) {
        if (uniqueOffers.size >= maxLinks) {
          break;
        }

        const link = typeof entry === "string"
          ? { url: entry, puesto: "" }
          : entry;

        const safeUrl = String(link?.url ?? "").trim();
        if (!safeUrl) {
          continue;
        }

        if (!uniqueOffers.has(safeUrl)) {
          uniqueOffers.set(safeUrl, String(link?.puesto ?? "").trim());
        }
      }

      await humanLikeDelay(1000, 2200);
    }

    const jobs = [...uniqueOffers.entries()].slice(0, maxLinks).map(([url, puesto]) => ({
      portal: this.portalName,
      url,
      puesto
    }));

    this.log(`Total de vacantes detectadas: ${jobs.length}`);
    return jobs;
  }

  async applyToLoadedJob(message, shortAnswerFallback = "") {
    const currentTitle = await this.extractText(["h1", "[class*='job-title']", "[class*='title']"], 4000);
    if (!this.isRelevantJobTitle(currentTitle)) {
      this.log(`Vacante descartada por filtro estricto de titulo: ${currentTitle || "(sin titulo)"}`);
      return false;
    }

    return this.submitApplicationFlow(
      {
        applyButtonSelectors: [
          "button:has-text('Postulación rápida')",
          "button:has-text('Postulacion rapida')",
          "button:has-text('Postula')",
          "a:has-text('Postula')",
          "button[id*='postul']",
          "button[data-testid*='postul']",
          "button[data-testid*='apply']",
          "button:has-text('Postularme')",
          "a:has-text('Postularme')",
          "button:has-text('Aplicar')",
          "button:has-text('Enviar postulacion')"
        ],
        messageSelectors: [
          "textarea[name*='mensaje']",
          "textarea[name*='cover']",
          "textarea",
          "div[contenteditable='true']"
        ],
        submitSelectors: [
          "button:has-text('Enviar')",
          "button:has-text('Confirmar')",
          "button:has-text('Finalizar')",
          "button:has-text('Guardar y continuar')",
          "button:has-text('Postularme')",
          "input[type='submit']"
        ],
        successTextPatterns: [
          "postulacion enviada",
          "postulación enviada",
          "ya te postulaste",
          "exito",
          "éxito"
        ],
        sueldoPretendido: SUELDO_PRETENDIDO,
        salaryFieldKeywords: ["sueldo", "pretendido", "bruto", "remuneracion", "salario"],
        visualDecisionEnabled: true,
        maxVisualDecisionAttempts: 4,
        triggerVisualDecisionOnNoProgress: true,
        visualContinueButtonTexts: [
          "Guardar y continuar",
          "Finalizar",
          "Continuar",
          "Siguiente",
          "Enviar"
        ]
      },
      message,
      shortAnswerFallback
    );
  }
}