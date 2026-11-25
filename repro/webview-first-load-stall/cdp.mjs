// Probes a running VS Code window's webview frames over the DevTools protocol (VS Code started with
// --remote-debugging-port): for each `vscode-webview://` frame, whether a service worker controls it, the state of its
// registration's workers, VS Code's own performance marks (`content/started`, `content/workerReady`, …), its child
// frames and the resources it loaded. That tells a page whose document was never written (the outer frame still waits
// on its service worker) from one whose script never arrived.
//
// Node's global WebSocket, no dependencies.

const EXPRESSION = `(async () => {
  const sw = navigator.serviceWorker;
  let reg;
  try { reg = sw ? await sw.getRegistration() : undefined; } catch (error) { reg = { error: String(error) }; }
  const state = (worker) => (worker ? worker.state : null);
  const url = new URL(location.href);
  return JSON.stringify({
    path: url.pathname,
    id: url.searchParams.get("id"),
    readyState: document.readyState,
    controlled: Boolean(sw && sw.controller),
    controller: state(sw && sw.controller),
    registration: reg ? (reg.error ? reg.error : { installing: state(reg.installing), waiting: state(reg.waiting), active: state(reg.active) }) : null,
    marks: performance.getEntriesByType("mark").map((m) => m.name.replace(/^webview\\//, "") + "@" + Math.round(m.startTime)),
    frames: document.querySelectorAll("iframe").length,
    scripts: document.scripts.length,
    resources: performance.getEntriesByType("resource").map((r) => ({
      name: r.name.split("?")[0].split("/").slice(-1)[0],
      ms: Math.round(r.duration),
      status: r.responseStatus,
    })),
  });
})()`;

/** In a service worker: its registration's workers, and the clients it sees (controlled or not). */
const WORKER_EXPRESSION = `(async () => {
  const state = (worker) => (worker ? worker.state : null);
  const all = await clients.matchAll({ includeUncontrolled: true, type: "all" });
  const controlled = new Set((await clients.matchAll({ type: "all" })).map((c) => c.id));
  return JSON.stringify({
    worker: true,
    installing: state(registration.installing),
    waiting: state(registration.waiting),
    active: state(registration.active),
    clients: all.map((c) => {
      const url = new URL(c.url);
      return url.pathname.split("/").slice(-1)[0] + (url.searchParams.get("id") ? "?id=" + url.searchParams.get("id") : "") + (controlled.has(c.id) ? " (controlled)" : "");
    }),
  });
})()`;

class Session {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  static open(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new Session(socket)));
      socket.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)));
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.next;
    const reply = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return reply;
  }

  close() {
    this.socket.close();
  }
}

const shortUrl = (url) => {
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get("id");
    return `${parsed.protocol}//${parsed.pathname.split("/").slice(-1)[0]}${id ? `?id=${id}` : ""}`;
  } catch {
    return url;
  }
};

async function evaluate(session, params, sessionId, expression = EXPRESSION) {
  const result = await session.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, ...params },
    sessionId,
  );
  return result.exceptionDetails ? { error: result.exceptionDetails.text } : JSON.parse(result.result.value);
}

/** Everything the window's webview frames say now; `{ error }` if the window could not be probed. */
export async function probeWebviews(port, timeoutMs = 8000, prefix = "vscode-webview:") {
  const work = (async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const session = await Session.open(browser.webSocketDebuggerUrl);
    try {
      const { targetInfos } = await session.send("Target.getTargets");
      const targets = targetInfos.map((t) => ({ type: t.type, url: shortUrl(t.url), attached: t.attached }));
      const frames = [];
      // Webview frames that are targets of their own (out-of-process iframes).
      for (const info of targetInfos.filter((t) => t.url.startsWith(prefix))) {
        try {
          const { sessionId } = await session.send("Target.attachToTarget", {
            targetId: info.targetId,
            flatten: true,
          });
          const expression = info.type === "service_worker" ? WORKER_EXPRESSION : EXPRESSION;
          frames.push({ via: info.type, ...(await evaluate(session, {}, sessionId, expression)) });
        } catch (error) {
          frames.push({ via: info.type, url: shortUrl(info.url), error: String(error.message ?? error) });
        }
      }
      // Webview frames inside the workbench page's process: an isolated world in each.
      if (!frames.some((frame) => frame.via !== "service_worker")) {
        for (const page of pages.filter((p) => p.type === "page")) {
          const { sessionId } = await session.send("Target.attachToTarget", {
            targetId: page.id,
            flatten: true,
          });
          const { frameTree } = await session.send("Page.getFrameTree", {}, sessionId);
          const walk = (node) => [node.frame, ...(node.childFrames ?? []).flatMap(walk)];
          for (const frame of walk(frameTree).filter((f) => f.url.startsWith(prefix))) {
            try {
              const { executionContextId } = await session.send(
                "Page.createIsolatedWorld",
                { frameId: frame.id, worldName: "repro-probe" },
                sessionId,
              );
              frames.push({
                via: "isolated-world",
                ...(await evaluate(session, { contextId: executionContextId }, sessionId)),
              });
            } catch (error) {
              frames.push({
                via: "isolated-world",
                url: shortUrl(frame.url),
                error: String(error.message ?? error),
              });
            }
          }
        }
      }
      return { targets, frames };
    } finally {
      session.close();
    }
  })();
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ error: `no answer in ${timeoutMs} ms` }), timeoutMs),
  );
  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}
