import StealthBrowser from "./src/StealthBrowser.js";
import VisionHelper from "./src/VisionHelper.js";

const PROMPT = "Describe briefly what interface elements you see in this image. Be concise.";

async function main() {
  const browserManager = new StealthBrowser({ headless: false, slowMo: 0 });
  const visionHelper = new VisionHelper();

  try {
    await browserManager.launch();
    const page = await browserManager.newPage();

    await page.goto("https://www.bumeran.com.ar/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    const respuesta = await visionHelper.analizarElemento(page, null, PROMPT);

    console.log("Respuesta de Vision (LLaVA):");
    console.log(respuesta || "Sin respuesta del modelo.");
  } finally {
    await browserManager.close();
  }
}

main().catch((error) => {
  console.error("Error en test-vision:", error.message);
  process.exitCode = 1;
});