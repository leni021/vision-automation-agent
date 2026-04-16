const DEFAULT_SALARY_KEYWORDS = ["remuneración", "remuneracion", "bruta", "pretendida", "expectativa salarial", "sueldo"];
const DEFAULT_IT_BLACKLIST_TERMS = [
  "Soporte tecnico",
  "Soporte tecnico IT",
  "Redes",
  "Ventas",
  "Negocios",
  "Comercial",
  "Business",
  "Ejecutivo",
  "Sales",
  "Marketing",
  "Ecommerce",
  "Vendedor",
  "CNC",
  "Torno",
  "Laser",
  "Punzonadora",
  "Maquinado",
  "Inyeccion",
  "Operario"
];
const AI_HALLUCINATION_KEYWORDS = ["imagen", "captura", "pantalla", "formulario", "muestra", "anuncio", "asistencia"];
const AI_SANITIZED_FALLBACK_TEXT = "Tengo bases solidas en desarrollo y logica de programacion. Me adapto rapido a nuevas tecnologias; pueden ver el detalle tecnico en mi CV adjunto.";
const VISION_ACTION_TEXT = "texto";
const VISION_ACTION_CLICK = "click";

const fallbackNormalize = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const defaultRandomInt = (min, max) => {
  const safeMin = Math.floor(Number(min) || 0);
  const safeMax = Math.floor(Number(max) || safeMin);

  if (safeMax <= safeMin) {
    return safeMin;
  }

  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
};

export default class FormManager {
  constructor({
    page,
    normalizeForMatch = fallbackNormalize,
    delayFn = null,
    randomIntFn = defaultRandomInt,
    salaryKeywords = DEFAULT_SALARY_KEYWORDS,
    blacklistTerms = DEFAULT_IT_BLACKLIST_TERMS
  } = {}) {
    this.page = page;
    this.normalizeForMatch = normalizeForMatch;
    this.delayFn = delayFn;
    this.randomInt = randomIntFn;
    this.defaultSalaryKeywords = [...new Set((salaryKeywords ?? DEFAULT_SALARY_KEYWORDS)
      .map((keyword) => this.normalizeForMatch(keyword))
      .filter(Boolean))];
    this.blacklistTerms = [...new Set((blacklistTerms ?? DEFAULT_IT_BLACKLIST_TERMS)
      .map((term) => this.normalizeForMatch(term))
      .filter(Boolean))];
  }

  async delay(min = 100, max = 260) {
    if (typeof this.delayFn === "function") {
      await this.delayFn(min, max);
    }
  }

  normalize(value) {
    return this.normalizeForMatch(value);
  }

  getNormalizedKeywords(keywords = this.defaultSalaryKeywords) {
    return [...new Set([...(keywords ?? []), ...this.defaultSalaryKeywords]
      .map((keyword) => this.normalize(keyword))
      .filter(Boolean))];
  }

  getSalaryValueFromEnv(fallbackValue = "600000") {
    const envSalary = String(process.env.SUELDO_PRETENDIDO ?? "").replace(/\D/g, "").trim();
    if (envSalary) {
      return envSalary;
    }

    const fallbackNumeric = String(fallbackValue ?? "").replace(/\D/g, "").trim();
    if (fallbackNumeric) {
      return fallbackNumeric;
    }

    return "600000";
  }

  isSalaryContext(text, keywords = this.defaultSalaryKeywords) {
    const normalizedText = this.normalize(text);
    if (!normalizedText) {
      return false;
    }

    const normalizedKeywords = this.getNormalizedKeywords(keywords);
    return normalizedKeywords.some((keyword) => normalizedText.includes(keyword));
  }

  sanitizeAiTextareaAnswer(answerText) {
    const cleaned = String(answerText ?? "").trim();
    if (!cleaned) {
      return "";
    }

    if (cleaned.length > 400) {
      return AI_SANITIZED_FALLBACK_TEXT;
    }

    const normalized = this.normalize(cleaned);
    const hasHallucinationSignals = AI_HALLUCINATION_KEYWORDS.some((keyword) =>
      normalized.includes(this.normalize(keyword))
    );

    if (hasHallucinationSignals) {
      return AI_SANITIZED_FALLBACK_TEXT;
    }

    return cleaned;
  }

  parseVisionActionResult(rawResult, fallbackText = "") {
    const normalizeResult = (candidate) => {
      if (Array.isArray(candidate)) {
        candidate = candidate[0];
      }

      if (!candidate || typeof candidate !== "object") {
        return null;
      }

      const accion = this.normalize(candidate.accion);
      const valor = String(candidate.valor ?? "").trim();

      if ((accion === VISION_ACTION_TEXT || accion === VISION_ACTION_CLICK) && valor) {
        return { accion, valor };
      }

      return null;
    };

    const objectResult = normalizeResult(rawResult);
    if (objectResult) {
      return objectResult;
    }

    let rawText = String(rawResult ?? "").trim();
    if (!rawText) {
      return { accion: VISION_ACTION_TEXT, valor: String(fallbackText ?? "").trim() };
    }

    if (rawText.startsWith("```")) {
      rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
    }

    try {
      let parsed = JSON.parse(rawText);

      if (Array.isArray(parsed)) {
        parsed = parsed[0];
      }

      const parsedResult = normalizeResult(parsed);
      if (parsedResult) {
        return parsedResult;
      }
    } catch (error) {
      // no-op
    }

    return { accion: VISION_ACTION_TEXT, valor: rawText };
  }

  async clickOptionByExactText(optionText) {
    const safeText = String(optionText ?? "").trim();
    if (!safeText) {
      return false;
    }

    const escapedText = safeText
      .replace(/\\/g, "\\\\")
      .replace(/"/g, "\\\"");

    try {
      const optionLocator = this.page
        .locator(`label:has-text("${escapedText}"), span:text-is("${escapedText}"), div:text-is("${escapedText}")`)
        .first();

      await optionLocator.click({ force: true }).catch(async () => {
        await this.page.locator(`text="${escapedText}"`).first().click({ force: true });
      });

      await this.page.waitForTimeout(1000);
      return true;
    } catch (error) {
      return false;
    }
  }

  async fillAndCommit(locator, value, timeout = 0) {
    const safeValue = String(value ?? "");

    if (timeout > 0) {
      await locator.fill(safeValue, { timeout, force: true });
    } else {
      await locator.fill(safeValue, { force: true });
    }

    await locator.press("Tab").catch(() => {});
    await this.page.waitForTimeout(500).catch(() => {});
  }

  async getTextareaContextText(textareaLocator) {
    return textareaLocator.evaluate((textarea) => {
      const pickText = (node) => String(node?.textContent || "").replace(/\s+/g, " ").trim();

      let labelsByFor = [];
      if (textarea.id) {
        labelsByFor = Array.from(document.querySelectorAll("label")).filter(
          (label) => label.getAttribute("for") === textarea.id
        );
      }

      const parentLabel = textarea.closest("label");
      const container = textarea.closest(".form-group, .field, .question, li, section, article, div") || textarea;
      const nearbyLabel = container ? container.querySelector("label") : null;

      return [
        textarea.getAttribute("placeholder") || "",
        textarea.getAttribute("name") || "",
        textarea.getAttribute("id") || "",
        textarea.getAttribute("aria-label") || "",
        pickText(parentLabel),
        pickText(nearbyLabel),
        ...labelsByFor.map((label) => pickText(label)).filter(Boolean),
        pickText(container)
      ].join(" ");
    }).catch(() => "");
  }

  getBlacklistedTermForTitle(title) {
    const normalizedTitle = this.normalize(title);
    if (!normalizedTitle) {
      return "";
    }

    return this.blacklistTerms.find((term) => normalizedTitle.includes(term)) || "";
  }

  isBlacklistedJobTitle(title) {
    return Boolean(this.getBlacklistedTermForTitle(title));
  }

  async markQuestionContainer(textareaLocator, index) {
    const marker = `vision-question-${Date.now()}-${index}-${Math.floor(Math.random() * 100000)}`;

    await textareaLocator.evaluate((textarea, markerValue) => {
      const container =
        textarea.closest(
          "[data-testid*='pregunta'], [data-testid*='question'], [class*='pregunta'], [class*='question'], .form-group, .question, label, li, section, article, div"
        ) || textarea;

      container.setAttribute("data-vision-question-id", markerValue);
    }, marker);

    return `[data-vision-question-id='${marker}']`;
  }

  async unmarkQuestionContainer(containerSelector) {
    await this.page
      .locator(containerSelector)
      .first()
      .evaluate((element) => {
        element.removeAttribute("data-vision-question-id");
      })
      .catch(() => {});
  }

  async fillVisibleTextareas(value, getTextareaAnswer, timeout = 2500) {
    const fallbackText = String(value ?? "").trim();
    if (!fallbackText) {
      return 0;
    }

    await this.page.waitForSelector("textarea", {
      state: "visible",
      timeout
    }).catch(() => null);

    const textareas = this.page.locator("textarea");
    const count = await textareas.count().catch(() => 0);
    let filledCount = 0;

    for (let index = 0; index < count; index += 1) {
      const fieldNumber = index + 1;
      console.log(`[FormManager] Procesando campo ${fieldNumber}/${count}...`);

      const field = textareas.nth(index);
      const isVisible = await field.isVisible().catch(() => false);
      if (!isVisible) {
        console.log(`[FormManager] Campo ${fieldNumber} no visible. Saltando...`);
        continue;
      }

      let containerSelector = `textarea:visible >> nth=${index}`;
      let usedMarker = false;

      try {
        console.log("[FormManager] Preparando marcador de contenedor...");
        containerSelector = await this.markQuestionContainer(field, index);
        usedMarker = true;
        console.log("[FormManager] Marcador de contenedor listo.");
      } catch (error) {
        usedMarker = false;
        console.log(`[FormManager] No se pudo marcar contenedor: ${error.message}`);
      }

      let answerText = fallbackText;

      console.log("[FormManager] Extrayendo contexto y tomando captura...");
      const textareaContextText = await this.getTextareaContextText(field);
      console.log("[FormManager] Contexto extraido.");
      const isSalaryTextarea = this.isSalaryContext(textareaContextText);

      if (isSalaryTextarea) {
        console.log("[FormManager] Campo salarial detectado. Se omite IA y se inyecta valor numerico.");
        answerText = this.getSalaryValueFromEnv();
      }

      if (!isSalaryTextarea && typeof getTextareaAnswer === "function") {
        try {
          console.log("[FormManager] Enviando captura a GPT-4o...");
          const generated = await getTextareaAnswer(containerSelector, fallbackText);
          const aiResult = this.parseVisionActionResult(generated, fallbackText);
          console.log("[FormManager] Respuesta recibida de IA:", aiResult);

          if (aiResult.accion === VISION_ACTION_CLICK) {
            console.log("[FormManager] IA solicito accion click. Intentando click forzado...");
            const clickedOption = await this.clickOptionByExactText(aiResult.valor);
            console.log(`[FormManager] Resultado de click forzado: ${clickedOption ? "OK" : "FALLO"}`);

            if (clickedOption) {
              if (usedMarker) {
                console.log("[FormManager] Removiendo marcador de contenedor...");
                await this.unmarkQuestionContainer(containerSelector);
                usedMarker = false;
                console.log("[FormManager] Marcador removido.");
              }

              filledCount += 1;
              console.log(`[FormManager] Campo ${fieldNumber} completado.`);
              continue;
            }

            answerText = this.sanitizeAiTextareaAnswer(aiResult.valor || fallbackText);
          } else {
            answerText = this.sanitizeAiTextareaAnswer(aiResult.valor || fallbackText);
          }
        } catch (error) {
          console.log(`[FormManager] Error al consultar IA en campo ${fieldNumber}: ${error.message}`);
          answerText = fallbackText;
        }
      }

      try {
        console.log("[FormManager] Tipeando texto en el campo...");
        await field.click({ delay: this.randomInt(35, 110) });
        await this.fillAndCommit(field, answerText);
        await this.delay(100, 260);
        filledCount += 1;
        console.log(`[FormManager] Campo ${fieldNumber} completado.`);
      } catch (error) {
        console.log(`[FormManager] Error al completar campo ${fieldNumber}: ${error.message}`);
      } finally {
        if (usedMarker) {
          console.log("[FormManager] Limpiando marcador de contenedor...");
          await this.unmarkQuestionContainer(containerSelector);
          console.log("[FormManager] Marcador limpiado.");
        }
      }
    }

    return filledCount;
  }

  async fillSalaryExpectedFields(salaryValue, keywords = this.defaultSalaryKeywords) {
    const numericSalary = this.getSalaryValueFromEnv(salaryValue);
    if (!numericSalary) {
      return 0;
    }

    const normalizedKeywords = this.getNormalizedKeywords(keywords);
    if (normalizedKeywords.length === 0) {
      return 0;
    }

    const inputs = this.page.locator("input:not([type='hidden']):not([type='checkbox']):not([type='radio'])");
    const count = await inputs.count().catch(() => 0);
    let filledCount = 0;

    for (let index = 0; index < count; index += 1) {
      const field = inputs.nth(index);
      const isVisible = await field.isVisible().catch(() => false);
      if (!isVisible) {
        continue;
      }

      const metadata = await field.evaluate((element) => {
        const pickText = (node) => String(node?.textContent || "").replace(/\s+/g, " ").trim();

        let labelsByFor = [];
        if (element.id) {
          labelsByFor = Array.from(document.querySelectorAll("label")).filter(
            (label) => label.getAttribute("for") === element.id
          );
        }

        const parentLabel = element.closest("label");
        const nearbyContainer = element.closest(".form-group, .field, .question, li, section, article, div");
        const nearbyLabel = nearbyContainer ? nearbyContainer.querySelector("label") : null;

        return {
          placeholder: element.getAttribute("placeholder") || "",
          name: element.getAttribute("name") || "",
          id: element.id || "",
          ariaLabel: element.getAttribute("aria-label") || "",
          title: element.getAttribute("title") || "",
          labels: labelsByFor.map((label) => pickText(label)).filter(Boolean),
          parentLabel: pickText(parentLabel),
          nearbyLabel: pickText(nearbyLabel)
        };
      }).catch(() => null);

      if (!metadata) {
        continue;
      }

      const candidateText = this.normalize([
        metadata.placeholder,
        metadata.name,
        metadata.id,
        metadata.ariaLabel,
        metadata.title,
        metadata.parentLabel,
        metadata.nearbyLabel,
        ...(metadata.labels || [])
      ].join(" "));

      const matchesSalaryField = normalizedKeywords.some((keyword) => candidateText.includes(keyword));
      if (!matchesSalaryField) {
        continue;
      }

      try {
        await field.fill(numericSalary);
        await this.delay(90, 240);
        filledCount += 1;
      } catch (error) {
        continue;
      }
    }

    return filledCount;
  }

  async fillByObjective(targetText, rawValue, keywords = this.defaultSalaryKeywords, timeout = 7000) {
    const objectiveText = String(targetText ?? "").trim();
    const textValue = String(rawValue ?? "").trim();

    if (!textValue) {
      return false;
    }

    const normalizedObjective = this.normalize(objectiveText);
    const objectiveTokens = normalizedObjective.split(" ").filter((token) => token.length >= 3);
    const normalizedKeywords = this.getNormalizedKeywords(keywords);
    const looksLikeSalary = normalizedKeywords.some((keyword) => normalizedObjective.includes(keyword));

    if (looksLikeSalary) {
      const salaryFromEnv = this.getSalaryValueFromEnv(textValue);
      const filledSalary = await this.fillSalaryExpectedFields(salaryFromEnv, normalizedKeywords);
      if (filledSalary > 0) {
        return true;
      }
    }

    const tryFillLocator = async (locator) => {
      await locator.waitFor({ state: "visible", timeout });
      await locator.click({ delay: this.randomInt(35, 110) }).catch(() => {});
      await this.fillAndCommit(locator, textValue, timeout);
      await this.delay(100, 240);
      return true;
    };

    if (objectiveText) {
      try {
        const locatorByLabel = this.page.getByLabel(objectiveText, { exact: false }).first();
        if (await tryFillLocator(locatorByLabel)) {
          return true;
        }
      } catch (error) {
        // no-op
      }

      try {
        const locatorByPlaceholder = this.page.getByPlaceholder(objectiveText, { exact: false }).first();
        if (await tryFillLocator(locatorByPlaceholder)) {
          return true;
        }
      } catch (error) {
        // no-op
      }
    }

    const fields = this.page.locator("textarea, input:not([type='hidden']):not([type='checkbox']):not([type='radio'])");
    const count = await fields.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const field = fields.nth(index);
      const isVisible = await field.isVisible().catch(() => false);
      if (!isVisible) {
        continue;
      }

      const metadata = await field.evaluate((element) => {
        const pickText = (node) => String(node?.textContent || "").replace(/\s+/g, " ").trim();
        const parentLabel = element.closest("label");
        const nearbyContainer = element.closest(".form-group, .field, .question, li, section, article, div");
        const nearbyLabel = nearbyContainer ? nearbyContainer.querySelector("label") : null;

        return {
          name: element.getAttribute("name") || "",
          id: element.id || "",
          placeholder: element.getAttribute("placeholder") || "",
          ariaLabel: element.getAttribute("aria-label") || "",
          title: element.getAttribute("title") || "",
          parentLabel: pickText(parentLabel),
          nearbyLabel: pickText(nearbyLabel)
        };
      }).catch(() => null);

      const candidateText = this.normalize([
        metadata?.name,
        metadata?.id,
        metadata?.placeholder,
        metadata?.ariaLabel,
        metadata?.title,
        metadata?.parentLabel,
        metadata?.nearbyLabel
      ].join(" "));

      const matchesObjective = !normalizedObjective ||
        candidateText.includes(normalizedObjective) ||
        objectiveTokens.some((token) => candidateText.includes(token));

      if (!matchesObjective) {
        continue;
      }

      try {
        await field.click({ delay: this.randomInt(35, 110) }).catch(() => {});
        await this.fillAndCommit(field, textValue);
        await this.delay(100, 240);
        return true;
      } catch (error) {
        continue;
      }
    }

    return false;
  }
}
