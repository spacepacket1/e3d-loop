#!/usr/bin/env node
// Streaming shim for OpenAI-compatible servers that ignore `stream: true` and reply with one JSON body
// (observed with the local MLX Qwen server). Pi's openai-completions client needs SSE, so this forwards the
// request non-streaming and re-emits the reply as server-sent events. Listens on localhost only.
//   node bin/sse-shim.mjs [--listen 5051] [--upstream http://127.0.0.1:5050]
import { createServer } from "node:http";
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg("--listen", "5051")), UP = arg("--upstream", "http://127.0.0.1:5050").replace(/\/$/, "");

export function toSse(j) {
  const c = j.choices?.[0] ?? {}; const m = c.message ?? {}; const base = { id: j.id ?? "shim", object: "chat.completion.chunk", created: j.created ?? 0, model: j.model };
  const ev = [];
  // This server returns content as [{type:"text",text}] when tools are in the request; OpenAI clients expect a string.
  const content = Array.isArray(m.content) ? m.content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("") : m.content ?? "";
  ev.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content, ...(m.tool_calls ? { tool_calls: m.tool_calls.map((t, i) => ({ index: i, ...t })) } : {}) }, finish_reason: null }] });
  ev.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: c.finish_reason ?? "stop" }], ...(j.usage ? { usage: j.usage } : {}) });
  return ev.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    let body = Buffer.concat(chunks); let wantStream = false;
    if (req.method === "POST" && req.url.includes("/chat/completions")) {
      try { const j = JSON.parse(body.toString()); wantStream = !!j.stream; delete j.stream; delete j.stream_options; body = Buffer.from(JSON.stringify(j)); } catch { /* pass through */ }
    }
    try {
      const up = await fetch(UP + req.url, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" ? undefined : body });
      const text = await up.text();
      if (wantStream && up.ok) { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); res.end(toSse(JSON.parse(text))); }
      else { res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" }); res.end(text); }
    } catch (e) { res.writeHead(502); res.end(String(e)); }
  }).listen(PORT, "127.0.0.1", () => console.error(`sse-shim on 127.0.0.1:${PORT} -> ${UP}`));
}
