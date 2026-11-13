// Claude de tu plan para Octopus: lo levanta cloud/gh/runner.mjs dentro de GitHub Actions (ver LEEME.md).
// Es un servidor chiquito: recibe {system, user, model, images?} del Worker de Cloudflare, se lo pasa a Claude Code en
// modo sin interfaz (`claude -p`, con la sesión de tu plan) y devuelve el texto. Sin herramientas: Claude solo piensa;
// las acciones (notas, agenda, personas) las ejecuta el Worker. Sin dependencias: solo Node 18+.
//
// Variables (Settings → Variables and secrets del Space, como Secret):
//   OCTOPUS_VM_TOKEN         — clave larga (mínimo 24 caracteres); la misma que CLAUDE_VM_TOKEN del Worker
//   CLAUDE_CODE_OAUTH_TOKEN  — la sesión de tu plan: sale de `claude setup-token` en tu PC
// Opcionales: PORT (7860), HOST (0.0.0.0), CLAUDE_BIN (claude), CLAUDE_TIMEOUT_MS (120000), MAX_PARALLEL (2)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = process.env.OCTOPUS_VM_TOKEN || "";
const PORT = +(process.env.PORT || 7860);
const HOST = process.env.HOST || "0.0.0.0";
const BIN = process.env.CLAUDE_BIN || "claude";
const MAX_BODY = 12 * 1024 * 1024;      // la foto del cerebro (cientos de KB) y alguna imagen
const TIMEOUT = +(process.env.CLAUDE_TIMEOUT_MS || 120_000);
const MAX_PARALLEL = +(process.env.MAX_PARALLEL || 2);
const MODELS = new Set(["haiku", "sonnet", "opus"]);
const MEDIA = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
if (TOKEN.length < 24) { console.error("Falta OCTOPUS_VM_TOKEN (mínimo 24 caracteres)."); process.exit(1); }
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) console.warn("Ojo: falta CLAUDE_CODE_OAUTH_TOKEN (sin eso Claude Code no tiene tu sesión).");

// carpeta neutra: que Claude Code no lea instrucciones de ningún proyecto
const cwd = join(tmpdir(), "octopus-claude");
mkdirSync(cwd, { recursive: true });

const okToken = (h) => {
  const a = Buffer.from(String(h || "").replace(/^Bearer\s+/i, "")), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Un pedido a Claude Code. Las instrucciones van en un archivo (`--system-prompt-file`): como argumento, Linux corta
 *  a ~128 KB y la foto del cerebro es más grande. Con imágenes, el mensaje va en formato stream-json. */
function ask(system, user, model, images) {
  const sysFile = join(cwd, `system-${randomUUID()}.txt`);
  writeFileSync(sysFile, system || "Respondé en español rioplatense.");
  const withImages = images.length > 0;
  const args = ["-p", "--model", model, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt-file", sysFile,
    ...(withImages ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["--output-format", "json"])];
  const input = withImages
    ? JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: user }, ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media, data: im.data } }))] } }) + "\n"
    : user;
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let out = "", err = "";
    const done = (fn, v) => { clearTimeout(timer); rmSync(sysFile, { force: true }); fn(v); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(reject, new Error("Claude tardó demasiado")); }, TIMEOUT);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => done(reject, new Error("No pude abrir Claude Code: " + e.message)));
    child.on("close", () => {
      try {
        const j = withImages
          ? out.trim().split("\n").reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x && x.type === "result")
          : JSON.parse(out.trim());
        if (!j) throw new Error("sin resultado");
        if (j.is_error) return done(reject, new Error(/Not logged in|\/login|invalid.*token/i.test(String(j.result)) ? "Claude Code no tiene la sesión: revisá CLAUDE_CODE_OAUTH_TOKEN" : String(j.result || "error de Claude").slice(0, 300)));
        done(resolve, String(j.result || ""));
      } catch { done(reject, new Error("Respuesta rara de Claude Code: " + (err || out).slice(0, 300))); }
    });
    child.stdin.end(input);
  });
}

let running = 0;
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

createServer((req, res) => {
  // el Worker saluda cada 6 h (GET /) para que el Space no se duerma
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) return send(res, 200, { ok: true, service: "octopus-claude", ocupado: running });
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
    const model = MODELS.has(body.model) ? body.model : "sonnet";
    const images = (Array.isArray(body.images) ? body.images : []).filter((im) => im && MEDIA.has(im.media) && typeof im.data === "string").slice(0, 16);
    if (!user) return send(res, 400, { error: "falta el mensaje" });
    running++;
    const t0 = Date.now();
    try {
      const text = await ask(system, user, model, images);
      // en el registro no va nada del contenido (los registros de un Space público los ve cualquiera)
      console.log(`${new Date().toISOString()} ok ${model} ${Date.now() - t0} ms · ${system.length + user.length} caracteres · ${images.length} imágenes`);
      send(res, 200, { text, model });
    } catch (e) {
      console.warn(`${new Date().toISOString()} error: ${String(e.message).split(":")[0].slice(0, 60)}`);
      send(res, 502, { error: e.message });
    } finally { running--; }
  });
}).listen(PORT, HOST, () => console.log(`Octopus · Claude escuchando en ${HOST}:${PORT}`));
