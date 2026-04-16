import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

const VALID_ACTIONS = new Set(["escribir", "click", "esperar"]);
const GITHUB_MODELS_BASE_URL = "https://models.inference.ai.azure.com";
const GITHUB_MODELS_DEFAULT_MODEL = "gpt-4o";
const GITHUB_MODELS_DEFAULT_USER_PROMPT = "Analiza esta pregunta del formulario y proporciona una respuesta técnica y persuasiva acorde a mi perfil.";
const GITHUB_MODELS_VISION_COMPAT_SYSTEM_PROMPT = "Sigue estrictamente la instruccion del usuario usando el contenido visual de la imagen. Responde solo en el formato solicitado y sin texto extra.";
const GITHUB_PROFILE_API_URL = "https://api.github.com/user/repos?sort=updated&per_page=5";
const GITHUB_PROFILE_FALLBACK_TEXT = "Proyectos principales: BarberOS (Software de gestión con SQLite) y Kiosco Luzuriaga (Sistema de pedidos web con integración directa a la API de WhatsApp de Meta).";
const OPENAI_REQUEST_TIMEOUT_MS = 15000;
const SAFE_JSON_TEXT_FALLBACK = Object.freeze({
  accion: "texto",
  valor: "Me adapto rápido a nuevas tecnologías. Detalle en CV adjunto."
});

let githubProfileContextCache = null;
let githubProfileContextPromise = null;

const toCleanText = (value) => String(value ?? "").trim();

const isTimeoutRequestError = (error) => {
  const message = String(error?.message ?? "").toLowerCase();
  const code = String(error?.code ?? "").toLowerCase();
  const name = String(error?.name ?? "").toLowerCase();

  return (
    message.includes("timeout") ||
    code.includes("timeout") ||
    code === "etimedout" ||
    name.includes("timeout") ||
    name === "aborterror"
  );
};

const inferTechStackFromRepo = (repo) => {
  const techSet = new Set();
  const language = toCleanText(repo?.language);
  const combinedContext = `${toCleanText(repo?.name)} ${toCleanText(repo?.description)}`.toLowerCase();

  if (language) {
    techSet.add(language);

    if (/^(javascript|typescript)$/i.test(language)) {
      techSet.add("Node.js");
    }
  }

  if (combinedContext.includes("react")) {
    techSet.add("React");
  }

  if (combinedContext.includes("sqlite")) {
    techSet.add("SQLite");
  }

  if (combinedContext.includes("node")) {
    techSet.add("Node.js");
  }

  if (combinedContext.includes("n8n")) {
    techSet.add("n8n");
  }

  return [...techSet];
};

const summarizeRepo = (repo) => {
  const repoName = toCleanText(repo?.name);
  if (!repoName) {
    return "";
  }

  const techList = inferTechStackFromRepo(repo);
  const description = toCleanText(repo?.description) || "Sin descripcion publica.";
  const techLabel = techList.length > 0 ? techList.join(", ") : "Stack no especificado";

  return `${repoName} [${techLabel}]: ${description}`;
};

const ensureMandatoryProjects = (context) => {
  const normalizedContext = String(context ?? "");
  const hasBarberOs = /barberos?/i.test(normalizedContext);
  const hasKiosco = /kiosco/i.test(normalizedContext);

  if (hasBarberOs && hasKiosco) {
    return normalizedContext;
  }

  const missingProjects = [];

  if (!hasBarberOs) {
    missingProjects.push("BarberOS (Software de gestión con SQLite)");
  }

  if (!hasKiosco) {
    missingProjects.push("Kiosco Luzuriaga (Sistema de pedidos web con integración directa a la API de WhatsApp de Meta)");
  }

  if (missingProjects.length === 0) {
    return normalizedContext;
  }

  return `${normalizedContext} Proyectos clave: ${missingProjects.join(" y ")}.`;
};

export async function fetchGitHubProfile() {
  if (githubProfileContextCache) {
    return githubProfileContextCache;
  }

  if (!githubProfileContextPromise) {
    githubProfileContextPromise = (async () => {
      const token = toCleanText(process.env.GITHUB_TOKEN);

      if (!token) {
        githubProfileContextCache = GITHUB_PROFILE_FALLBACK_TEXT;
        return githubProfileContextCache;
      }

      try {
        const response = await fetch(GITHUB_PROFILE_API_URL, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "bot-para-buscar-chamba"
          }
        });

        if (!response.ok) {
          throw new Error(`GitHub API status ${response.status}`);
        }

        const repos = await response.json();
        const condensedRepos = Array.isArray(repos)
          ? repos.slice(0, 5).map(summarizeRepo).filter(Boolean)
          : [];

        if (condensedRepos.length === 0) {
          githubProfileContextCache = GITHUB_PROFILE_FALLBACK_TEXT;
          return githubProfileContextCache;
        }

        githubProfileContextCache = ensureMandatoryProjects(`Repos recientes: ${condensedRepos.join(" | ")}.`);
        return githubProfileContextCache;
      } catch (error) {
        console.warn("[VisionWarning] No se pudo extraer perfil de GitHub:", error.message);
        githubProfileContextCache = GITHUB_PROFILE_FALLBACK_TEXT;
        return githubProfileContextCache;
      }
    })();
  }

  return githubProfileContextPromise;
}

if (process.env.GITHUB_TOKEN) {
  void fetchGitHubProfile();
}

const client = new OpenAI({
  baseURL: GITHUB_MODELS_BASE_URL,
  apiKey: process.env.GITHUB_TOKEN
});

export async function decidirAccionVisual(base64Image, preguntaContexto) {
  try {
    if (!process.env.GITHUB_TOKEN) {
      throw new Error("Falta GITHUB_TOKEN para usar GitHub Models API.");
    }

    const safeBase64Image = String(base64Image ?? "").trim();
    const safeQuestionContext = String(preguntaContexto ?? "").trim() || GITHUB_MODELS_DEFAULT_USER_PROMPT;
    const githubContextString = await fetchGitHubProfile();
    const systemPrompt = `Eres Lenning Hidalgo, Desarrollador Fullstack.
  Stack: Node.js, React, SQLite, Meta API.
  Proyectos: ${githubContextString}

  REGLAS CRÍTICAS DE RESPUESTA:
  1. DEBES responder ÚNICAMENTE con un objeto JSON válido, sin formato Markdown ni bloques de código (\`\`\`).
  Se te pasara UNA sola pregunta en el texto de la consulta. Ignora las demas preguntas que veas en la imagen. Devuelve UN UNICO OBJETO JSON, jamas un array [].
  2. Analiza la imagen. Si la pregunta requiere seleccionar una opción existente (botones de radio, checkboxes como "Sí", "No", "Básico", "Avanzado"):
    - Evalúa tu nivel como Junior/Trainee (ej: para SQL elige "Básico" o "Intermedio", para experiencia en Banca elige "No").
    - Responde: {"accion": "click", "valor": "Texto exacto de la opción a clickear"}
  3. Si la pregunta es de texto abierto:
    - Responde: {"accion": "texto", "valor": "Tu respuesta técnica breve (máx 200 caracteres)"}
  4. Tu nivel de inglés es Técnico (lectura fluida), conversacional básico.
  5. NO describas la imagen.`;

    if (!safeBase64Image) {
      throw new Error("No se recibió la imagen en base64 para la consulta visual.");
    }

    let response;

    try {
      response = await client.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Pregunta del formulario: "${safeQuestionContext}". Decide accion segun la imagen y responde solo JSON.`
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${safeBase64Image}`
                }
              }
            ]
          }
        ],
        max_tokens: 150,
        temperature: 0.1
      }, {
        timeout: OPENAI_REQUEST_TIMEOUT_MS
      });
    } catch (error) {
      if (isTimeoutRequestError(error)) {
        console.error("[VisionError] La API tardó demasiado (Timeout). Usando respuesta de emergencia.");
        return { accion: "texto", valor: "Me adapto rápido a nuevas tecnologías. Detalle en CV adjunto." };
      }

      throw error;
    }

    let rawText = String(response?.choices?.[0]?.message?.content ?? "").trim();

    if (rawText.startsWith("```")) {
      rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
    }

    let parsedJSON;

    try {
      parsedJSON = JSON.parse(rawText);

      if (Array.isArray(parsedJSON)) {
        parsedJSON = parsedJSON[0];
      }

      if (!parsedJSON || typeof parsedJSON !== "object") {
        throw new Error("JSON invalido: no es un objeto.");
      }

      if (!parsedJSON.accion) {
        parsedJSON = {
          accion: "texto",
          valor: parsedJSON.valor || SAFE_JSON_TEXT_FALLBACK.valor
        };
      }

      const accion = String(parsedJSON.accion ?? "").trim().toLowerCase();
      const valor = String(parsedJSON.valor ?? "").trim() || SAFE_JSON_TEXT_FALLBACK.valor;

      if (accion !== "texto" && accion !== "click") {
        return {
          accion: "texto",
          valor
        };
      }

      return {
        accion,
        valor
      };
    } catch (error) {
      console.error("[VisionError] No se pudo parsear el JSON:", rawText);
      return { ...SAFE_JSON_TEXT_FALLBACK };
    }
  } catch (error) {
    console.error("[VisionError] Error al consultar GPT-4o:", error.message);
    return { ...SAFE_JSON_TEXT_FALLBACK };
  }
}

export const VISION_MASTER_PROMPT = `Eres Lenning Hidalgo, un desarrollador Fullstack enfocado en Node.js, React y SQLite. Estas completando un formulario de empleo. Lee la pregunta que aparece en la imagen y responde.
REGLAS ABSOLUTAS:

NO describas la imagen.

PROHIBIDO usar frases como 'La imagen muestra', 'captura de pantalla', 'el anuncio', 'la pregunta es'.

Responde directamente en primera persona.

Si preguntan por tecnologias que no manejas (como Java o Spring Boot), responde enfocandote en tu capacidad de adaptacion rapida y tu solida base logica obtenida desarrollando sistemas como BarberOS.

Maximo 2 oraciones.`;

export const VISUAL_DECISION_PROMPT = `Eres el cerebro de un bot de empleo para Lenning (Dev Node.js/BarberOS).
Tu objetivo es avanzar la postulacion.
Identifica visualmente cualquier impedimento (botones grises, preguntas sin responder, pop-ups).
Tienes permiso para decidir la siguiente accion automatizable.
Responde estrictamente con un objeto JSON: { "accion": "string", "objetivo": "texto_del_elemento", "valor": "string_opcional" }.
Acciones permitidas para "accion": "click", "escribir" o "esperar".`;

const fallbackNormalize = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const tryParseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
};

const extractLikelyJsonObject = (value) => {
  const text = String(value ?? "");
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return "";
  }

  return text.slice(firstBrace, lastBrace + 1);
};

export default class VisionReasoning {
  constructor({
    page,
    log = () => {},
    normalizeForMatch = fallbackNormalize,
    endpoint = GITHUB_MODELS_BASE_URL,
    model = GITHUB_MODELS_DEFAULT_MODEL,
    timeoutMs = 120000,
    tempDir = path.resolve(process.cwd(), "temp")
  } = {}) {
    this.page = page;
    this.log = log;
    this.normalizeForMatch = normalizeForMatch;
    this.endpoint = endpoint;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.tempDir = tempDir;
    this.pendingRequests = new Set();
  }

  normalize(value) {
    return this.normalizeForMatch(value);
  }

  buildScreenshotPath() {
    const screenshotName = `vision-${Date.now()}-${Math.floor(Math.random() * 100000)}.png`;
    return path.join(this.tempDir, screenshotName);
  }

  async captureViewportScreenshot({ clip = null, fullPage = false } = {}) {
    if (!this.page || (typeof this.page.isClosed === "function" && this.page.isClosed())) {
      this.log("[VisionCheck] Captura omitida: la pagina ya esta cerrada.");
      return null;
    }

    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const screenshotPath = this.buildScreenshotPath();

    await this.page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});

    if (!this.page || (typeof this.page.isClosed === "function" && this.page.isClosed())) {
      this.log("[VisionCheck] Captura cancelada: la pagina se cerro antes de screenshot.");
      return null;
    }

    const screenshotOptions = {
      type: "png",
      fullPage,
      path: screenshotPath
    };

    if (clip) {
      screenshotOptions.clip = clip;
      screenshotOptions.fullPage = false;
    }

    await this.page.screenshot(screenshotOptions);

    return screenshotPath;
  }

  async sendImageAndGetResponse(imagePath, prompt) {
    if (!process.env.GITHUB_TOKEN) {
      throw new Error("Falta GITHUB_TOKEN para usar GitHub Models API.");
    }

    const imageBuffer = await fs.promises.readFile(imagePath);
    const base64Image = imageBuffer.toString("base64");
    const safePrompt = String(prompt ?? "").trim() || GITHUB_MODELS_DEFAULT_USER_PROMPT;

    const response = await client.chat.completions.create({
      model: this.model || GITHUB_MODELS_DEFAULT_MODEL,
      messages: [
        {
          role: "system",
          content: GITHUB_MODELS_VISION_COMPAT_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: safePrompt
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ]
        }
      ],
      max_tokens: 150,
      temperature: 0.2
    }, {
      timeout: OPENAI_REQUEST_TIMEOUT_MS
    });

    return String(response?.choices?.[0]?.message?.content ?? "").trim();
  }

  validateDecision(candidate) {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }

    const accion = this.normalize(candidate.accion);
    if (!VALID_ACTIONS.has(accion)) {
      return null;
    }

    const objetivo = String(candidate.objetivo ?? "").trim();
    const valor = String(candidate.valor ?? "").trim();

    if ((accion === "click" || accion === "escribir") && !objetivo) {
      return null;
    }

    return {
      accion,
      objetivo,
      valor
    };
  }

  parseDecision(rawResponse) {
    const cleanedResponse = String(rawResponse ?? "")
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    if (!cleanedResponse) {
      return null;
    }

    const parseCandidate = (candidateText) => {
      const direct = tryParseJson(candidateText);
      if (direct) {
        return this.validateDecision(direct);
      }

      const normalizedCandidate = String(candidateText)
        .replace(/([{,]\s*)'([^']+?)'\s*:/g, "$1\"$2\":")
        .replace(/:\s*'([^']*)'/g, ": \"$1\"");

      const normalized = tryParseJson(normalizedCandidate);
      return this.validateDecision(normalized);
    };

    const jsonSlice = extractLikelyJsonObject(cleanedResponse);
    let parsed = jsonSlice ? parseCandidate(jsonSlice) : null;

    if (!parsed) {
      parsed = parseCandidate(cleanedResponse);
    }

    if (parsed) {
      return parsed;
    }

    return parsed;
  }

  trackPendingRequest(promise) {
    const wrapped = Promise.resolve(promise);
    this.pendingRequests.add(wrapped);

    const dropPending = () => {
      this.pendingRequests.delete(wrapped);
    };

    wrapped.then(dropPending).catch(dropPending);
    return wrapped;
  }

  async askPrompt(prompt = VISUAL_DECISION_PROMPT, { clip = null, fullPage = false } = {}) {
    const operation = (async () => {
      const safePrompt = String(prompt ?? VISUAL_DECISION_PROMPT).trim() || VISUAL_DECISION_PROMPT;
      const screenshotPath = await this.captureViewportScreenshot({ clip, fullPage });

      if (!screenshotPath) {
        return "";
      }

      try {
        return await this.sendImageAndGetResponse(screenshotPath, safePrompt);
      } finally {
        await fs.promises.unlink(screenshotPath).catch(() => {});
      }
    })();

    return this.trackPendingRequest(operation);
  }

  async requestDecision(prompt = VISUAL_DECISION_PROMPT) {
    const rawResponse = await this.askPrompt(prompt, { fullPage: false });
    const decision = this.parseDecision(rawResponse);

    if (!decision) {
      this.log("Respuesta de vision invalida: no se pudo obtener JSON de accion.");
      return null;
    }

    return decision;
  }

  async decidirAccionVisual(prompt = VISUAL_DECISION_PROMPT) {
    return this.requestDecision(prompt);
  }

  async waitForIdle() {
    if (this.pendingRequests.size === 0) {
      return;
    }

    await Promise.allSettled([...this.pendingRequests]);
  }

  async cleanupTempFiles() {
    const entries = await fs.promises.readdir(this.tempDir, { withFileTypes: true }).catch(() => []);

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }

      if (!/\.(png|jpg|jpeg|webp)$/i.test(entry.name)) {
        return;
      }

      const fullPath = path.join(this.tempDir, entry.name);
      await fs.promises.unlink(fullPath).catch(() => {});
    }));
  }
}
