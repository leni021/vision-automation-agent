import dotenv from "dotenv";

dotenv.config();

const CANDIDATE_PROFILE_TEXT = `Soy Lenning Favian Hidalgo Ramos, Desarrollador de Software enfocado en Desktop Apps y Backend.
Stack principal: JavaScript (ES6+), Node.js, HTML5, CSS3, Express, Electron.js, SQLite y React.
Proyecto destacado 1: BarberOS. Aplicación de escritorio multiplataforma con más de 15 releases publicados. Migré la capa de datos de localStorage a SQLite e implementé Context Isolation e IPC Bridge para seguridad del proceso renderer. Automaticé el CI/CD con GitHub Actions.
Proyecto destacado 2: Kiosco Luzuriaga. Web para negocio local end-to-end desarrollada con Node.js, Express y EJS.
Educación: Próximo ingresante a la Tecnicatura Universitaria en Desarrollo de Software en UADE (agosto 2026).`;

export const respuestaCortaFallback = "Toda mi experiencia técnica, stack (Node.js/React/SQLite) y detalles de mis proyectos (BarberOS) se encuentran detallados en mi CV adjunto. Quedo a entera disposición para profundizar en una entrevista.";
export const SUELDO_PRETENDIDO = String(process.env.SUELDO_PRETENDIDO ?? "600000").replace(/\D/g, "") || "600000";

const normalize = (text) => String(text ?? "").toLowerCase();

function detectRelevantFocus(jobDescription) {
  const text = normalize(jobDescription);
  const focus = [];

  if (/electron|desktop|ipc|context isolation|sqlite/.test(text)) {
    focus.push("Tengo experiencia aplicando buenas practicas de arquitectura en aplicaciones desktop de produccion.");
  }

  if (/node|express|api|backend|javascript|typescript/.test(text)) {
    focus.push("Puedo aportar implementacion backend en Node.js con foco en codigo mantenible y entrega rapida.");
  }

  if (/automatizacion|playwright|selenium|scraping|procesos/.test(text)) {
    focus.push("Mi perfil esta orientado a automatizacion de procesos con trazabilidad y control de errores.");
  }

  if (/junior|trainee|entry/.test(text)) {
    focus.push("Estoy preparado para crecer rapido en posiciones Junior/Trainee con alto compromiso operativo.");
  }

  if (focus.length === 0) {
    focus.push("Busco sumar valor desde el primer sprint con ejecucion tecnica y comunicacion profesional.");
  }

  return focus.slice(0, 2);
}

export function generatePresentationMessage(jobDescription = "") {
  const focus = detectRelevantFocus(jobDescription);
  const lines = [
    CANDIDATE_PROFILE_TEXT,
    focus[0]
  ];

  if (focus[1]) {
    lines.push(focus[1]);
  }

  lines.push("Quedo a disposicion para ampliar detalles tecnicos y coordinar una entrevista.");

  return lines.join("\n");
}

export default generatePresentationMessage;