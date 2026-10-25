/* Pi Central prototype UI.
 *
 * Rendering contract (ADR-0006): every string that reaches the DOM is inert
 * text. The ONLY HTML insertion point is the sanitized merge below:
 *
 *   markdown-it { html: false }  ->  DOMPurify  ->  innerHTML
 *
 * No other innerHTML with untrusted data anywhere in this file.
 */

const $ = (id) => document.getElementById(id);

/* ---------------- sanitized markdown ---------------- */

const md = window.markdownit({ html: false, linkify: false, breaks: true });

// Escape everything first, then add a *closed* set of highlight spans. Keeping
// the open/close tags balanced means DOMPurify never sees partial markup.
const KEYWORDS = new Set([
  "const","let","var","function","return","if","else","for","while","import","from",
  "export","default","async","await","class","extends","new","try","catch","finally",
  "throw","typeof","instanceof","in","of","null","undefined","true","false","this",
  "interface","type","enum","implements","public","private","readonly","as","def",
  "print","end","then","do","fi","done","case","esac","elif","func","package","fn",
]);

function highlight(code) {
  const esc = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let out = "";
  let i = 0;
  while (i < esc.length) {
    const ch = esc[i];

    // comments
    if (ch === "/" && esc[i + 1] === "/") {
      const nl = esc.indexOf("\n", i);
      const end = nl === -1 ? esc.length : nl;
      out += `<span class="tok-com">${esc.slice(i, end)}</span>`;
      i = end;
      continue;
    }
    if (ch === "#" && /[a-z]/i.test(esc[i + 1] || "")) {
      const nl = esc.indexOf("\n", i);
      const end = nl === -1 ? esc.length : nl;
      out += `<span class="tok-com">${esc.slice(i, end)}</span>`;
      i = end;
      continue;
    }
    // strings
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < esc.length && esc[j] !== ch) { if (esc[j] === "\\") j++; j++; }
      j = Math.min(j + 1, esc.length);
      out += `<span class="tok-str">${esc.slice(i, j)}</span>`;
      i = j;
      continue;
    }
    // numbers
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < esc.length && /[0-9a-fx._]/i.test(esc[j])) j++;
      out += `<span class="tok-num">${esc.slice(i, j)}</span>`;
      i = j;
      continue;
    }
    // identifiers / keywords
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < esc.length && /[A-Za-z0-9_$]/.test(esc[j])) j++;
      const word = esc.slice(i, j);
      if (KEYWORDS.has(word)) out += `<span class="tok-key">${word}</span>`;
      else if (esc[j] === "(") out += `<span class="tok-fn">${word}</span>`;
      else if (/^[A-Z]/.test(word)) out += `<span class="tok-typ">${word}</span>`;
      else out += word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function renderMarkdown(text) {
  const html = md.render(text ?? "");
  // DOMPurify is the belt to html:false's braces.
  return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

/** The single sanitized insertion point. */
function setRich(el, text) {
  el.innerHTML = renderMarkdown(text);
}

/** Code blocks render as escaped text with closed highlight spans. */
function setCode(el, text) {
  el.innerHTML = window.DOMPurify.sanitize(highlight(text ?? ""), { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"] });
}

/* ---------------- state ---------------- */

let sessions = [];
let historical = [];
let activeId = null;
let ws = null;
let reconnectTimer = null;

/** Per-session transcript model, rebuilt from events. */
const transcripts = new Map(); // id -> [{role, text, streaming}]
const tools = new Map();       // id -> [{name, summary}]

function tx(id) {
  if (!transcripts.has(id)) transcripts.set(id, []);
  return transcripts.get(id);
}
function toolList(id) {
  if (!tools.has(id)) tools.set(id, []);
  return tools.get(id);
}

/* ---------------- websocket ---------------- */

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1200);
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg) {
  if (msg.kind === "snapshot") {
    sessions = msg.sessions || [];
    historical = msg.historical || [];
    if (msg.inheritedSandbox) showNotice(
      "This orchestrator is inside a Seatbelt sandbox, so Safehouse sessions cannot start (Seatbelt does not nest). Direct mode still works.",
    );
    renderRail();
    return;
  }
  if (msg.kind === "session") {
    const i = sessions.findIndex((s) => s.id === msg.session.id);
    if (i === -1) sessions.push(msg.session); else sessions[i] = msg.session;
    renderRail();
    if (msg.session.id === activeId) renderWorkspace();
    return;
  }
  if (msg.kind === "event") {
    applyEvent(msg.sessionId, msg.record);
    return;
  }
  if (msg.kind === "files") { renderFiles(msg); return; }
  if (msg.kind === "file") { setCode($("filepath"), shorten(msg.path)); $("fileview").textContent = msg.text; return; }
  if (msg.kind === "error") { showNotice(msg.message); return; }
}

/* ---------------- event -> transcript ---------------- */

function applyEvent(id, record) {
  const list = tx(id);
  const type = record.type;

  if (type === "message_start") {
    const m = record.message || {};
    if (m.role === "user") list.push({ role: "user", text: contentText(m.content), streaming: false });
    if (m.role === "assistant") list.push({ role: "assistant", text: "", streaming: true });
  } else if (type === "message_update") {
    const ev = record.assistantMessageEvent || {};
    const last = list[list.length - 1];
    if (ev.type === "text_delta" && last && last.role === "assistant") last.text += ev.delta;
    else if (ev.type === "text_end" && last && last.role === "assistant") last.text = ev.content ?? last.text;
  } else if (type === "message_end") {
    const m = record.message || {};
    if (m.role === "assistant") {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].role === "assistant") { list[i].text = contentText(m.content); list[i].streaming = false; break; }
      }
    }
  } else if (type === "tool_execution_start") {
    toolList(id).push({ name: record.toolName, summary: summarize(record.args) });
  } else if (type === "tool_execution_end") {
    const t = toolList(id);
    const last = t[t.length - 1];
    if (last) last.done = true;
  } else if (type === "compaction_start") {
    list.push({ role: "note", text: `compacting context (${record.reason})…` });
  } else if (type === "auto_retry_start") {
    list.push({ role: "note", text: `retry ${record.attempt}/${record.maxAttempts} after ${record.errorMessage}` });
  } else if (type === "extension_error") {
    list.push({ role: "note", text: `extension error: ${record.error}` });
  }

  if (id === activeId) renderTranscript();
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p && p.text ? p.text : "")).join("");
  }
  return "";
}

function summarize(args) {
  if (!args || typeof args !== "object") return "";
  const v = args.command || args.path || args.pattern || args.file_path || args.query;
  return v ? String(v).slice(0, 90) : "";
}

/* ---------------- rendering ---------------- */

function renderRail() {
  $("count").textContent = String(sessions.length);
  $("histcount").textContent = String(historical.length);

  const box = $("sessions");
  box.replaceChildren();
  if (sessions.length === 0) {
    const p = document.createElement("p");
    p.className = "dim small";
    p.textContent = "No live sessions.";
    box.append(p);
  }
  for (const s of sessions) {
    const card = document.createElement("div");
    card.className = `card b-${s.state}${s.id === activeId ? " active" : ""}`;

    const top = document.createElement("div");
    top.className = "top";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = s.name;
    const st = document.createElement("span");
    st.className = `state s-${s.state}`;
    st.textContent = s.state;
    top.append(nm, st);

    const cw = document.createElement("div");
    cw.className = "cw";
    cw.textContent = s.cwd;

    const sub = document.createElement("div");
    sub.className = "sub";
    const bits = [];
    if (s.model) bits.push(s.model);
    if (s.thinkingLevel) bits.push(`think:${s.thinkingLevel}`);
    if (s.contextPercent != null) bits.push(`ctx ${Math.round(s.contextPercent)}%`);
    if (s.pending) bits.push(`${s.pending} queued`);
    if (s.mode === "direct") bits.push("NO ISOLATION");
    sub.textContent = bits.join(" · ") || s.state;

    card.append(top, cw, sub);
    card.onclick = () => { activeId = s.id; renderRail(); renderWorkspace(); void loadFiles(""); };
    box.append(card);
  }

  const hbox = $("historical");
  hbox.replaceChildren();
  for (const h of historical) {
    const card = document.createElement("div");
    card.className = "card hist";
    const nm = document.createElement("div");
    nm.className = "nm";
    nm.textContent = h.firstUserText || h.id.slice(0, 8);
    const cw = document.createElement("div");
    cw.className = "cw";
    cw.textContent = h.cwd;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `${new Date(h.modifiedMs).toLocaleString()} · ${(h.bytes / 1024).toFixed(0)} KB`;
    card.append(nm, cw, sub);
    hbox.append(card);
  }
}

function renderWorkspace() {
  const s = sessions.find((x) => x.id === activeId);
  if (!s) {
    $("empty").classList.remove("hidden");
    $("workspace").classList.add("hidden");
    return;
  }
  $("empty").classList.add("hidden");
  $("workspace").classList.remove("hidden");

  $("wsname").textContent = s.name;
  const meta = [];
  meta.push(s.cwd);
  if (s.model) meta.push(`${s.provider || "?"}/${s.model}`);
  if (s.thinkingLevel) meta.push(`thinking:${s.thinkingLevel}`);
  if (s.messageCount) meta.push(`${s.messageCount} msgs`);
  if (s.tokensTotal) meta.push(`${s.tokensTotal} tok`);
  if (s.cost != null) meta.push(`$${s.cost.toFixed(4)}`);
  $("wsmeta").textContent = meta.join("  ·  ");

  const iso = $("isolation");
  iso.textContent = `isolation: ${s.isolation}`;
  iso.className = `isolation${s.mode === "direct" ? " none" : ""}`;
  $("cmdline").textContent = `$ ${s.command}`;

  const err = $("error");
  if (s.error) { err.textContent = s.error; err.classList.remove("hidden"); }
  else err.classList.add("hidden");

  renderApprovals(s);
  renderTranscript();
}

function renderApprovals(s) {
  const box = $("approvals");
  box.replaceChildren();
  for (const d of s.dialogs || []) {
    const el = document.createElement("div");
    el.className = "approval";
    const t = document.createElement("div");
    t.className = "atl";
    t.textContent = d.title || `${d.method} requested`;
    el.append(t);
    if (d.message) {
      const m = document.createElement("div");
      m.className = "amsg";
      m.textContent = d.message;
      el.append(m);
    }
    const acts = document.createElement("div");
    acts.className = "acts";

    if (d.method === "confirm") {
      acts.append(btn("Allow", () => answer(d, { confirmed: true })));
      acts.append(btn("Deny", () => answer(d, { confirmed: false })));
    } else if (d.method === "select") {
      for (const o of d.options || []) acts.append(btn(o, () => answer(d, { value: o })));
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = d.placeholder || "";
      inp.value = d.prefill || "";
      inp.style.maxWidth = "320px";
      acts.append(inp, btn("Submit", () => answer(d, { value: inp.value })));
    }
    acts.append(btn("Cancel", () => answer(d, { cancelled: true })));
    el.append(acts);
    box.append(el);
  }
}

function btn(label, onClick) {
  const b = document.createElement("button");
  b.className = "ghost";
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function answer(d, payload) {
  send({ action: "dialog", id: activeId, dialogId: d.id, answer: payload });
}

function renderTranscript() {
  const box = $("messages");
  const list = tx(activeId);
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.replaceChildren();

  if (list.length === 0) {
    const p = document.createElement("p");
    p.className = "dim";
    p.textContent = "No messages yet.";
    box.append(p);
  }

  for (const m of list) {
    const el = document.createElement("div");
    if (m.role === "note") {
      el.className = "tool";
      el.textContent = `— ${m.text}`;
      box.append(el);
      continue;
    }
    el.className = `msg ${m.role}`;
    const role = document.createElement("div");
    role.className = "role";
    role.textContent = m.role;
    const body = document.createElement("div");
    body.className = `md${m.streaming ? " streaming" : ""}`;
    setRich(body, m.text);
    el.append(role, body);
    box.append(el);
  }

  for (const t of toolList(activeId)) {
    const el = document.createElement("div");
    el.className = "tool";
    const nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = t.name;
    el.append(nm, document.createTextNode(`  ${t.done ? "✓" : "…"}  ${t.summary}`));
    box.append(el);
  }

  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ---------------- files ---------------- */

let currentDir = "";

async function loadFiles(sub) {
  currentDir = sub;
  send({ action: "files", id: activeId, path: sub });
}

function renderFiles(msg) {
  const box = $("filelist");
  box.replaceChildren();
  $("filepath").textContent = shorten(msg.path);

  if (currentDir) {
    const up = document.createElement("div");
    up.className = "frow up";
    up.textContent = "↩ ..";
    up.onclick = () => loadFiles(currentDir.split("/").slice(0, -1).join("/"));
    box.append(up);
  }
  for (const e of msg.entries) {
    const row = document.createElement("div");
    row.className = `frow${e.dir ? " dir" : ""}`;
    const ic = document.createElement("span");
    ic.className = "ic";
    ic.textContent = e.dir ? "▸" : "·";
    row.append(ic, document.createTextNode(e.name));
    row.onclick = () => {
      const next = currentDir ? `${currentDir}/${e.name}` : e.name;
      if (e.dir) loadFiles(next);
      else send({ action: "files", id: activeId, path: next });
    };
    box.append(row);
  }
}

function shorten(p) {
  const s = sessions.find((x) => x.id === activeId);
  if (s && p.startsWith(s.cwd)) return p.slice(s.cwd.length + 1) || ".";
  return p;
}

/* ---------------- controls ---------------- */

function showNotice(text) {
  const n = $("notice");
  n.textContent = text;
  n.classList.remove("hidden");
}

$("start").onclick = () => {
  const cwd = $("cwd").value.trim();
  if (!cwd) { showNotice("Enter a working directory."); return; }
  const mode = [...document.querySelectorAll('input[name="mode"]')].find((r) => r.checked).value;
  send({ action: "start", cwd, name: $("name").value.trim(), mode });
};

$("stop").onclick = () => send({ action: "stop", id: activeId });
$("abort").onclick = () => send({ action: "abort", id: activeId });

$("send").onclick = submitPrompt;
$("input").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); submitPrompt(); }
});

function submitPrompt() {
  const el = $("input");
  const text = el.value.trim();
  if (!text) return;
  send({ action: "prompt", id: activeId, message: text });
  el.value = "";
}

/* Prefill with the current working directory so the prototype is one click from useful.
 * `?cwd=` prefills the form; `?autostart=1` starts immediately; `?session=sN`
 * focuses a running session (handy for screenshots and for reloading without
 * losing your place). */
const params = new URLSearchParams(location.search);
$("cwd").value = params.get("cwd") || "";

let autostarted = false;
let wanted = params.get("session") || null;

function maybeAutostart() {
  if (wanted) {
    const target = sessions.find((s) => s.id === wanted) || sessions[sessions.length - 1];
    if (target) {
      activeId = target.id;
      renderRail();
      renderWorkspace();
      void loadFiles("");
      wanted = null;
      return;
    }
  }
  if (autostarted || params.get("autostart") !== "1") return;
  if (!params.get("cwd") || sessions.length > 0) return;
  autostarted = true;
  send({
    action: "start",
    cwd: params.get("cwd"),
    name: params.get("name") || "",
    mode: params.get("mode") === "sandboxed" ? "sandboxed" : "direct",
  });
}

connect();
setInterval(maybeAutostart, 700);
