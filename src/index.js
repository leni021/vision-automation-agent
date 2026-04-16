import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";
import DatabaseManager from "./DatabaseManager.js";
import generatePresentationMessage, { respuestaCortaFallback } from "./ContentEngine.js";
import ScraperComputrabajo from "./ScraperComputrabajo.js";
import StealthBrowser, { humanLikeDelay } from "./StealthBrowser.js";

dotenv.config();

const SEARCH_QUERIES = [
  "Programador",
  "Desarrollador",
  "Software Developer",
  "Developer Junior",
  "Analista Programador",
  "JavaScript",
  "Node"
];
const TARGET_LOCATION = "Argentina";
const ERROR_LOG_DIR = path.resolve(process.cwd(), "logs", "errors");

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const config = {
  sqlitePath: process.env.SQLITE_PATH || "data/jobhunter.db",
  maxJobsPerPortal: Math.max(1, toInt(process.env.MAX_JOBS_PER_PORTAL, 30)),
  readDelayMinMs: Math.max(1000, toInt(process.env.READ_DELAY_MIN_MS, 10000)),
  readDelayMaxMs: Math.max(1000, toInt(process.env.READ_DELAY_MAX_MS, 20000)),
  applicationIntervalMinMs: Math.max(1000, toInt(process.env.APPLICATION_INTERVAL_MIN_MS, 10000)),
  applicationIntervalMaxMs: Math.max(1000, toInt(process.env.APPLICATION_INTERVAL_MAX_MS, 20000)),
  cooldownEverySuccess: Math.max(1, toInt(process.env.COOLDOWN_EVERY_SUCCESS, 5)),
  cooldownMinutes: Math.max(1, toInt(process.env.COOLDOWN_MINUTES, 1)),
  authStateDir: process.env.AUTH_STATE_DIR || "data/auth",
  dailyApplicationLimit: Math.max(1, toInt(process.env.DAILY_APPLICATION_LIMIT, 50))
};

if (config.readDelayMaxMs < config.readDelayMinMs) {
  config.readDelayMaxMs = config.readDelayMinMs;
}

if (config.applicationIntervalMaxMs < config.applicationIntervalMinMs) {
  config.applicationIntervalMaxMs = config.applicationIntervalMinMs;
}

const portalDefinitions = [
  {
    name: "Computrabajo",
    ScraperClass: ScraperComputrabajo,
    authFileName: "auth-computrabajo.json",
    requiresCredentials: false,
    credentials: {
      email: process.env.COMPUTRABAJO_EMAIL,
      password: process.env.COMPUTRABAJO_PASSWORD
    }
  }
];

async function processPortal(definition, db, state) {
  const { name, ScraperClass, credentials } = definition;
  const browserManager = new StealthBrowser({ headless: false, slowMo: 0 });
  let page = null;
  let scraper = null;
  const authFileName =
    definition.authFileName || `${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-auth.json`;
  const authStatePath = path.resolve(process.cwd(), config.authStateDir, authFileName);
  const portalQueries = Array.isArray(definition.queries) && definition.queries.length > 0
    ? definition.queries
    : SEARCH_QUERIES;
  const waitForVisionToFinish = async () => {
    if (!scraper || typeof scraper.waitForVisionIdle !== "function") {
      return;
    }

    await scraper.waitForVisionIdle().catch(() => {});
  };

  try {
    const { storageStateLoaded } = await browserManager.launch({ storageStatePath: authStatePath });
    page = await browserManager.newPage();

    scraper = new ScraperClass({
      page,
      credentials,
      readDelayMinMs: config.readDelayMinMs,
      readDelayMaxMs: config.readDelayMaxMs,
      authStatePath,
      authStateLoaded: storageStateLoaded
    });

    let consecutiveLoginFailures = 0;

    while (true) {
      try {
        await scraper.login();
        consecutiveLoginFailures = 0;
        break;
      } catch (loginError) {
        consecutiveLoginFailures += 1;
        console.error(`[${name}] Error de login (${consecutiveLoginFailures}/3): ${loginError.message}`);

        if (consecutiveLoginFailures >= 3) {
          console.log("[Seguridad] Demasiados intentos de login. Enfriando hardware....");
          const tiempo = Math.floor(Math.random() * 10000) + 10000;
          console.log(`[Reloj] Pausa de seguridad: ${(tiempo / 1000).toFixed(1)} segundos...`);
          await page.waitForTimeout(tiempo);
          consecutiveLoginFailures = 0;
          continue;
        }

        await humanLikeDelay(5000, 12000);
      }
    }

    const offers = await scraper.searchOffers({
      queries: portalQueries,
      location: TARGET_LOCATION,
      maxLinks: config.maxJobsPerPortal
    });

    if (!offers || offers.length === 0) {
      console.log(`[${name}] Sin vacantes relevantes en esta corrida. Se continua con el siguiente portal.`);
      return;
    }

    const totalOffers = offers.length;
    for (const [index, offer] of offers.entries()) {
      if (state.dailyLimitReached) {
        break;
      }

      const sessionLimitReached =
        (typeof scraper.isApplicationSessionLimitReached === "function" && scraper.isApplicationSessionLimitReached()) ||
        state.sessionApplications >= config.dailyApplicationLimit;

      if (sessionLimitReached) {
        if (!state.dailyLimitReached) {
          console.log("[Seguridad] Limite diario alcanzado. Deteniendo para evitar ban.");
        }

        state.dailyLimitReached = true;
        break;
      }

      console.log(`[Progreso] Procesando vacante ${index + 1} de ${totalOffers} encontradas....`);

      try {
        if (state.dailyLimitReached) {
          continue;
        }

        const earlyTitle = String(offer.puesto ?? "").trim();
        const earlyBlacklistedTerm =
          earlyTitle && typeof scraper.getBlacklistedTermForTitle === "function"
            ? scraper.getBlacklistedTermForTitle(earlyTitle)
            : "";

        if (earlyBlacklistedTerm) {
          console.log(`[Filtro] Descartada por no ser software (Palabra clave prohibida): ${earlyBlacklistedTerm}`);
          await db.registerApplication({
            portal: name,
            empresa: offer.empresa ?? "",
            puesto: earlyTitle,
            url: offer.url,
            estado: "descartada"
          });
          continue;
        }

        const alreadyApplied = await db.isAlreadyApplied(offer.url);
        if (alreadyApplied) {
          console.log(`[${name}] Omitida por duplicado: ${offer.url}`);
          continue;
        }

        const jobData = await scraper.openJobAndRead(offer.url);
        if (!jobData) {
          await db.registerApplication({
            portal: name,
            empresa: offer.empresa ?? "",
            puesto: offer.puesto ?? "",
            url: offer.url,
            estado: "fallida"
          });
          continue;
        }

        const yaPostulado = await page
          .locator('text="Ya te postulaste", text="Postulado", text="Ya enviaste tu CV"')
          .first()
          .isVisible({ timeout: 3000 })
          .catch(() => false);

        if (yaPostulado) {
          console.log("[Filtro] Oferta ya postulada previamente (Detectado tilde verde). Saltando...");
          await db.registerApplication({
            portal: name,
            empresa: jobData.empresa || offer.empresa || "",
            puesto: jobData.puesto || offer.puesto || "",
            url: offer.url,
            estado: "descartada"
          });
          continue;
        }

        const strictTitle = String(jobData.puesto || offer.puesto || "").trim();
        const strictBlacklistedTerm =
          typeof scraper.getBlacklistedTermForTitle === "function"
            ? scraper.getBlacklistedTermForTitle(strictTitle)
            : "";

        if (strictBlacklistedTerm) {
          console.log(`[Filtro] Descartada por no ser software (Palabra clave prohibida): ${strictBlacklistedTerm}`);

          await db.registerApplication({
            portal: name,
            empresa: jobData.empresa || offer.empresa || "",
            puesto: strictTitle,
            url: offer.url,
            estado: "descartada"
          });

          continue;
        }

        if (!scraper.isRelevantJobTitle(strictTitle)) {
          console.log(
            `[${name}] Vacante descartada por filtro estricto de titulo: ${strictTitle || "(sin titulo)"} -> ${offer.url}`
          );

          await db.registerApplication({
            portal: name,
            empresa: jobData.empresa || offer.empresa || "",
            puesto: strictTitle,
            url: offer.url,
            estado: "descartada"
          });

          continue;
        }

        const presentationMessage = generatePresentationMessage(jobData.description);
        const applied = await scraper.applyToLoadedJob(presentationMessage, respuestaCortaFallback);

        await db.registerApplication({
          portal: name,
          empresa: jobData.empresa || offer.empresa || "",
          puesto: jobData.puesto || offer.puesto || "",
          url: offer.url,
          estado: applied ? "postulado" : "fallida"
        });

        if (applied) {
          state.successfulApplications += 1;

          if (typeof scraper.getApplicationSessionCount === "function") {
            state.sessionApplications = scraper.getApplicationSessionCount();
          } else {
            state.sessionApplications += 1;
          }

          console.log(`[${name}] Postulacion exitosa ${state.successfulApplications}: ${offer.url}`);

          const reachedAfterSuccess =
            (typeof scraper.isApplicationSessionLimitReached === "function" && scraper.isApplicationSessionLimitReached()) ||
            state.sessionApplications >= config.dailyApplicationLimit;

          if (reachedAfterSuccess) {
            if (!state.dailyLimitReached) {
              console.log("[Seguridad] Limite diario alcanzado. Deteniendo para evitar ban.");
            }

            state.dailyLimitReached = true;
            break;
          }

          const shouldFastContinue =
            typeof scraper.consumeFastExitOnPostApplyFlag === "function" &&
            scraper.consumeFastExitOnPostApplyFlag();

          if (shouldFastContinue) {
            continue;
          }

          if (state.successfulApplications % config.cooldownEverySuccess === 0) {
            console.log(`[Orchestrator] ${state.successfulApplications} postulaciones exitosas. Aplicando pausa de seguridad corta.`);
            const tiempo = Math.floor(Math.random() * 10000) + 10000;
            console.log(`[Reloj] Pausa de seguridad: ${(tiempo / 1000).toFixed(1)} segundos...`);
            await page.waitForTimeout(tiempo);
          }
        } else {
          console.log(`[${name}] Postulacion fallida: ${offer.url}`);
        }
      } catch (offerError) {
        console.error(`[${name}] Error en vacante ${offer.url}: ${offerError.message}`);

        const safePortal = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const screenshotPath = path.join(ERROR_LOG_DIR, `${safePortal}-${timestamp}.png`);

        await fs.promises.mkdir(ERROR_LOG_DIR, { recursive: true }).catch(() => {});
        if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
          console.error(`[${name}] No se pudo guardar screenshot de error: pagina cerrada.`);
        } else {
          await page
            .screenshot({ path: screenshotPath, fullPage: true })
            .then(() => {
              console.log(`[${name}] Screenshot de error guardado en: ${screenshotPath}`);
            })
            .catch((screenshotError) => {
              console.error(`[${name}] No se pudo guardar screenshot de error: ${screenshotError.message}`);
            });
        }

        await db
          .registerApplication({
            portal: name,
            empresa: offer.empresa ?? "",
            puesto: offer.puesto ?? "",
            url: offer.url,
            estado: "fallida"
          })
          .catch(() => {});

        continue;
      } finally {
        await waitForVisionToFinish();
      }

      if (state.dailyLimitReached) {
        break;
      }

      if (index < totalOffers - 1) {
        console.log(`[${name}] Espera aleatoria antes de la siguiente postulacion.`);
        const tiempo = Math.floor(Math.random() * 10000) + 10000;
        console.log(`[Reloj] Pausa de seguridad: ${(tiempo / 1000).toFixed(1)} segundos...`);
        await page.waitForTimeout(tiempo);
      }
    }
  } catch (error) {
    console.error(`[${name}] Error general del portal: ${error.message}`);
  } finally {
    await waitForVisionToFinish();
    await browserManager.close();
  }
}

async function runPortalsParallel(definitions, db, state, maxConcurrentAgents = 3) {
  const queue = [...definitions];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(Number(maxConcurrentAgents) || 1, queue.length));

  const worker = async (workerId) => {
    while (true) {
      if (state.dailyLimitReached) {
        return;
      }

      const index = cursor;
      cursor += 1;

      if (index >= queue.length) {
        return;
      }

      const portalDefinition = queue[index];
      const { name, credentials } = portalDefinition;
      const requiresCredentials = portalDefinition.requiresCredentials !== false;

      if (requiresCredentials && (!credentials?.email || !credentials?.password)) {
        console.log(`[${name}] Omitido por falta de credenciales en .env`);
        continue;
      }

      console.log(`[Orchestrator] [Agente ${workerId}] Inicio de flujo para ${name}.`);
      await processPortal(portalDefinition, db, state);

      if (state.dailyLimitReached) {
        return;
      }
    }
  };

  await Promise.all(
    Array.from({ length: workerCount }, (_, idx) => worker(idx + 1))
  );
}

async function main() {
  const db = new DatabaseManager(config.sqlitePath);
  const state = {
    successfulApplications: 0,
    sessionApplications: 0,
    dailyLimitReached: false
  };

  try {
    await db.init();

    await runPortalsParallel(portalDefinitions, db, state, 3);

    console.log(`[Orchestrator] Flujo finalizado. Exitos totales: ${state.successfulApplications}`);
  } finally {
    await db.close().catch(() => {});
  }
}

process.on("unhandledRejection", (error) => {
  console.error("[Global] Rechazo no manejado:", error);
});

process.on("uncaughtException", (error) => {
  console.error("[Global] Excepcion no manejada:", error);
});

main().catch((error) => {
  console.error("[Orchestrator] Error fatal:", error);
  process.exitCode = 1;
});