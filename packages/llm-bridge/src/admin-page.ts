// The /admin page: one self-contained HTML string.
//
// Deliberately not a build artifact. The bridge is a plain tsx entrypoint with
// no bundler, and this page is a handful of buttons — adding vite to ship it
// would cost more than it's worth. Palette matches apps/web.

const STYLES = `
  :root {
    color-scheme: dark;
    --bg: #000; --panel: #0b0b0b; --line: #262626; --ink: #ededed;
    --muted: #8a8a8a; --quiet: #5f5f5f; --green: #7ee787; --cyan: #79c0ff;
    --amber: #e5c07b; --danger-ink: #ff8f9a; --violet: #b18cff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 3rem 1.5rem; background: var(--bg); color: var(--ink);
    font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 640px; }
  h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 0.25rem; }
  .sub { color: var(--quiet); margin: 0 0 2rem; }
  .card {
    border: 1px solid var(--line); background: var(--panel);
    padding: 1rem 1.1rem; margin-bottom: 0.85rem;
  }
  .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  .name { font-weight: 600; }
  .state { font-size: 0.82rem; }
  .on { color: var(--green); }
  .off { color: var(--quiet); }
  .bad { color: var(--danger-ink); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.9rem; margin: 0.7rem 0 0; font-size: 0.82rem; }
  dt { color: var(--quiet); }
  dd { margin: 0; color: var(--muted); word-break: break-all; }
  .row { display: flex; gap: 0.5rem; margin-top: 0.9rem; flex-wrap: wrap; }
  button, input {
    font: inherit; background: #121212; color: var(--ink);
    border: 1px solid var(--line); padding: 0.4rem 0.8rem;
  }
  button { cursor: pointer; }
  button:hover:not(:disabled) { border-color: #555; }
  button:disabled { opacity: 0.45; cursor: default; }
  button.primary { border-color: var(--violet); color: var(--violet); }
  button.danger { border-color: #4a1d24; color: var(--danger-ink); }
  input { flex: 1; min-width: 14rem; }
  .flow { margin-top: 0.9rem; padding-top: 0.9rem; border-top: 1px solid var(--line); }
  .flow p { margin: 0 0 0.6rem; color: var(--muted); font-size: 0.85rem; }
  .usercode {
    font-size: 1.5rem; letter-spacing: 0.22em; color: var(--amber);
    padding: 0.5rem 0; user-select: all;
  }
  a { color: var(--cyan); }
  .err { color: var(--danger-ink); font-size: 0.85rem; margin-top: 0.6rem; }
  .gate { max-width: 26rem; }
  .gate p { color: var(--muted); }
`

const SCRIPT = String.raw`
const KEY_STORE = "llm_bridge_admin_key";
let key = sessionStorage.getItem(KEY_STORE) || "";
let flows = {};    // provider -> session
let timers = {};   // provider -> interval id
const app = document.getElementById("app");

async function api(path, init) {
  const res = await fetch("/admin/api" + path, {
    ...init,
    headers: {
      ...(init && init.body ? { "content-type": "application/json" } : {}),
      authorization: "Bearer " + key,
    },
  });
  if (res.status === 401 || res.status === 403) {
    sessionStorage.removeItem(KEY_STORE);
    key = "";
    const body = await res.json().catch(() => null);
    throw new Error((body && body.error && body.error.message) || "not authorised");
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error && body.error.message) || res.status + " " + res.statusText);
  return body;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function when(ms) {
  if (!ms) return "unknown";
  const delta = ms - Date.now();
  if (delta <= 0) return "expired (refreshes on next use)";
  const mins = Math.round(delta / 60000);
  return mins < 60 ? "in " + mins + "m" : "in " + Math.round(mins / 60) + "h";
}

function renderGate(message) {
  app.innerHTML =
    '<div class="card gate"><div class="name">admin key</div>' +
    '<p>Paste a bridge API key carrying the <code>admin</code> cap.</p>' +
    '<div class="row"><input id="k" type="password" placeholder="uuid" autocomplete="off">' +
    '<button class="primary" id="go">unlock</button></div>' +
    (message ? '<div class="err">' + esc(message) + "</div>" : "") +
    "</div>";
  const input = document.getElementById("k");
  const submit = () => {
    key = input.value.trim();
    if (!key) return;
    sessionStorage.setItem(KEY_STORE, key);
    load();
  };
  document.getElementById("go").onclick = submit;
  input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
  input.focus();
}

function renderFlow(p) {
  const flow = flows[p.id];
  if (!flow) return "";
  if (flow.status === "complete") return '<div class="flow"><p class="on">signed in.</p></div>';
  if (flow.status === "error") return '<div class="flow"><p class="bad">' + esc(flow.error || "login failed") + "</p></div>";

  if (p.kind === "device") {
    return (
      '<div class="flow"><p>Open the link, enter this code, and leave this page open.</p>' +
      '<div class="usercode">' + esc(flow.userCode || "") + "</div>" +
      '<p><a href="' + esc(flow.verificationUri || "") + '" target="_blank" rel="noopener">' +
      esc(flow.verificationUri || "") + "</a> &middot; waiting&hellip;</p>" +
      '<div class="row"><button data-cancel="' + esc(p.id) + '">cancel</button></div></div>'
    );
  }

  return (
    '<div class="flow"><p>Approve in the tab that opened, then paste what it gives you back &mdash; the code, or the whole redirect URL.</p>' +
    '<div class="row"><input data-code="' + esc(p.id) + '" placeholder="code#state or full URL" autocomplete="off">' +
    '<button class="primary" data-submit="' + esc(p.id) + '"' + (flow.status === "polling" ? " disabled" : "") + ">" +
    (flow.status === "polling" ? "finishing&hellip;" : "finish") + "</button>" +
    '<button data-cancel="' + esc(p.id) + '">cancel</button></div></div>'
  );
}

function renderProviders(providers) {
  app.innerHTML =
    "<h1>llm bridge</h1><p class=\"sub\">subscription logins</p>" +
    providers
      .map((p) => {
        const state = p.error
          ? '<span class="state bad">error</span>'
          : p.connected
            ? '<span class="state on">connected</span>'
            : '<span class="state off">not connected</span>';
        const rows =
          (p.connected && p.expiresAt ? "<dt>renews</dt><dd>" + esc(when(p.expiresAt)) + "</dd>" : "") +
          (p.accountId ? "<dt>account</dt><dd>" + esc(p.accountId) + "</dd>" : "") +
          "<dt>file</dt><dd>" + esc(p.authPath) + "</dd>";
        const busy = flows[p.id] && (flows[p.id].status === "awaiting_code" || flows[p.id].status === "polling");
        return (
          '<div class="card"><div class="card-head"><span class="name">' + esc(p.name) + "</span>" + state + "</div>" +
          "<dl>" + rows + "</dl>" +
          (p.error ? '<div class="err">' + esc(p.error) + "</div>" : "") +
          '<div class="row">' +
          '<button class="primary" data-login="' + esc(p.id) + '"' + (busy ? " disabled" : "") + ">" +
          (p.connected ? "sign in again" : "sign in") + "</button>" +
          (p.connected ? '<button class="danger" data-logout="' + esc(p.id) + '">sign out</button>' : "") +
          "</div>" +
          renderFlow(p) +
          "</div>"
        );
      })
      .join("");

  app.querySelectorAll("[data-login]").forEach((b) => (b.onclick = () => login(b.dataset.login)));
  app.querySelectorAll("[data-logout]").forEach((b) => (b.onclick = () => signOut(b.dataset.logout)));
  app.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => cancel(b.dataset.cancel)));
  app.querySelectorAll("[data-submit]").forEach(
    (b) => (b.onclick = () => submitCode(b.dataset.submit, app.querySelector('[data-code="' + b.dataset.submit + '"]').value)),
  );
}

async function load(message) {
  if (!key) return renderGate(message);
  try {
    const data = await api("/providers");
    renderProviders(data.providers);
  } catch (err) {
    if (!key) return renderGate(err.message);
    app.innerHTML = '<div class="card"><div class="err">' + esc(err.message) + "</div></div>";
  }
}

async function login(provider) {
  try {
    flows[provider] = await api("/login/" + provider, { method: "POST" });
    // Anthropic hands back a URL to visit; codex hands back a code to type.
    if (flows[provider].authUrl) window.open(flows[provider].authUrl, "_blank", "noopener");
    watch(provider);
    await load();
  } catch (err) {
    flows[provider] = { status: "error", error: err.message };
    await load();
  }
}

function watch(provider) {
  clearInterval(timers[provider]);
  timers[provider] = setInterval(async () => {
    const flow = flows[provider];
    if (!flow || !flow.id) return stop(provider);
    try {
      flows[provider] = await api("/session/" + flow.id);
    } catch {
      return stop(provider);
    }
    const status = flows[provider].status;
    // Re-render on the way past to pick up the new connected state.
    if (status === "complete" || status === "error") {
      stop(provider);
      await load();
      return;
    }
    await load();
  }, 2500);
}

function stop(provider) {
  clearInterval(timers[provider]);
  delete timers[provider];
}

async function submitCode(provider, code) {
  const flow = flows[provider];
  if (!flow || !code.trim()) return;
  try {
    flows[provider] = await api("/session/" + flow.id + "/code", {
      method: "POST",
      body: JSON.stringify({ code: code.trim() }),
    });
  } catch (err) {
    flows[provider] = { ...flow, status: "error", error: err.message };
    stop(provider);
  }
  await load();
}

async function cancel(provider) {
  const flow = flows[provider];
  stop(provider);
  if (flow && flow.id) await api("/session/" + flow.id, { method: "DELETE" }).catch(() => {});
  delete flows[provider];
  await load();
}

async function signOut(provider) {
  try {
    await api("/logout/" + provider, { method: "POST" });
    delete flows[provider];
  } catch (err) {
    /* surfaced by the reload below */
  }
  await load();
}

load();
`

export function adminPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>llm bridge admin</title>
<style>${STYLES}</style>
</head>
<body>
<main id="app"></main>
<script>${SCRIPT}</script>
</body>
</html>
`
}
