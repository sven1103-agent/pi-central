/**
 * CDP over a PIPE rather than a WebSocket (ADR-0018).
 *
 * ## Why the pipe, measured rather than preferred
 *
 * The WebSocket transport makes the sidecar talk to its own browser over loopback — and the sidecar's whole
 * point is that it may not use loopback except for one pinned port. Measured: with the fragment applied,
 * Chrome started and printed `DevTools listening on ws://127.0.0.1:60488/...`, and then every CDP call failed
 * because the sandbox denied the connection to its own browser. The two requirements are contradictory:
 * "reach only the dev server" and "reach the browser over TCP" cannot both hold.
 *
 * `--remote-debugging-pipe` removes the conflict at its root. CDP frames travel as NUL-delimited JSON over
 * two inherited descriptors (fd 3 to write, fd 4 to read), so there is **no port, no listening socket and no
 * `DevToolsActivePort` file** — which also removes the reason the profile had to be kept out of `/tmp`: that
 * file was a remote-control endpoint every session could read.
 *
 * The client is not a WebSocket any more; frames are NUL-separated. That is less code than the socket
 * version, not more, because the transport was never the complex part.
 */
import type { ChildProcess } from "node:child_process";

export interface PipeOptions {
  /** The browser child, spawned with `--remote-debugging-pipe`. */
  child: ChildProcess;
  /** How long to wait for one response before failing the call. */
  timeoutMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface Screenshot {
  data: string;
}

export interface ProbeFinding {
  kind: string;
  selector: string;
  by?: number;
  detail?: string;
}

export interface ProbeVerdict {
  verdict: "ok" | "broken";
  viewport: { width: number; height: number };
  problems: ProbeFinding[];
}

/** Chrome's pipe descriptors: write commands to 3, read replies from 4. */
const WRITE_FD = 3;
const READ_FD = 4;

export class CdpPage {
  #write: NodeJS.WritableStream;
  #sessionId: string | undefined;
  #nextId = 1;
  #pending = new Map<number, PendingCall>();
  #loadWaiters: (() => void)[] = [];
  #consoleErrors: string[] = [];
  #buffer = "";

  private constructor(write: NodeJS.WritableStream, read: NodeJS.ReadableStream) {
    this.#write = write;
    read.on("data", (chunk) => this.#onData(String(chunk)));
  }

  /** Attach to the page target. Throws with a stated cause, never a silent hang. */
  static async open(options: PipeOptions): Promise<CdpPage> {
    const write = options.child.stdio[WRITE_FD];
    const read = options.child.stdio[READ_FD];
    if (write === null || write === undefined || read === null || read === undefined) {
      throw new Error(
        "the browser exposes no CDP pipe on fd 3/4: it must be spawned with --remote-debugging-pipe " +
          "and two extra 'pipe' entries in stdio",
      );
    }

    const page = new CdpPage(write as NodeJS.WritableStream, read as NodeJS.ReadableStream);
    // No sessionId: the browser target owns Target.* — that is how a page session is obtained in the first place.
    const bootstrap = (await page.#send("Target.getTargets", {}, undefined, options.timeoutMs)) as {
      targetInfos?: { type: string; targetId: string }[];
    };
    const target = (bootstrap.targetInfos ?? []).find((info) => info.type === "page");
    if (target === undefined) throw new Error("the browser exposed no page target");
    const attached = (await page.#send(
      "Target.attachToTarget",
      { targetId: target.targetId, flatten: true },
      undefined,
      options.timeoutMs,
    )) as { sessionId?: string };
    page.#sessionId = attached.sessionId;
    // The caller's timeout applies to these too. They used to fall through to the 20 s default, which made a
    // bounded open() unbounded — a test that asked for 60 ms waited 20 seconds and still passed, hiding it.
    await page.#call("Page.enable", {}, options.timeoutMs);
    await page.#call("Runtime.enable", {}, options.timeoutMs);
    return page;
  }

  /**
   * Split on NUL, not on LF.
   *
   * A CDP payload can contain a newline inside a string (a page title, a verdict's message), so splitting on LF
   * would corrupt it. The separator is the protocol's own.
   */
  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf("\0")) !== -1) {
      const frame = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (frame.trim() !== "") this.#onFrame(frame);
    }
  }

  #onFrame(frame: string): void {
    let message: { id?: number; method?: string; result?: unknown; error?: { message: string }; params?: unknown };
    try {
      message = JSON.parse(frame);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
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

  /**
   * Send one command, optionally addressed to an attached session.
   *
   * **`sessionId` is a sibling of `method`, never a member of `params`.** With `flatten: true` the protocol puts
   * it in the envelope; putting it inside `params` sends the command to the BROWSER target instead, which does
   * not implement page methods — and the answer is `'Page.enable' wasn't found`, which reads like a version
   * mismatch rather than a misplaced field. Measured: that is exactly how the first pipe version failed after
   * `attachToTarget` had already succeeded.
   */
  #send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
    timeoutMs = 20_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      // A response that never comes must fail the CALL, not hang the sidecar. The socket version could hang
      // too, and a silent hang is the least diagnosable failure shape there is.
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("CDP " + method + " did not answer within " + timeoutMs + " ms"));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      const envelope = { id, method, params, ...(sessionId === undefined ? {} : { sessionId }) };
      this.#write.write(JSON.stringify(envelope) + "\0");
    });
  }

  #call(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<unknown> {
    return this.#send(method, params, this.#sessionId, timeoutMs);
  }

  async setViewport(viewport: { width: number; height: number }): Promise<void> {
    await this.#call("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async navigate(url: string, timeoutMs: number): Promise<void> {
    this.#consoleErrors = [];
    const loaded = new Promise<void>((done) => this.#loadWaiters.push(done));
    await this.#call("Page.navigate", { url });
    await Promise.race([loaded, new Promise<void>((done) => setTimeout(done, timeoutMs))]);
    // A short grace for late layout: fonts and images shift boxes after loadEventFired, and measuring the
    // pre-shift render reports an overflow the reader never sees.
    await new Promise<void>((done) => setTimeout(done, 150));
  }

  async capture(
    clip?: { x: number; y: number; width: number; height: number },
    fullPage = false,
  ): Promise<Screenshot> {
    const params: Record<string, unknown> = { format: "png" };
    if (fullPage) params["captureBeyondViewport"] = true;
    if (clip !== undefined) params["clip"] = { ...clip, scale: 1 };
    const result = (await this.#call("Page.captureScreenshot", params)) as { data?: string };
    if (typeof result.data !== "string" || result.data.length === 0) {
      throw new Error("the browser returned no screenshot data");
    }
    return { data: result.data };
  }

  /** Run the fixed measurement battery. `checks` SELECTS; it never parameterises an expression. */
  async probe(checks: readonly string[]): Promise<ProbeVerdict> {
    const problems: ProbeFinding[] = [];
    let viewport = { width: 0, height: 0 };

    if (checks.includes("overflow")) {
      const value = (await this.#call("Runtime.evaluate", {
        expression: OVERFLOW_EXPRESSION,
        returnByValue: true,
      })) as { result?: { value?: { viewport?: { width: number; height: number }; problems?: ProbeFinding[] } } };
      viewport = value.result?.value?.viewport ?? viewport;
      problems.push(...(value.result?.value?.problems ?? []));
    }
    if (checks.includes("contrast")) {
      const value = (await this.#call("Runtime.evaluate", {
        expression: CONTRAST_EXPRESSION,
        returnByValue: true,
      })) as { result?: { value?: { problems?: ProbeFinding[] } } };
      problems.push(...(value.result?.value?.problems ?? []));
    }
    if (checks.includes("overlap")) {
      const value = (await this.#call("Runtime.evaluate", {
        expression: OVERLAP_EXPRESSION,
        returnByValue: true,
      })) as { result?: { value?: { problems?: ProbeFinding[] } } };
      problems.push(...(value.result?.value?.problems ?? []));
    }
    if (checks.includes("console")) {
      for (const text of this.#consoleErrors.slice(0, 10)) {
        problems.push({ kind: "console-error", selector: "(page)", detail: text });
      }
    }
    if (viewport.width === 0) {
      const value = (await this.#call("Runtime.evaluate", {
        expression: VIEWPORT_EXPRESSION,
        returnByValue: true,
      })) as { result?: { value?: { width: number; height: number } } };
      viewport = value.result?.value ?? viewport;
    }
    return { verdict: problems.length === 0 ? "ok" : "broken", viewport, problems: problems.slice(0, 25) };
  }

  /**
   * Click the first element matching a selector.
   *
   * The selector is the only caller-controlled value that reaches a page, so how it arrives is the whole
   * design: as `args[0]` to a fixed `functionDeclaration` via `Runtime.callFunctionOn`, never concatenated into
   * expression source. `Runtime.evaluate` cannot carry an argument, which is why this is the one call needing
   * the other method — and why the socket version's click was left unwired rather than quietly interpolated.
   *
   * A real mouse event at the element's centre, not `element.click()`: a synthetic click bypasses hit-testing
   * and reports success for an interaction a human could not have performed.
   */
  async click(selector: string): Promise<void> {
    const document = (await this.#call("Runtime.evaluate", {
      expression: DOCUMENT_EXPRESSION,
      objectGroup: "sidecar",
    })) as { result?: { objectId?: string } };
    const objectId = document.result?.objectId;
    if (objectId === undefined) throw new Error("the page exposed no document to click in");

    const located = (await this.#call("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: LOCATE_FUNCTION,
      arguments: [{ value: selector }],
      returnByValue: true,
    })) as { result?: { value?: { x: number; y: number } | null } };

    const point = located.result?.value;
    if (point === null || point === undefined) {
      throw new Error("no element matched " + JSON.stringify(selector));
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
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("the page was closed"));
    }
    this.#pending.clear();
  }
}
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

/** A handle on the document, for `Runtime.callFunctionOn`. */
const DOCUMENT_EXPRESSION = `document`;
