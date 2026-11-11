// Claude de tu plan, para el agente de WhatsApp. Corre en una máquina tuya siempre prendida (una VM gratis).
// Es un servidor chiquito: recibe {system, user, model} del Worker de Cloudflare, se lo pasa a Claude Code en modo
// sin interfaz (`claude -p`, con la sesión de tu plan) y devuelve el texto. Sin herramientas: Claude solo piensa;
// las acciones (notas, agenda, personas) las ejecuta el Worker. Sin dependencias: solo Node 18+.
//
//   OCTOPUS_VM_TOKEN=<clave larga> node server.mjs
//
// Variables: OCTOPUS_VM_TOKEN (obligatoria, la misma que CLAUDE_VM_TOKEN del Worker), PORT (8787),
// CLAUDE_BIN (claude), CLAUDE_CODE_OAUTH_TOKEN (la sesión de tu plan: sale de `claude setup-token`).
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = process.env.OCTOPUS_VM_TOKEN || "";
const PORT = +(process.env.PORT || 8787);
const BIN = process.env.CLAUDE_BIN || "claude";
const MAX_BODY = 6 * 1024 * 1024;      // la foto del cerebro puede ser grande
const TIMEOUT = +(process.env.CLAUDE_TIMEOUT_MS || 120_000);
const MAX_PARALLEL = +(process.env.MAX_PARALLEL || 2);
const MODELS = new Set(["haiku", "sonnet", "opus"]);
if (TOKEN.length < 24) { console.error("Falta OCTOPUS_VM_TOKEN (mínimo 24 caracteres)."); process.exit(1); }

// carpeta neutra: que Claude Code no lea instrucciones de ningún proyecto
const cwd = join(tmpdir(), "octopus-claude");
mkdirSync(cwd, { recursive: true });

const okToken = (h) => {
  const a = Buffer.from(String(h || "").replace(/^Bearer\s+/i, "")), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

let running = 0;
function ask(system, user, model) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--model", model, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", system];
    const child = spawn(BIN, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Claude tardó demasiado")); }, TIMEOUT);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error("No pude abrir Claude Code: " + e.message)); });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out.trim());
        if (j.is_error) return reject(new Error(String(j.result || "error de Claude").slice(0, 300)));
        resolve(String(j.result || ""));
      } catch { reject(new Error("Respuesta rara de Claude Code: " + (err || out).slice(0, 300))); }
    });
    child.stdin.end(user);
  });
}

const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") return send(res, 200, { ok: true, service: "octopus-claude" });
  if (req.method !== "POST" || req.url !== "/ask") return send(res, 404, { error: "no existe" });
  if (!okToken(req.headers.authorization)) return send(res, 401, { error: "sin permiso" });
  if (running >= MAX_PARALLEL) return send(res, 429, { error: "ocupado" });
  let size = 0; const chunks = [];
  req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { send(res, 413, { error: "muy grande" }); req.destroy(); } else chunks.push(c); });
  req.on("end", async () => {
    if (res.writableEnded) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(res, 400, { error: "JSON inválido" }); }
    const system = String(body.system || ""), user = String(body.user || "");
    const model = MODELS.has(body.model) ? body.model : "haiku";
    if (!user) return send(res, 400, { error: "falta el mensaje" });
    running++;
    const t0 = Date.now();
    try {
      const text = await ask(system, user, model);
      console.log(`${new Date().toISOString()} ok ${model} ${Date.now() - t0} ms · ${system.length + user.length} caracteres`);
      send(res, 200, { text, model });
    } catch (e) {
      console.warn(`${new Date().toISOString()} error: ${e.message}`);
      send(res, 502, { error: e.message });
    } finally { running--; }
  });
// HOST: 127.0.0.1 en una VM (lo publica Caddy con HTTPS); 0.0.0.0 dentro de un contenedor (Hugging Face Spaces)
}).listen(PORT, process.env.HOST || "127.0.0.1", () => console.log(`Octopus · Claude escuchando en ${process.env.HOST || "127.0.0.1"}:${PORT}`));
