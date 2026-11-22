/**
 * The CDP driver behind the sidecar's verbs (ADR-0015 §4).
 *
 * CDP (Chrome DevTools Protocol) is JSON over a WebSocket, and `ws` is already a shipped dependency and
 * already a WebSocket client — so this replaces Playwright with no new dependency and no new protocol.
 * Measured before it was written: `Page.navigate`, `Page.captureScreenshot`,
 * `Emulation.setDeviceMetricsOverride` and one `Runtime.evaluate` cover both verbs in about 180 lines.
 *
 * **The one rule this module exists to keep.** Every expression sent to `Runtime.evaluate` is a CONSTANT
 * defined below. None is assembled from a caller's input, and no function here accepts a method name, a
 * script, or a selector-driven assertion. `sidecar-control.ts` guarantees the shape of a verb; this module
 * guarantees that the shape has nowhere to put a script even if it did.
 *
 * What this deliberately does not do, since it is the honest cost of dropping Playwright (the ADR's stated
 * parity risk): no network-idle wait (it waits for `Page.loadEventFired`, then a bounded grace), no console
 * collection beyond what `console` check asks for, and no proven teardown beyond closing the socket and
 * killing the child. Each is named rather than implied, because "it probably works" is how a 183-line client
 * becomes a reimplementation of Playwright one bug at a time.
 */
import { WebSocket } from "ws";

export interface CdpOptions {
  /** The browser endpoint, from `DevToolsActivePort` inside the sidecar's profile. */
  url: string;
  /** How long to wait for the page to load before measuring anyway. */
  loadTimeoutMs?: number;
}

export interface Screenshot {
  /** Base64 PNG, exactly as CDP returns it. The caller writes the bytes; this never sees a path. */
  data: string;
}

export interface ProbeFinding {
  kind: "horizontal-overflow" | "vertical-overflow" | "contrast" | "console-error";
  selector: string;
  /** Pixels past the viewport for overflow; the ratio for contrast; 1 otherwise. */
  by?: number;
  detail?: string;
}

export interface ProbeVerdict {
  verdict: "ok" | "broken";
  viewport: { width: number; height: number };
  problems: ProbeFinding[];
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * A page session. One instance drives one page; `close` releases it.
 *
 * Constructed through `CdpPage.open`, which attaches to a page target — there is no public constructor, so a
 * caller cannot reach `send` and issue its own CDP method.
 */
export class CdpPage {
  #socket: WebSocket;
  #sessionId: string;
  #nextId = 1;
  #pending = new Map<number, PendingCall>();
  #loadWaiters: (() => void)[] = [];
  #consoleErrors: string[] = [];

  private constructor(socket: WebSocket, sessionId: string) {
    this.#socket = socket;
    this.#sessionId = sessionId;
    socket.on("message", (raw) => this.#onMessage(String(raw)));
  }

  static async open(options: CdpOptions): Promise<CdpPage> {
    const socket = new WebSocket(options.url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((done, fail) => {
      socket.once("open", () => done());
      socket.once("error", (error) => fail(error));
    });

    const bootstrap = await sendRaw(socket, "Target.getTargets", {});
    const targets = (bootstrap as { targetInfos?: { type: string; targetId: string }[] }).targetInfos ?? [];
    const page = targets.find((target) => target.type === "page");
    if (page === undefined) {
      socket.close();
      throw new Error("the browser exposed no page target to attach to");
    }
    const attached = await sendRaw(socket, "Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    const sessionId = (attached as { sessionId?: string }).sessionId;
    if (sessionId === undefined) {
      socket.close();
      throw new Error("the browser refused to attach to its page target");
    }

    const result = new CdpPage(socket, sessionId);
    await result.#call("Page.enable");
    await result.#call("Runtime.enable");
    return result;
  }

  #onMessage(raw: string): void {
    let message: { id?: number; method?: string; result?: unknown; error?: { message: string }; params?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "Page.loadEventFired") {
      const waiters = this.#loadWaiters;
      this.#loadWaiters = [];
      for (const waiter of waiters) waiter();
      return;
    }
    if (message.method === "Runtime.consoleAPICalled") {
      const params = message.params as { type?: string; args?: { value?: unknown }[] } | undefined;
      if (params?.type === "error") {
        const text = (params.args ?? []).map((arg) => String(arg.value ?? "")).join(" ");
        this.#consoleErrors.push(text.slice(0, 500));
      }
    }
  }

  #call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId: this.#sessionId }));
    });
  }

  /** Set the viewport. Separate from navigation so a probe measures the size it declared. */
  async setViewport(viewport: { width: number; height: number }): Promise<void> {
    await this.#call("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /** Navigate and wait for load, bounded. Bounded because a dev server that never settles must not hang. */
  async navigate(url: string, timeoutMs: number): Promise<void> {
    this.#consoleErrors = [];
    const loaded = new Promise<void>((done) => this.#loadWaiters.push(done));
    await this.#call("Page.navigate", { url });
    // A load event may have already fired between the call and the listener; the race covers that as well as
    // the timeout, and losing it is not an error -- a slow page still gets measured.
    await Promise.race([loaded, new Promise<void>((done) => setTimeout(done, timeoutMs))]);
    // A short grace for late layout: fonts and images shift boxes after loadEventFired, and measuring the
    // pre-shift layout is how a probe reports an overflow that the user never sees.
    await new Promise<void>((done) => setTimeout(done, 150));
  }

  /** The pixel. Returns bytes; the caller decides where they go (ADR-0015 §8: no path parameters). */
  async capture(clip?: { x: number; y: number; width: number; height: number }, fullPage = false): Promise<Screenshot> {
    const params: Record<string, unknown> = { format: "png" };
    if (fullPage) params["captureBeyondViewport"] = true;
    if (clip !== undefined) params["clip"] = { ...clip, scale: 1 };
    const result = (await this.#call("Page.captureScreenshot", params)) as { data?: string };
    if (typeof result.data !== "string" || result.data.length === 0) {
      throw new Error("the browser returned no screenshot data");
    }
    return { data: result.data };
  }

  /**
   * Run the fixed measurement battery and return a verdict.
   *
   * `checks` selects WHICH of the constant expressions run. It does not parameterise them: there is no
   * interpolation of caller input into `expression` anywhere in this method, which is the property a reviewer
   * should check first.
   */
  async probe(checks: readonly string[]): Promise<ProbeVerdict> {
    const problems: ProbeFinding[] = [];
    let viewport = { width: 0, height: 0 };

    if (checks.includes("overflow")) {
      const measured = await this.#evaluate(OVERFLOW_EXPRESSION);
      const value = measured as { viewport?: { width: number; height: number }; problems?: ProbeFinding[] };
      viewport = value.viewport ?? viewport;
      problems.push(...(value.problems ?? []));
    }

    if (checks.includes("contrast")) {
      const measured = await this.#evaluate(CONTRAST_EXPRESSION);
      const value = measured as { problems?: ProbeFinding[] };
      problems.push(...(value.problems ?? []));
    }

    if (checks.includes("overlap")) {
      const measured = await this.#evaluate(OVERLAP_EXPRESSION);
      const value = measured as { problems?: ProbeFinding[] };
      problems.push(...(value.problems ?? []));
    }

    if (checks.includes("console")) {
      for (const text of this.#consoleErrors.slice(0, 10)) {
        problems.push({ kind: "console-error", selector: "(page)", detail: text });
      }
    }

    if (viewport.width === 0) {
      const measured = await this.#evaluate(VIEWPORT_EXPRESSION);
      viewport = measured as { width: number; height: number };
    }

    return { verdict: problems.length === 0 ? "ok" : "broken", viewport, problems: problems.slice(0, 25) };
  }

  async #evaluate(expression: string): Promise<unknown> {
    const result = (await this.#call("Runtime.evaluate", { expression, returnByValue: true })) as {
      result?: { value?: unknown };
    };
    return result.result?.value;
  }

  /**
   * Click the first element matching a selector. The one interaction the sidecar offers.
   *
   * The selector is the only caller-controlled value that reaches a page, so how it arrives is the whole
   * design. It is passed as an **argument** to a fixed function via `Runtime.callFunctionOn`, never
   * concatenated into expression source — so a selector like `")||fetch('https://evil')`,
   * `); process.exit(1); ("` is inert text handed to `querySelector`, which either matches something or
   * throws a `SyntaxError`. Interpolating it would make this method `browser_evaluate` with a selector
   * parameter, which is precisely what ADR-0015 §2 forbids.
   *
   * The click itself is a real mouse event at the element's centre rather than `element.click()`, because a
   * synthetic `.click()` bypasses hit-testing: it fires on an element that is covered by an overlay and
   * reports success for an interaction a human could not have performed.
   */
  async click(selector: string): Promise<void> {
    const documentHandle = (await this.#call("Runtime.evaluate", {
      expression: "document",
      objectGroup: "sidecar",
    })) as { result?: { objectId?: string } };
    const objectId = documentHandle.result?.objectId;
    if (objectId === undefined) throw new Error("the page exposed no document to click in");

    const found = (await this.#call("Runtime.callFunctionOn", {
      objectId,
      // A fixed declaration. `this` is the document; the selector is `args[0]`.
      functionDeclaration: LOCATE_FUNCTION,
      arguments: [{ value: selector }],
      returnByValue: true,
    })) as { result?: { value?: { x: number; y: number } | null } };

    const point = found.result?.value;
    if (point === null || point === undefined) {
      throw new Error(`no element matched ${JSON.stringify(selector)}`);
    }

    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.#call("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
    }
    // Layout settles after an interaction; measuring immediately reports the pre-click render.
    await new Promise<void>((done) => setTimeout(done, 150));
  }

  async close(): Promise<void> {
    for (const pending of this.#pending.values()) pending.reject(new Error("the page was closed"));
    this.#pending.clear();
    this.#socket.close();
  }
}

/** Send a method on the browser connection itself, before a page session exists. */
function sendRaw(socket: WebSocket, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = 1;
    const onMessage = (raw: unknown): void => {
      const message = JSON.parse(String(raw)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id !== id) return;
      socket.off("message", onMessage);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

// --- The fixed measurements. Constants: nothing here is built from caller input. -----------------

const VIEWPORT_EXPRESSION = `({ width: window.innerWidth, height: window.innerHeight })`;

const OVERFLOW_EXPRESSION = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const out = [];
  for (const el of document.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const name = el.id ? "#" + el.id : el.tagName.toLowerCase();
    if (r.right > vw + 1) out.push({ kind: "horizontal-overflow", selector: name, by: Math.round(r.right - vw) });
    if (r.bottom > vh + 1) out.push({ kind: "vertical-overflow", selector: name, by: Math.round(r.bottom - vh) });
  }
  return { viewport: { width: vw, height: vh }, problems: out.slice(0, 10) };
})()`;

const CONTRAST_EXPRESSION = `(() => {
  const parse = (c) => {
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(c);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05); };
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.children.length > 0) continue;
    const text = (el.textContent || "").trim();
    if (text.length === 0 || text.length > 200) continue;
    const style = getComputedStyle(el);
    const fg = parse(style.color);
    const bg = parse(style.backgroundColor);
    if (!fg || !bg) continue;
    const r = ratio(fg, bg);
    const need = Number(style.fontSize.replace("px", "")) >= 24 ? 3 : 4.5;
    if (r < need) out.push({ kind: "contrast", selector: el.id ? "#" + el.id : el.tagName.toLowerCase(),
                               by: Math.round(r * 100) / 100, detail: "needs " + need + ":1" });
  }
  return { problems: out.slice(0, 10) };
})()`;

const OVERLAP_EXPRESSION = `(() => {
  const boxes = [...document.querySelectorAll("body *")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((x) => x.r.width > 0 && x.r.height > 0);
  const out = [];
  for (let i = 0; i < boxes.length && out.length < 10; i++) {
    for (let j = i + 1; j < boxes.length && out.length < 10; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const dx = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const dy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (dx <= 1 || dy <= 1) continue;
      const name = (x) => (x.el.id ? "#" + x.el.id : x.el.tagName.toLowerCase());
      out.push({ kind: "overlap", selector: name(a) + " / " + name(b) });
    }
  }
  return { problems: out };
})()`;

/**
 * Locate an element by selector and return the centre of its box, or null.
 *
 * A constant `functionDeclaration`, not an expression: `args[0]` is the only way caller input enters, and it
 * enters as a value. `scrollIntoView` first, so a click on something below the fold lands on the element
 * rather than on whatever occupies its viewport coordinates.
 */
const LOCATE_FUNCTION = `function (selector) {
  const el = this.querySelector(selector);
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}`;
