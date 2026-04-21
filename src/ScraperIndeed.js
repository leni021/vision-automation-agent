import BaseScraper from "./BaseScraper.js";
import { humanLikeDelay } from "./StealthBrowser.js";
import { SUELDO_PRETENDIDO } from "./ContentEngine.js";
import VisionHelper, { VISION_MASTER_PROMPT } from "./VisionHelper.js";

const DEFAULT_QUERIES = ["Desarrollador Junior", "Programador Trainee", "Backend Node"];
const VISION_FALLBACK_TEXT = "Tengo experiencia práctica en Node.js, React y SQLite, desarrollando soluciones reales con foco en backend y automatización.";

export default class ScraperIndeed extends BaseScraper {
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
      portalName: "Indeed",
      readDelayMinMs,
      readDelayMaxMs,
      authStatePath,
      authStateLoaded
    });

    this.baseUrl = "https://ar.indeed.com";
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

  buildSearchUrl(query, location = "Argentina") {
    const params = new URLSearchParams({
      q: query,
      l: location
    });

    return `${this.baseUrl}/jobs?${params.toString()}`;
  }

  async login() {
    this.log("Indeed se ejecuta en modo publico. Login omitido.");
  }

  async searchOffers({ queries = DEFAULT_QUERIES, location = "Argentina", maxLinks = 30 } = {}) {
    const uniqueLinks = new Set();
    const linkRules = [
      /ar\.indeed\.com\/(?:viewjob|rc\/clk)/i,
      /indeed\.com\/(?:viewjob|rc\/clk)/i
    ];

    const paginationSelectors = [
      "a[data-testid='pagination-page-next']",
      "a[aria-label='Next Page']",
      "a[aria-label='Siguiente']",
      "a:has-text('Siguiente')"
    ];

    for (const query of queries) {
      if (uniqueLinks.size >= maxLinks) {
        break;
      }

      this.log(`Busqueda por query: ${query}`);
      const searchUrl = this.buildSearchUrl(query, location);
      await this.safeGoto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });

      let links = await this.collectLinksFromSearch({
        linkRules,
        maxLinks: maxLinks - uniqueLinks.size,
        paginationSelectors,
        maxPages: 3,
        titleKeywords: this.jobTitleKeywords
      });

      links = links.filter((url) => /indeed\.com\/(?:viewjob|rc\/clk)/i.test(url));

      for (const link of links) {
        if (uniqueLinks.size >= maxLinks) {
          break;
        }

        uniqueLinks.add(link);
      }

      await humanLikeDelay(900, 1900);
    }

    const jobs = [...uniqueLinks].slice(0, maxLinks).map((url) => ({
      portal: this.portalName,
      url
    }));

    this.log(`Total de vacantes detectadas: ${jobs.length}`);
    return jobs;
  }

  async applyToLoadedJob(message, shortAnswerFallback = "") {
    const currentTitle = await this.extractText(["h1", "[data-testid*='jobsearch-JobInfoHeader-title']", "[class*='title']"], 4000);
    if (!this.isRelevantJobTitle(currentTitle)) {
      this.log(`Vacante descartada por filtro estricto de titulo: ${currentTitle || "(sin titulo)"}`);
      return false;
    }

    return this.submitApplicationFlow(
      {
        applyButtonSelectors: [
          "button:has-text('Apply Now')",
          "button:has-text('Apply')",
          "a:has-text('Apply Now')",
          "a:has-text('Apply')",
          "button:has-text('Postular')",
          "a:has-text('Postular')",
          "button[data-testid*='apply']"
        ],
        messageSelectors: [
          "textarea[name*='message']",
          "textarea[name*='cover']",
          "textarea",
          "div[contenteditable='true']"
        ],
        submitSelectors: [
          "button:has-text('Submit')",
          "button:has-text('Continue')",
          "button:has-text('Enviar')",
          "button:has-text('Postular')",
          "input[type='submit']"
        ],
        successTextPatterns: [
          "application submitted",
          "you applied",
          "postulacion enviada",
          "has aplicado"
        ],
        sueldoPretendido: SUELDO_PRETENDIDO,
        salaryFieldKeywords: ["sueldo", "pretendido", "bruto"]
      },
      message,
      shortAnswerFallback
    );
  }
}