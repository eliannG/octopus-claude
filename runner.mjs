// Corre dentro de GitHub Actions cuando llega un mensaje de WhatsApp. Hace de «Claude de tu plan» para el Worker:
//  1. levanta server.mjs (Claude Code sin interfaz) en la máquina de GitHub;
//  2. lo publica con un túnel rápido de Cloudflare (sin cuenta): el Worker no puede entrar a GitHub de otra forma;
//  3. le dice al Worker «acá estoy, esta es mi dirección» y el Worker procesa los mensajes pendientes usando Claude;
//  4. se queda un rato por si escribís de nuevo (así el segundo mensaje no espera el arranque) y se apaga.
// Variables: WORKER_URL, OCTOPUS_API_TOKEN (el API_TOKEN del Worker), CLAUDE_CODE_OAUTH_TOKEN, LINGER_SECONDS (150).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const WORKER = String(process.env.WORKER_URL || "").replace(/\/+$/, "");
const API = process.env.OCTOPUS_API_TOKEN || "";
const LINGER = +(process.env.LINGER_SECONDS || 150) * 1000;
const PORT = 8787;
if (!WORKER || !API || !process.env.CLAUDE_CODE_OAUTH_TOKEN) { console.error("Faltan secretos: WORKER_URL, OCTOPUS_API_TOKEN o CLAUDE_CODE_OAUTH_TOKEN."); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = randomBytes(32).toString("hex");   // clave de esta sesión entre el Worker y este servidor
const kids = [];
const stop = () => { for (const k of kids) { try { k.kill("SIGTERM"); } catch { /* ya terminó */ } } };
process.on("exit", stop);

// 1. Claude
const server = spawn("node", ["server.mjs"], { env: { ...process.env, OCTOPUS_VM_TOKEN: token, PORT: String(PORT), HOST: "127.0.0.1" }, stdio: "inherit" });
kids.push(server);

// 2. túnel
const tunnel = spawn("./cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
kids.push(tunnel);
const url = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("el túnel no dio una dirección en 60 s")), 60_000);
  const look = (d) => { const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d)); if (m) { clearTimeout(t); resolve(m[0]); } };
  tunnel.stdout.on("data", look); tunnel.stderr.on("data", look);
  tunnel.on("exit", (c) => reject(new Error("cloudflared terminó (" + c + ")")));
});
// la dirección tarda unos segundos en existir para el resto del mundo
let up = false;
for (let i = 0; i < 30 && !up; i++) {
  try { const r = await fetch(url + "/", { signal: AbortSignal.timeout(5000) }); up = r.ok; } catch { /* todavía no */ }
  if (!up) await sleep(2000);
}
if (!up) { console.error("El túnel no respondió."); stop(); process.exit(1); }
console.log("Túnel listo.");

// 3 y 4. trabajar y quedarse un rato
const call = async (path) => {
  const r = await fetch(WORKER + path, { method: "POST", headers: { authorization: "Bearer " + API, "content-type": "application/json" }, body: JSON.stringify({ url, token }) });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
};
let idleSince = Date.now(), fails = 0, done = 0;
while (Date.now() - idleSince < LINGER && fails < 5) {
  try {
    const j = await call("/gh/work");
    fails = 0;
    if (j.processed) { done += j.processed; idleSince = Date.now(); console.log(`Mensaje procesado (${done}). Quedan ${j.pending ?? 0}.`); continue; }
  } catch (e) { fails++; console.warn("El Worker no contestó:", e.message); }
  await sleep(4000);
}
if (fails >= 5) { console.error("El Worker no contestó en " + WORKER.replace(/^https:\/\//, "").split(".")[0] + ": revisá la dirección (secreto WORKER_URL) y el API_TOKEN."); stop(); process.exit(1); }
await call("/gh/bye").catch(() => undefined);
console.log(`Listo: ${done} mensaje(s). Me apago.`);
stop();
process.exit(0);
