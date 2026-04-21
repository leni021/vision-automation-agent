import BaseScraper from "./BaseScraper.js";
import { humanLikeDelay } from "./StealthBrowser.js";
import { SUELDO_PRETENDIDO } from "./ContentEngine.js";
import VisionHelper, { VISION_MASTER_PROMPT } from "./VisionHelper.js";
import SessionManager from "./modules/SessionManager.js";

const DEFAULT_QUERIES = [
  "Programador",
  "Desarrollador",
  "Software Developer",
  "Developer Junior",
  "Analista Programador",
  "JavaScript",
  "Node"
];
const VISION_FALLBACK_TEXT = "Tengo experiencia práctica en Node.js, React y SQLite, desarrollando soluciones reales con foco en backend y automatización.";

const toSlug = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const normalizeLocation = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

export default class ScraperComputrabajo extends BaseScraper {
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
      portalName: "Computrabajo",
      readDelayMinMs,
      readDelayMaxMs,
      authStatePath,
      authStateLoaded
    });

    this.baseUrl = "https://ar.computrabajo.com";
    this.candidateAccessUrl = "https://candidato.ar.computrabajo.com/acceso/";
    this.candidateHomeUrl = "https://candidate.computrabajo.com/candidate/home";
    this.visionHelper = new VisionHelper();
    this.sessionManager = new SessionManager({
      page: this.page,
      log: (message) => this.log(message),
      visionReasoning: this.visionReasoning,
      authStatePath: this.authStatePath
    });
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
    const opened = await this.safeGoto(this.candidateHomeUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    if (!opened) {
      return false;
    }

    await this.page.waitForLoadState("domcontentloaded", { timeout: 25000 }).catch(() => {});
    await humanLikeDelay(900, 1900);

    const currentUrl = String(this.page.url() ?? "").toLowerCase();
    return currentUrl.includes("/candidate/home");
  }

  async waitForFirstSelector(selectors, timeout = 20000) {
    const start = Date.now();

    for (const selector of selectors) {
      const remaining = Math.max(1200, timeout - (Date.now() - start));

      try {
        await this.page.waitForSelector(selector, {
          state: "visible",
          timeout: remaining
        });
        return selector;
      } catch (error) {
        continue;
      }
    }

    return null;
  }

  buildSearchUrl(query, location) {
    const querySlug = toSlug(query);
    const locationSlug = toSlug(location);

    if (normalizeLocation(location).includes("argentina")) {
      return `${this.baseUrl}/trabajo-de-${querySlug}`;
    }

    return `${this.baseUrl}/trabajo-de-${querySlug}-en-${locationSlug}`;
  }

  async login() {
    if (this.authStateLoaded) {
      this.log("storageState detectado. Validando redireccion al home.");
      const sessionReady = await this.hasActiveSession();
      if (sessionReady) {
        this.log("Sesion reutilizada desde storageState. Login omitido.");
        return;
      }

      this.log("storageState expirado o invalido. Se requiere login manual.");
      this.authStateLoaded = false;
    }

    const opened = await this.safeGoto(this.candidateAccessUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    if (!opened) {
      throw new Error("No se pudo abrir la pantalla de acceso de Computrabajo.");
    }

    await this.page.waitForLoadState("domcontentloaded", { timeout: 25000 }).catch(() => {});
    await humanLikeDelay(1000, 2400);

    const loginFlowDone = await this.sessionManager.waitForManualLoginAndPersistSession({
      page: this.page,
      authStatePath: this.authStatePath
    });

    if (!loginFlowDone) {
      throw new Error("No se pudo completar el login manual de Computrabajo.");
    }

    this.authStateLoaded = true;
    await this.page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    await humanLikeDelay(2000, 4500);

    this.log("Login manual ejecutado.");
  }

  async runUiSearch(query, location) {
    const opened = await this.safeGoto(this.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    if (!opened) {
      return false;
    }

    const queryField = await this.fillFirst(
      [
        "input[name='q']",
        "input[placeholder*='puesto']",
        "input[placeholder*='trabajo']",
        "input[aria-label*='puesto']"
      ],
      query
    );

    if (!queryField) {
      return false;
    }

    const isNationalSearch = normalizeLocation(location).includes("argentina");

    if (!isNationalSearch) {
      await this.fillFirst(
        [
          "input[name='location']",
          "input[name='l']",
          "input[placeholder*='ubicacion']",
          "input[placeholder*='ciudad']"
        ],
        location
      ).catch(() => null);
    }

    const clicked = await this.clickFirst(
      ["button[type='submit']", "button:has-text('Buscar')", "button:has-text('Ver ofertas')"],
      9000
    );

    if (!clicked) {
      return false;
    }

    await this.page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    await humanLikeDelay(1400, 2600);
    return true;
  }

  async searchOffers({ queries = DEFAULT_QUERIES, location = "Argentina", maxLinks = 30 } = {}) {
    const searchPageReady = await this.safeGoto(this.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    if (searchPageReady) {
      await this.page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
      await humanLikeDelay(900, 1800);
    }

    const uniqueOffers = new Map();
    const linkRules = [
      /ar\.computrabajo\.com\/ofertas-de-trabajo\/oferta-de-trabajo-/i,
      /computrabajo\.com\/ofertas-de-trabajo/i
    ];

    const paginationSelectors = ["a[rel='next']", "a:has-text('Siguiente')", "button:has-text('Siguiente')"];

    for (const query of queries) {
      if (uniqueOffers.size >= maxLinks) {
        break;
      }

      this.log(`Busqueda por query: ${query}`);
      const searchUrl = this.buildSearchUrl(query, location);
      await this.safeGoto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      let links = await this.collectLinksFromSearch({
        linkRules,
        maxLinks: maxLinks - uniqueOffers.size,
        paginationSelectors,
        maxPages: 3,
        titleKeywords: this.jobTitleKeywords,
        returnObjects: true
      });

      if (links.length === 0) {
        this.log("Busqueda por URL sin resultados. Intento por formulario.");
        const uiSearchOk = await this.runUiSearch(query, location);
        if (uiSearchOk) {
          links = await this.collectLinksFromSearch({
            linkRules,
            maxLinks: maxLinks - uniqueOffers.size,
            paginationSelectors,
            maxPages: 3,
            titleKeywords: this.jobTitleKeywords,
            returnObjects: true
          });
        }
      }

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
          "button:has-text('Postularme')",
          "a:has-text('Postularme')",
          "button:has-text('Inscribirme')",
          "button:has-text('Aplicar')"
        ],
        messageSelectors: [
          "textarea[name*='mensaje']",
          "textarea[name*='carta']",
          "textarea",
          "div[contenteditable='true']"
        ],
        submitSelectors: [
          "button:has-text('Enviar')",
          "button:has-text('Finalizar')",
          "button:has-text('Enviar mi CV')",
          "button:has-text('Guardar y continuar')",
          "button:has-text('Confirmar')",
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
        maxVisualDecisionAttempts: 3,
        triggerVisualDecisionOnNoProgress: true,
        visualContinueButtonTexts: [
          "Finalizar",
          "Enviar mi CV",
          "Guardar y continuar",
          "Continuar",
          "Siguiente"
        ]
      },
      message,
      shortAnswerFallback
    );
  }
}