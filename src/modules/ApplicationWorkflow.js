import NavigationHelper from "./NavigationHelper.js";

const DEFAULT_SALARY_KEYWORDS = ["sueldo", "pretendido", "bruto"];
const DEFAULT_VISUAL_DECISION_ACTION_DELAY_MS = 2000;
const DEFAULT_NO_PROGRESS_WAIT_MS = 5000;
const MAX_VISUAL_QUERIES_PER_JOB = 3;
const APPLICATIONS_PER_SESSION_LIMIT = 50;
const SUCCESS_DELAY_MIN_MS = 20000;
const SUCCESS_DELAY_MAX_MS = 40000;
const FAST_EXIT_SUCCESS_DELAY_MIN_MS = 5000;
const FAST_EXIT_SUCCESS_DELAY_MAX_MS = 10000;
const POST_APPLY_URL_HINT = "postapply";
const POST_APPLY_SUCCESS_TEXT = "Te postulaste correctamente";
const LOGIN_BARRIER_PROMPT = "Analiza esta vacante. ¿El boton principal disponible dice Login, Ingresar o Crear CV en lugar de Postularme? Responde estrictamente con SI o NO.";
const ALREADY_APPLIED_SELECTOR = 'text="Ya te postulaste", text="Postulado", text="Ya enviaste tu CV"';

const escapeSelectorText = (value) => String(value ?? "").replace(/"/g, "\\\"").trim();

const OBSTACLE_ANALYSIS_PROMPT = `Eres el cerebro de un bot de empleo para Lenning (Dev Node.js/BarberOS).
Estas en estado de Analisis de Obstaculo porque se hizo click en "Postularme" y la pagina no avanzo.
Detecta visualmente el impedimento y prioriza:
1) Botones: Continuar, Siguiente, Finalizar, Enviar mi CV, Guardar y continuar.
2) Checkbox o terminos: Acepto terminos/condiciones/politica de privacidad.
3) Campos obligatorios sin completar.
Responde estrictamente con JSON: { "accion": "click" | "escribir" | "esperar", "objetivo": "texto_del_elemento", "valor": "string_opcional" }.`;

export default class ApplicationWorkflow {
  static successfulApplicationsInSession = 0;
  static sessionLimitLogged = false;

  constructor({
    page,
    log = () => {},
    clickFirst,
    fillFirst,
    fillVisibleTextareas,
    fillSalaryExpectedFields,
    detectSuccessfulApplication,
    decideVisualAction,
    clickByTextObjective,
    checkLoginBarrier,
    onRequireLogin,
    delay,
    cleanupTemp
  } = {}) {
    this.page = page;
    this.log = log;
    this.clickFirst = clickFirst;
    this.fillFirst = fillFirst;
    this.fillVisibleTextareas = fillVisibleTextareas;
    this.fillSalaryExpectedFields = fillSalaryExpectedFields;
    this.detectSuccessfulApplication = detectSuccessfulApplication;
    this.decideVisualAction = decideVisualAction;
    this.clickByTextObjective = clickByTextObjective;
    this.checkLoginBarrier = checkLoginBarrier;
    this.onRequireLogin = onRequireLogin;
    this.delay = delay;
    this.cleanupTemp = cleanupTemp;
    this.lastRunFastExitOnPostApply = false;
  }

  isPageClosed() {
    if (!this.page) {
      return true;
    }

    if (typeof this.page.isClosed === "function") {
      return this.page.isClosed();
    }

    return false;
  }

  async closeIntrusiveModalsOnCurrentPage() {
    if (this.isPageClosed()) {
      return false;
    }

    return NavigationHelper.closeIntrusiveModals(this.page).catch(() => false);
  }

  installNavigationModalGuard(enabled = false) {
    if (!enabled || this.isPageClosed()) {
      return () => {};
    }

    if (!this.page || typeof this.page.on !== "function") {
      return () => {};
    }

    let lastMainUrl = String(this.page.url() ?? "");

    const onFrameNavigated = (frame) => {
      if (this.isPageClosed()) {
        return;
      }

      if (typeof this.page.mainFrame === "function" && frame !== this.page.mainFrame()) {
        return;
      }

      const currentUrl = String(
        (frame && typeof frame.url === "function" ? frame.url() : this.page.url()) ?? ""
      );

      if (!currentUrl || currentUrl === lastMainUrl) {
        return;
      }

      lastMainUrl = currentUrl;
      void this.closeIntrusiveModalsOnCurrentPage();
    };

    this.page.on("framenavigated", onFrameNavigated);

    return () => {
      if (!this.page || typeof this.page.off !== "function") {
        return;
      }

      this.page.off("framenavigated", onFrameNavigated);
    };
  }

  isSessionLimitReached() {
    return ApplicationWorkflow.successfulApplicationsInSession >= APPLICATIONS_PER_SESSION_LIMIT;
  }

  getSessionSuccessfulApplications() {
    return ApplicationWorkflow.successfulApplicationsInSession;
  }

  consumeFastExitOnPostApplyFlag() {
    const shouldFastExit = this.lastRunFastExitOnPostApply;
    this.lastRunFastExitOnPostApply = false;
    return shouldFastExit;
  }

  isPostApplyUrl(url = String(this.page?.url() ?? "")) {
    return String(url ?? "").toLowerCase().includes(POST_APPLY_URL_HINT);
  }

  async isAbsoluteSuccessPage(successTextPatterns = []) {
    if (this.isPageClosed()) {
      return false;
    }

    const currentUrl = String(this.page.url() ?? "");
    if (this.isPostApplyUrl(currentUrl)) {
      return true;
    }

    const explicitSuccessTextVisible = await this.page
      .getByText(POST_APPLY_SUCCESS_TEXT, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);

    if (explicitSuccessTextVisible) {
      return true;
    }

    const genericSuccess = await this.detectSuccessfulApplication([
      POST_APPLY_SUCCESS_TEXT,
      ...(successTextPatterns ?? [])
    ]);

    return Boolean(genericSuccess);
  }

  async handleAbsoluteSuccessFastExit({
    successTextPatterns = [],
    waitForPostApplyTimeoutMs = 0
  } = {}) {
    if (this.isPageClosed()) {
      return false;
    }

    if (waitForPostApplyTimeoutMs > 0) {
      await this.page.waitForURL("**/postapply**", { timeout: waitForPostApplyTimeoutMs }).catch(() => {});
    }

    const isAbsoluteSuccess = await this.isAbsoluteSuccessPage(successTextPatterns);
    if (!isAbsoluteSuccess) {
      return false;
    }

    this.lastRunFastExitOnPostApply = true;
    this.log("[Éxito] Postulación completada en vacante X. CV enviado.");

    if (typeof this.delay === "function") {
      await this.delay(FAST_EXIT_SUCCESS_DELAY_MIN_MS, FAST_EXIT_SUCCESS_DELAY_MAX_MS);
    }

    await this.onSuccessfulApplication();
    return true;
  }

  async onSuccessfulApplication() {
    ApplicationWorkflow.successfulApplicationsInSession += 1;

    const total = ApplicationWorkflow.successfulApplicationsInSession;
    this.log(`[Seguridad] Postulacion exitosa ${total}/${APPLICATIONS_PER_SESSION_LIMIT} en esta sesion.`);

    if (typeof this.delay === "function") {
      await this.delay(SUCCESS_DELAY_MIN_MS, SUCCESS_DELAY_MAX_MS);
    }

    if (this.isSessionLimitReached() && !ApplicationWorkflow.sessionLimitLogged) {
      this.log("[Seguridad] Limite diario alcanzado. Deteniendo para evitar ban.");
      ApplicationWorkflow.sessionLimitLogged = true;
    }
  }

  async recoverFromLoginBarrier(offerUrl) {
    if (this.isPageClosed()) {
      return false;
    }

    if (typeof this.checkLoginBarrier !== "function") {
      return false;
    }

    const loginBarrierDetected = await this.checkLoginBarrier(LOGIN_BARRIER_PROMPT).catch(() => false);
    if (!loginBarrierDetected) {
      return false;
    }

    this.log("Se detecto barrera de Login en la oferta. Se interrumpe para autenticar y reintentar.");

    if (typeof this.onRequireLogin !== "function") {
      return false;
    }

    const reloginDone = await this.onRequireLogin().catch(() => false);
    if (!reloginDone) {
      return false;
    }

    if (offerUrl) {
      if (this.isPageClosed()) {
        return false;
      }

      await this.page.goto(offerUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      }).catch(() => {});
      await this.delay(1200, 2600);
    }

    return true;
  }

  async getPageSignature() {
    const url = String(this.page.url() ?? "");
    const bodyText = String(await this.page.textContent("body").catch(() => ""))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1200);

    return `${url}::${bodyText}`;
  }

  buildSubmitSelectorPool(submitSelectors = [], visualContinueButtonTexts = []) {
    const safeVisualButtonTexts = [...new Set((visualContinueButtonTexts ?? [])
      .map((text) => String(text ?? "").trim())
      .filter(Boolean))];

    const dynamicSubmitSelectors = safeVisualButtonTexts.flatMap((text) => {
      const escapedText = escapeSelectorText(text);
      return [`button:has-text("${escapedText}")`, `a:has-text("${escapedText}")`];
    });

    return {
      safeVisualButtonTexts,
      submitSelectorPool: [...new Set([...(submitSelectors ?? []), ...dynamicSubmitSelectors])]
    };
  }

  async submitApplicationFlow(config, message, shortAnswerFallback = "") {
    this.lastRunFastExitOnPostApply = false;

    if (this.isSessionLimitReached()) {
      if (!ApplicationWorkflow.sessionLimitLogged) {
        this.log("[Seguridad] Limite diario alcanzado. Deteniendo para evitar ban.");
        ApplicationWorkflow.sessionLimitLogged = true;
      }

      return false;
    }

    const {
      applyButtonSelectors = [],
      messageSelectors = [],
      submitSelectors = [],
      successTextPatterns = [],
      sueldoPretendido = "",
      salaryFieldKeywords = DEFAULT_SALARY_KEYWORDS,
      visualDecisionEnabled = false,
      maxVisualDecisionAttempts = 3,
      triggerVisualDecisionOnNoProgress = false,
      visualContinueButtonTexts = [],
      visualPrompt = ""
    } = config || {};

    const removeNavigationModalGuard = this.installNavigationModalGuard(visualDecisionEnabled);
    await this.closeIntrusiveModalsOnCurrentPage();

    const { safeVisualButtonTexts, submitSelectorPool } = this.buildSubmitSelectorPool(
      submitSelectors,
      visualContinueButtonTexts
    );

    const configuredAttempts = Math.max(1, Number(maxVisualDecisionAttempts) || 1);
    const visualQueryLimit = Math.min(MAX_VISUAL_QUERIES_PER_JOB, configuredAttempts);
    let visualQueriesUsed = 0;
    let visualErrorLogged = false;

    const logVisualError = (context) => {
      if (visualErrorLogged) {
        return;
      }

      this.log(`Error visual: ${context}. Se pasa a la siguiente oferta.`);
      visualErrorLogged = true;
    };

    const requestVisualDecision = async ({
      prompt = visualPrompt,
      reason = "",
      actionDelayMs = DEFAULT_VISUAL_DECISION_ACTION_DELAY_MS
    } = {}) => {
      if (!visualDecisionEnabled) {
        return { exhausted: false, result: null, used: false };
      }

      if (visualQueriesUsed >= visualQueryLimit) {
        return { exhausted: true, result: null, used: false };
      }

      if (this.isPageClosed()) {
        this.log("Error visual: la pagina se cerro antes de consultar IA.");
        return { exhausted: true, result: null, used: false };
      }

      await this.closeIntrusiveModalsOnCurrentPage();

      visualQueriesUsed += 1;
      if (reason) {
        this.log(`Analisis de obstaculo (${visualQueriesUsed}/${visualQueryLimit}): ${reason}`);
      }

      const result = await this.decideVisualAction({
        prompt,
        shortAnswerFallback,
        sueldoPretendido,
        salaryFieldKeywords,
        actionDelayMs
      });

      return { exhausted: false, result, used: true };
    };

    try {
      const yaPostulado = await this.page
        .locator(ALREADY_APPLIED_SELECTOR)
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      if (yaPostulado) {
        this.log("[Filtro] Oferta ya postulada previamente (Detectado tilde verde). Saltando...");
        return false;
      }

      const filledSalaryFields = await this.fillSalaryExpectedFields(sueldoPretendido, salaryFieldKeywords);
      if (filledSalaryFields > 0) {
        this.log(`Se completaron ${filledSalaryFields} campo(s) de sueldo pretendido antes de postular.`);
      }

      const initialUrl = String(this.page.url() ?? "");
      const offerUrl = initialUrl;
      let clickedApply = await this.clickFirst(applyButtonSelectors, 9000);

      if (!clickedApply) {
        const recoveredByLogin = await this.recoverFromLoginBarrier(offerUrl);
        if (recoveredByLogin) {
          clickedApply = await this.clickFirst(applyButtonSelectors, 9000);
        }
      }

      if (!clickedApply && visualDecisionEnabled) {
        this.log("No se detecto boton de postular. Activando bucle visual.");

        while (!clickedApply) {
          const visualStep = await requestVisualDecision({
            prompt: visualPrompt || OBSTACLE_ANALYSIS_PROMPT,
            reason: "no se encontro boton estandar de postular"
          });

          if (visualStep.exhausted) {
            logVisualError("se alcanzo el limite de consultas visuales sin hallar boton de postular");
            return false;
          }

          clickedApply = await this.clickFirst(applyButtonSelectors, 7000);
          if (!clickedApply && visualStep.result?.accion === "click" && visualStep.result?.executed) {
            clickedApply = "visual-click";
          }
        }
      }

      if (!clickedApply) {
        this.log("No se detecto boton de postular.");
        return false;
      }

      const postApplyFastExit = await this.handleAbsoluteSuccessFastExit({
        successTextPatterns,
        waitForPostApplyTimeoutMs: 10000
      });

      if (postApplyFastExit) {
        return true;
      }

      await this.delay(800, 2200);

      const successBeforeVisual = await this.handleAbsoluteSuccessFastExit({
        successTextPatterns
      });

      if (successBeforeVisual) {
        return true;
      }

      if (triggerVisualDecisionOnNoProgress && visualDecisionEnabled) {
        await this.delay(DEFAULT_NO_PROGRESS_WAIT_MS, DEFAULT_NO_PROGRESS_WAIT_MS);
        const urlAfterApplyWait = String(this.page.url() ?? "");

        if (urlAfterApplyWait === initialUrl) {
          const recoveredByLogin = await this.recoverFromLoginBarrier(offerUrl);
          if (recoveredByLogin) {
            const retriedApply = await this.clickFirst(applyButtonSelectors, 9000);
            if (retriedApply) {
              clickedApply = retriedApply;
              await this.delay(800, 2200);
            }
          }

          const urlAfterRecovery = String(this.page.url() ?? "");
          if (urlAfterRecovery === initialUrl) {
            this.log("Estado: Analisis de obstaculo por falta de avance luego de 5 segundos.");
            let obstacleResolved = false;

            while (!obstacleResolved) {
              const signatureBefore = await this.getPageSignature();
              const visualStep = await requestVisualDecision({
                prompt: OBSTACLE_ANALYSIS_PROMPT,
                reason: "la URL no cambio tras Postularme"
              });

              if (visualStep.exhausted) {
                logVisualError("la pagina no avanzo luego de 3 consultas visuales");
                return false;
              }

              await this.delay(1000, 2200);

              for (const buttonText of safeVisualButtonTexts) {
                await this.clickByTextObjective(buttonText, 2500).catch(() => false);
              }

              await this.page.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {});
              const signatureAfter = await this.getPageSignature();
              const successNow = await this.detectSuccessfulApplication(successTextPatterns);

              obstacleResolved = successNow || signatureAfter !== signatureBefore;
            }
          }
        }
      }

      const shortText = String(shortAnswerFallback ?? "").trim();
      let answeredTextareas = 0;

      if (shortText) {
        answeredTextareas += await this.fillVisibleTextareas(shortText, 6000);
      }

      if (message && messageSelectors.length > 0 && answeredTextareas === 0) {
        const safeLongMessageSelectors = messageSelectors.filter((selector) => !/textarea/i.test(selector));

        if (safeLongMessageSelectors.length > 0) {
          await this.fillFirst(safeLongMessageSelectors, message, {
            timeout: 9000,
            clearBefore: true,
            useSmoothType: false
          });
        }
      }

      if (shortText) {
        answeredTextareas += await this.fillVisibleTextareas(shortText, 3000);
      }

      let clickedSubmit = await this.clickFirst(submitSelectorPool, 9000);

      const successBeforeSubmitVisual = await this.handleAbsoluteSuccessFastExit({
        successTextPatterns
      });

      if (successBeforeSubmitVisual) {
        return true;
      }

      if (!clickedSubmit && visualDecisionEnabled) {
        this.log("No se detecto boton de envio. Activando bucle visual.");

        while (!clickedSubmit) {
          const visualStep = await requestVisualDecision({
            prompt: OBSTACLE_ANALYSIS_PROMPT,
            reason: "no se encontro boton de envio"
          });

          if (visualStep.exhausted) {
            logVisualError("no se encontro envio luego de 3 consultas visuales");
            return false;
          }

          clickedSubmit = await this.clickFirst(submitSelectorPool, 7000);
          if (!clickedSubmit && visualStep.result?.accion === "click" && visualStep.result?.executed) {
            clickedSubmit = "visual-click";
          }
        }
      }

      await this.delay(2000, 4200);

      const successAfterSubmit = await this.handleAbsoluteSuccessFastExit({
        successTextPatterns,
        waitForPostApplyTimeoutMs: 10000
      });

      if (successAfterSubmit) {
        return true;
      }

      if (shortText) {
        const lateTextareas = await this.fillVisibleTextareas(shortText, 2500);
        if (lateTextareas > 0) {
          clickedSubmit = clickedSubmit || await this.clickFirst(submitSelectorPool, 9000);
          await this.delay(1400, 3000);
        }
      }

      const successDetected = await this.detectSuccessfulApplication(successTextPatterns);
      if (successDetected) {
        await this.onSuccessfulApplication();
        return true;
      }

      if (visualDecisionEnabled) {
        const successBeforePostSubmitVisual = await this.handleAbsoluteSuccessFastExit({
          successTextPatterns
        });

        if (successBeforePostSubmitVisual) {
          return true;
        }

        while (visualQueriesUsed < visualQueryLimit) {
          const visualStep = await requestVisualDecision({
            prompt: OBSTACLE_ANALYSIS_PROMPT,
            reason: "post-envio sin mensaje de confirmacion"
          });

          if (visualStep.exhausted) {
            break;
          }

          const postVisualSuccess = await this.detectSuccessfulApplication(successTextPatterns);
          if (postVisualSuccess) {
            await this.onSuccessfulApplication();
            return true;
          }
        }

        if (!visualErrorLogged) {
          logVisualError("la postulación no mostro confirmacion luego de agotar analisis visual");
        }
      }

      return false;
    } finally {
      removeNavigationModalGuard();

      if (typeof this.cleanupTemp === "function") {
        await this.cleanupTemp();
      }
    }
  }
}
