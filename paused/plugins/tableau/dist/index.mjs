import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const ORIGIN = "https://tableau.ucsd.edu";
const API = "/api/3.27";
const SECRET = "connection";
const CAPABILITY = "read";
const WRITE_CAPABILITY = "write";
const FLOW_MS = 10 * 60_000;
const SKEW_MS = 30_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TOOLS = new Set([
  "tableau.projects.list",
  "tableau.workbooks.list",
  "tableau.workbooks.get",
  "tableau.views.list",
  "tableau.views.get",
  "tableau.views.data",
  "tableau.datasources.list",
  "tableau.datasources.get",
]);
const RECONNECT = "Reconnect Tableau to continue. UCSD may reuse your current browser sign-in.";

function failure(code, message, retryable = false) {
  return Object.freeze({ _tag: "PluginFailure", code, message, retryable });
}
function record(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some((d) => !("value" in d)) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw failure("invalid_input", "Unexpected Tableau input fields.");
  }
  return value;
}
function text(value, max = 200) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !Array.from(value).some((c) => c.codePointAt(0) < 32 || c.codePointAt(0) === 127)
  );
}
function identifier(value) {
  if (typeof value !== "string" || !ID.test(value)) {
    throw failure("invalid_input", "A Tableau UUID from a previous result is required.");
  }
  return value;
}
function contextSignal(context, commit = false) {
  if (
    !(context?.signal instanceof AbortSignal) ||
    (commit && typeof context.beginCommit !== "function")
  ) {
    throw failure("invalid_context", "The Tableau host operation context is invalid.");
  }
  context.signal.throwIfAborted();
  return context.signal;
}
function sameState(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function resultError(error) {
  return {
    status: "error",
    code: error?._tag === "PluginFailure" ? error.code : "tableau_unavailable",
    message:
      error?._tag === "PluginFailure"
        ? error.message
        : "Tableau could not complete the request. Try again.",
    retryable: error?._tag === "PluginFailure" ? error.retryable : true,
  };
}
function pick(value, keys) {
  const out = {};
  for (const key of keys) {
    if (["string", "number", "boolean"].includes(typeof value?.[key])) out[key] = value[key];
  }
  return out;
}

export function createIntegrationProvider({ secrets, configuration }) {
  record(configuration, ["serverUrl", "siteContentUrl"]);
  if (
    (configuration.serverUrl ?? ORIGIN) !== ORIGIN ||
    (configuration.siteContentUrl !== undefined &&
      (typeof configuration.siteContentUrl !== "string" ||
        !/^[A-Za-z0-9_-]{0,100}$/u.test(configuration.siteContentUrl)))
  ) {
    throw failure("invalid_configuration", "Tableau must use the reviewed UCSD server and site.");
  }
  return new TableauProvider(secrets, configuration.siteContentUrl ?? "");
}

class TableauProvider {
  id = "tableau";
  #secrets;
  #site;
  #pending = null;
  #queue = Promise.resolve();
  #closed = false;
  #lifetime = new AbortController();
  #rejectedToken = null;
  #message = null;
  #changes;

  constructor(secrets, site) {
    this.#secrets = secrets;
    this.#site = site;
    this.#changes = new TableauChanges({
      request: (path, options) => this.#request(path, options),
      json: (path, options) => this.#json(path, options),
      credential: () => this.#credential(),
      usable: (c) => this.#usable(c),
      item: (kind, value) => this.#item(kind, value),
    });
  }
  #serialize(work) {
    const next = this.#queue.then(() => {
      if (this.#closed) throw failure("provider_closed", "Tableau is closed.");
      return work();
    });
    this.#queue = next.catch(() => {});
    return next;
  }
  async #credential() {
    const raw = await this.#secrets.get(SECRET);
    if (raw === null) return null;
    let c;
    try {
      c = JSON.parse(raw);
    } catch {
      throw failure("invalid_credential", "Reconnect Tableau to reset the stored connection.");
    }
    if (
      !c ||
      c.version !== 1 ||
      c.origin !== ORIGIN ||
      c.siteContentUrl !== this.#site ||
      !ID.test(c.siteId) ||
      !ID.test(c.userId) ||
      !ID.test(c.clientId) ||
      !text(c.accessToken, 8192) ||
      typeof c.refreshToken !== "string" ||
      c.refreshToken.length > 8192 ||
      !Number.isSafeInteger(c.expiresAt) ||
      !text(c.accountLabel, 256)
    ) {
      throw failure("invalid_credential", "Reconnect Tableau to reset the stored connection.");
    }
    return c;
  }
  #usable(c) {
    return c && c.expiresAt - SKEW_MS > Date.now() && c.accessToken !== this.#rejectedToken;
  }
  async #request(
    path,
    {
      signal,
      token,
      form,
      maxBytes = 1_048_576,
      timeoutMs = 20_000,
      method,
      body,
      contentType,
      requestId,
      binary = false,
    } = {},
  ) {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw failure("invalid_path", "Invalid Tableau request.");
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([
      signal ?? new AbortController().signal,
      this.#lifetime.signal,
      deadline,
    ]);
    combined.throwIfAborted();
    let response;
    try {
      response = await fetch(`${ORIGIN}${path}`, {
        method: method ?? (form ? "POST" : "GET"),
        redirect: "error",
        signal: combined,
        headers: {
          accept: "application/json",
          ...(token ? { "X-Tableau-Auth": token } : {}),
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(contentType ? { "content-type": contentType } : {}),
          ...(requestId ? { RequestID: requestId } : {}),
        },
        ...(form ? { body: new URLSearchParams(form) } : {}),
        ...(body !== undefined ? { body } : {}),
      });
    } catch {
      signal?.throwIfAborted();
      this.#lifetime.signal.throwIfAborted();
      if (deadline.aborted)
        throw failure(
          "request_timed_out",
          "Tableau took too long to prepare this result. Try narrower filters or retry later.",
          true,
        );
      throw failure("tableau_unavailable", "Tableau could not be reached. Try again.", true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) {
        if (token) this.#rejectedToken = token;
        throw failure("connection_required", RECONNECT);
      }
      if (response.status === 403)
        throw failure(
          "access_denied",
          "Your Tableau account does not have permission for this content or operation.",
        );
      if (response.status === 404)
        throw failure(
          "not_found",
          "This Tableau content was not found or is not visible to your account.",
        );
      if (response.status === 400 && form) throw failure("authorization_expired", RECONNECT);
      // Preserve explicit validation, conflict, and media-type rejections.
      // Do not infer a settled outcome from timeouts or throttling responses.
      if ([400, 409, 415].includes(response.status))
        throw failure(
          "tableau_request_rejected",
          `Tableau rejected the request (HTTP ${response.status}). Check the supplied values and content.`,
        );
      throw failure(
        "tableau_request_failed",
        `Tableau returned HTTP ${response.status}. Try again or use a narrower request.`,
        response.status === 429 || response.status >= 500,
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (declared > maxBytes) {
      await response.body?.cancel();
      throw failure(
        "response_too_large",
        "This Tableau result is too large. Narrow the filters or page size.",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) return binary ? Buffer.alloc(0) : "";
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes)
          throw failure(
            "response_too_large",
            "This Tableau result is too large. Narrow the filters or page size.",
          );
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks);
      return binary ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error?._tag === "PluginFailure") throw error;
      signal?.throwIfAborted();
      throw failure("invalid_response", "Tableau returned an incomplete or unreadable result.");
    } finally {
      reader.releaseLock();
    }
  }
  async #json(path, options) {
    const body = await this.#request(path, options);
    try {
      return JSON.parse(body);
    } catch {
      throw failure("invalid_response", "Tableau returned an unexpected response.");
    }
  }
  #tokens(value, fallbackRefresh = "") {
    if (
      !value ||
      !text(value.access_token, 8192) ||
      value.origin_host !== "tableau.ucsd.edu" ||
      !Number.isInteger(value.expires_in) ||
      value.expires_in <= 0 ||
      value.expires_in > 2_592_000 ||
      (value.refresh_token !== undefined &&
        (typeof value.refresh_token !== "string" || value.refresh_token.length > 8192))
    ) {
      throw failure("invalid_response", "Tableau returned an invalid sign-in response.");
    }
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token ?? fallbackRefresh,
      expiresAt: Date.now() + value.expires_in * 1000,
    };
  }
  async #session(tokens, clientId, signal) {
    const { session } = await this.#json(`${API}/sessions/current`, {
      token: tokens.accessToken,
      signal,
      maxBytes: 65_536,
    });
    if (
      !session ||
      !ID.test(session.site?.id) ||
      !ID.test(session.user?.id) ||
      (session.site.contentUrl ?? "") !== this.#site
    ) {
      throw failure("wrong_site", "Sign in to the configured UCSD Tableau site and reconnect.");
    }
    const userName = session.user.name;
    return {
      version: 1,
      origin: ORIGIN,
      siteContentUrl: this.#site,
      siteId: session.site.id,
      userId: session.user.id,
      clientId,
      accountLabel: text(userName, 150) ? `${userName} · UCSD Tableau` : "UCSD Tableau",
      ...tokens,
    };
  }
  async #endFlow() {
    const flow = this.#pending;
    this.#pending = null;
    if (!flow) return;
    clearTimeout(flow.timer);
    await this.#closeListener(flow);
  }
  async #closeListener(flow) {
    if (flow.closePromise) return flow.closePromise;
    flow.closePromise = new Promise((resolve) => {
      flow.server.close(resolve);
      flow.server.closeAllConnections();
    });
    return flow.closePromise;
  }
  async status(context) {
    contextSignal(context);
    if (this.#closed)
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "Tableau is closed.",
      };
    try {
      const c = await this.#credential();
      if (this.#usable(c))
        return {
          state: "connected",
          accountLabel: c.accountLabel,
          grantedCapabilities: [CAPABILITY, WRITE_CAPABILITY],
          message: "Connected with your UCSD Tableau permissions.",
        };
      return {
        state: this.#pending ? "connecting" : "not_connected",
        accountLabel: c?.accountLabel ?? null,
        grantedCapabilities: [],
        message: this.#message ?? (c ? RECONNECT : null),
      };
    } catch {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "The stored Tableau connection could not be read. Disconnect to reset it.",
      };
    }
  }
  connect(capabilities, context, submission) {
    return this.#serialize(async () => {
      const signal = contextSignal(context, true);
      if (
        submission !== undefined ||
        !Array.isArray(capabilities) ||
        capabilities.length < 1 ||
        capabilities.length > 2 ||
        new Set(capabilities).size !== capabilities.length ||
        capabilities.some((value) => ![CAPABILITY, WRITE_CAPABILITY].includes(value))
      ) {
        throw failure(
          "invalid_input",
          "Tableau requires its reviewed capabilities and browser sign-in.",
        );
      }
      const existing = await this.#credential().catch(() => null);
      if (this.#usable(existing))
        return { kind: "connected", flowId: randomUUID(), message: "Tableau is connected." };
      await this.#endFlow();
      this.#message = null;
      const flow = {
        id: randomUUID(),
        clientId: randomUUID(),
        state: randomBytes(32).toString("base64url"),
        verifier: randomBytes(48).toString("base64url"),
        expiresAt: Date.now() + FLOW_MS,
        callback: null,
        server: null,
        timer: null,
        closePromise: null,
        redirectUri: "",
      };
      const server = createServer((request, response) => {
        const reply = (status, message) => {
          response.writeHead(status, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "content-security-policy": "default-src 'none'",
            "x-content-type-options": "nosniff",
          });
          response.end(message);
        };
        if (
          !flow.redirectUri ||
          request.method !== "GET" ||
          request.headers.host !== new URL(flow.redirectUri).host ||
          (request.url?.length ?? 0) > 8192
        )
          return reply(400, "Invalid callback.");
        let url;
        try {
          url = new URL(request.url, flow.redirectUri);
        } catch {
          return reply(400, "Invalid callback.");
        }
        if (url.pathname !== "/Callback") return reply(404, "Not found.");
        if (this.#pending !== flow || flow.expiresAt <= Date.now() || flow.callback)
          return reply(410, "This sign-in has expired. Reconnect in Harness.");
        if (
          url.searchParams.getAll("state").length !== 1 ||
          !sameState(url.searchParams.get("state") ?? "", flow.state)
        )
          return reply(400, "Invalid sign-in state.");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (
          url.searchParams.getAll("code").length > 1 ||
          url.searchParams.getAll("error").length > 1 ||
          (code && error) ||
          (!text(code, 4096) && !error)
        )
          return reply(400, "Invalid sign-in response.");
        flow.callback = error ? { error: true } : { code };
        flow.expiresAt = Math.min(flow.expiresAt, Date.now() + 60_000);
        response.once("finish", () => {
          void this.#closeListener(flow);
        });
        reply(200, "Return to Harness to finish connecting Tableau. You can close this tab.");
      });
      flow.server = server;
      server.maxHeadersCount = 32;
      server.headersTimeout = 5000;
      server.requestTimeout = 5000;
      server.keepAliveTimeout = 1;
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No loopback port");
        flow.redirectUri = `http://127.0.0.1:${address.port}/Callback`;
        signal.throwIfAborted();
        this.#lifetime.signal.throwIfAborted();
        this.#pending = flow;
        flow.timer = setTimeout(() => {
          if (this.#pending === flow) {
            this.#pending = null;
            void this.#closeListener(flow);
          }
        }, FLOW_MS);
        flow.timer.unref();
        const url = new URL("/oauth2/v1/auth", ORIGIN);
        url.search = new URLSearchParams({
          client_id: flow.clientId,
          code_challenge: createHash("sha256").update(flow.verifier).digest("base64url"),
          code_challenge_method: "S256",
          response_type: "code",
          redirect_uri: flow.redirectUri,
          state: flow.state,
          device_id: randomUUID(),
          device_name: "TritonAI Harness Tableau",
          client_type: "tableau-mcp",
          target_site: this.#site,
          redirected: "true",
        }).toString();
        return {
          kind: "authorization_url",
          flowId: flow.id,
          authorizationUrl: url.toString(),
          message:
            "Continue with UCSD in a browser on the computer running Harness. Your existing campus sign-in may be reused.",
          expiresAt: new Date(flow.expiresAt).toISOString(),
          intervalSeconds: 1,
        };
      } catch {
        await this.#closeListener(flow);
        throw failure(
          "connection_failed",
          "Could not start Tableau sign-in. Try again on the computer running Harness.",
        );
      }
    });
  }
  poll(flowId, context) {
    return this.#serialize(async () => {
      contextSignal(context, true);
      const flow = this.#pending;
      if (!flow || flow.id !== flowId || flow.expiresAt <= Date.now()) {
        if (flow?.id === flowId) await this.#endFlow();
        return {
          state: "expired",
          retryAfterSeconds: null,
          message: "Tableau sign-in expired. Reconnect to try again.",
        };
      }
      if (!flow.callback)
        return { state: "pending", retryAfterSeconds: 1, message: "Waiting for UCSD sign-in." };
      if (flow.callback.error) {
        await this.#endFlow();
        return {
          state: "failed",
          retryAfterSeconds: null,
          message: "Tableau sign-in was not completed.",
        };
      }
      const code = flow.callback.code;
      const signal = await context.beginCommit();
      await this.#endFlow();
      try {
        const json = await this.#json("/oauth2/v1/token", {
          signal,
          maxBytes: 65_536,
          form: {
            grant_type: "authorization_code",
            code,
            code_verifier: flow.verifier,
            redirect_uri: flow.redirectUri,
            client_id: flow.clientId,
          },
        });
        const c = await this.#session(this.#tokens(json), flow.clientId, signal);
        signal.throwIfAborted();
        this.#lifetime.signal.throwIfAborted();
        await this.#secrets.set(SECRET, JSON.stringify(c));
        this.#rejectedToken = null;
        this.#message = null;
        return {
          state: "connected",
          retryAfterSeconds: null,
          message: "Connected to UCSD Tableau.",
        };
      } catch (error) {
        this.#message = resultError(error).message;
        return { state: "failed", retryAfterSeconds: null, message: this.#message };
      }
    });
  }
  prepare(context) {
    return this.#serialize(async () => {
      contextSignal(context, true);
      const c = await this.#credential();
      if (!c || this.#usable(c) || !c.refreshToken || c.accessToken === this.#rejectedToken) return;
      const signal = await context.beginCommit();
      try {
        const json = await this.#json("/oauth2/v1/token", {
          signal,
          maxBytes: 65_536,
          form: {
            grant_type: "refresh_token",
            client_id: c.clientId,
            refresh_token: c.refreshToken,
            site_namespace: c.siteContentUrl,
          },
        });
        const next = { ...c, ...this.#tokens(json, c.refreshToken) };
        signal.throwIfAborted();
        this.#lifetime.signal.throwIfAborted();
        await this.#secrets.set(SECRET, JSON.stringify(next));
        this.#message = null;
      } catch {
        // A rotated token may have been consumed even if the response was lost. Require
        // a new browser sign-in instead of repeatedly attempting an uncertain refresh.
        this.#rejectedToken = c.accessToken;
        this.#message = RECONNECT;
        await this.#secrets.remove(SECRET);
      }
    });
  }
  disconnect(context) {
    return this.#serialize(async () => {
      contextSignal(context, true);
      const c = await this.#credential().catch(() => null);
      const signal = await context.beginCommit();
      await this.#endFlow();
      await this.#secrets.remove(SECRET);
      this.#changes.clear();
      this.#rejectedToken = c?.accessToken ?? null;
      this.#message = null;
      if (c) {
        try {
          const response = await fetch(`${ORIGIN}${API}/auth/signout`, {
            method: "POST",
            redirect: "error",
            headers: { "X-Tableau-Auth": c.accessToken },
            signal: AbortSignal.any([signal, this.#lifetime.signal, AbortSignal.timeout(10_000)]),
          });
          await response.body?.cancel();
          if (!response.ok && response.status !== 401)
            this.#message = "Disconnected here. Tableau did not confirm ending the API session.";
        } catch {
          this.#message = "Disconnected here. Tableau did not confirm ending the API session.";
        }
      }
    });
  }
  #source(kind, value) {
    const base = this.#site ? `${ORIGIN}/#/site/${encodeURIComponent(this.#site)}` : `${ORIGIN}/#`;
    if (kind === "views" && text(value.contentUrl, 1024)) {
      const path = value.contentUrl
        .replace("/sheets/", "/")
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      return `${base}/views/${path}`;
    }
    return `${base}/explore`;
  }
  #item(kind, value) {
    const item = pick(value, [
      "id",
      "name",
      "description",
      "contentUrl",
      "createdAt",
      "updatedAt",
      "showTabs",
      "size",
      "type",
      "isCertified",
      "certificationNote",
    ]);
    for (const field of ["project", "owner", "workbook"]) {
      if (value[field]) item[field] = pick(value[field], ["id", "name"]);
    }
    if (Array.isArray(value.tags?.tag))
      item.tags = value.tags.tag.map((tag) => pick(tag, ["label"]));
    item.sourceUrl = this.#source(kind, value);
    return item;
  }
  async invoke(toolName, input, context) {
    const signal = contextSignal(context);
    if (this.#closed) throw failure("provider_closed", "Tableau is closed.");
    if (CHANGE_TOOLS.has(toolName)) {
      // Serialize plan creation and writes with disconnect/credential changes.
      if (toolName === "tableau.changes.apply")
        return this.#serialize(() => this.#changes.invoke(toolName, input, context));
      try {
        return await (toolName === "tableau.changes.prepare"
          ? this.#serialize(() => this.#changes.invoke(toolName, input, context))
          : this.#changes.invoke(toolName, input, context));
      } catch (error) {
        signal.throwIfAborted();
        return resultError(error);
      }
    }
    if (!TOOLS.has(toolName))
      throw failure("tool_not_found", "This Tableau tool is not available.");
    const [, kind, operation] = toolName.split(".");
    record(
      input,
      operation === "list"
        ? ["page", "limit", "name", ...(kind === "views" ? ["workbookId"] : [])]
        : operation === "data"
          ? ["id", "filters"]
          : ["id"],
    );
    let id,
      query = new URLSearchParams(),
      workbookId;
    if (operation === "list") {
      const page = input.page ?? 1,
        limit = input.limit ?? 25;
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw failure("invalid_input", "Use page 1–1000 and limit 1–100.");
      query.set("pageNumber", String(page));
      query.set("pageSize", String(limit));
      if (input.name !== undefined) {
        if (!text(input.name) || /[:,]/u.test(input.name))
          throw failure(
            "invalid_input",
            "Exact name must be 1–200 characters without commas or colons.",
          );
        query.set("filter", `name:eq:${input.name}`);
      }
      if (input.workbookId !== undefined) workbookId = identifier(input.workbookId);
    } else id = identifier(input.id);
    if (operation === "data" && input.filters !== undefined) {
      if (!input.filters || typeof input.filters !== "object" || Array.isArray(input.filters))
        throw failure("invalid_input", "Filters must map field names to values.");
      const fields = Object.keys(input.filters);
      if (fields.length > 10) throw failure("invalid_input", "Use at most ten view filters.");
      record(
        input.filters,
        fields.filter((f) => !["__proto__", "constructor", "prototype"].includes(f)),
      );
      for (const [field, value] of Object.entries(input.filters)) {
        if (!text(field, 128) || !text(value, 256))
          throw failure(
            "invalid_input",
            "View filters need bounded field names and string values.",
          );
        query.set(field.startsWith("vf_") ? field : `vf_${field}`, value);
      }
    }
    try {
      const c = await this.#credential();
      if (!this.#usable(c)) return { status: "connection_required", message: RECONNECT };
      const base = `${API}/sites/${identifier(c.siteId)}`;
      const options = { signal, token: c.accessToken };
      if (operation === "list") {
        const path = workbookId ? `${base}/workbooks/${workbookId}/views` : `${base}/${kind}`;
        const data = await this.#json(workbookId ? path : `${path}?${query}`, options);
        const singular = kind.slice(0, -1);
        let items = data[kind]?.[singular] ?? [];
        if (!Array.isArray(items) || items.length > (workbookId ? 1000 : (input.limit ?? 25)))
          throw failure("invalid_response", "Tableau returned an unexpected result list.");
        let pagination = data.pagination
          ? pick(data.pagination, ["pageNumber", "pageSize", "totalAvailable"])
          : null;
        if (workbookId) {
          if (input.name !== undefined) items = items.filter((v) => v.name === input.name);
          const page = input.page ?? 1,
            limit = input.limit ?? 25;
          pagination = { pageNumber: page, pageSize: limit, totalAvailable: items.length };
          items = items.slice((page - 1) * limit, page * limit);
        }
        return { status: "ok", [kind]: items.map((v) => this.#item(kind, v)), pagination };
      }
      if (operation === "data") {
        const detail = await this.#json(`${base}/views/${id}`, options);
        if (!detail.view) throw failure("invalid_response", "Tableau returned no view details.");
        const csv = await this.#request(`${base}/views/${id}/data?${query}`, {
          ...options,
          maxBytes: 524_288,
          // Rendering a cold Tableau view can take longer than metadata reads.
          timeoutMs: 90_000,
        });
        return {
          status: "ok",
          view: this.#item("views", detail.view),
          filters: input.filters ?? {},
          format: "csv",
          csv,
          coverage: "requested_worksheet_or_first_dashboard_worksheet",
          warning:
            "On UCSD's current Tableau API, a dashboard export contains only its first worksheet. Do not describe this as all dashboard data.",
          fetchedAt: new Date().toISOString(),
        };
      }
      const data = await this.#json(`${base}/${kind}/${id}`, options);
      const singular = kind.slice(0, -1);
      if (!data[singular])
        throw failure("invalid_response", "Tableau returned no content details.");
      return { status: "ok", [singular]: this.#item(kind, data[singular]) };
    } catch (error) {
      signal.throwIfAborted();
      this.#lifetime.signal.throwIfAborted();
      return resultError(error);
    }
  }
  async close() {
    this.#closed = true;
    this.#lifetime.abort();
    this.#changes.clear();
    await this.#queue;
    await this.#endFlow();
  }
}

// Native REST changes stay separate from authentication. A preview is local,
// expires after ten minutes, and is consumed once at the host commit boundary.
const CHANGE_TOOLS = new Set([
  "tableau.workbooks.download",
  "tableau.datasources.download",
  "tableau.datasources.connections",
  "tableau.jobs.get",
  "tableau.changes.prepare",
  "tableau.changes.apply",
]);
const PLAN_MS = 10 * 60_000;
const MAX_FILE = 2 * 1024 * 1024;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const xml = (value) =>
  String(value).replace(
    /[<>&"']/gu,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
function invalid(message) {
  throw failure("invalid_input", message);
}
function requiredText(value, max = 200) {
  if (!text(value, max)) invalid("A bounded nonempty string is required.");
  return value;
}
function description(value) {
  if (
    typeof value !== "string" ||
    value.length > 4000 ||
    Array.from(value).some(
      (c) => (c.codePointAt(0) < 32 && !"\n\r\t".includes(c)) || c.codePointAt(0) === 127,
    )
  )
    invalid("Descriptions must be text of at most 4000 characters.");
  return value;
}
function multipart(parts) {
  const boundary = `tritonai-${randomBytes(24).toString("hex")}`;
  const chunks = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ""}\r\nContent-Type: ${part.type}\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/mixed; boundary=${boundary}` };
}
function filePayload(file, extensions) {
  record(file, ["filename", "contentBase64"]);
  if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$/u.test(file.filename ?? ""))
    invalid("Use a plain file name without a path.");
  const extension = file.filename.split(".").at(-1).toLowerCase();
  if (!extensions.includes(extension)) invalid(`Expected a ${extensions.join(" or ")} file.`);
  if (
    typeof file.contentBase64 !== "string" ||
    file.contentBase64.length > Math.ceil(MAX_FILE / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.contentBase64)
  )
    invalid("Use canonical base64 for a file of at most 2 MiB.");
  const bytes = Buffer.from(file.contentBase64, "base64");
  if (!bytes.length || bytes.length > MAX_FILE || bytes.toString("base64") !== file.contentBase64)
    invalid("The file payload is empty, invalid, or too large.");
  // The publisher validates workbook structure. Never extract an archive or
  // resolve references on the host, and never silently add local dependencies.
  if (
    ["twbx", "tdsx"].includes(extension) &&
    (bytes.length < 2 || bytes.readUInt16LE(0) !== 0x4b50)
  )
    invalid("Packaged Tableau content must be a ZIP archive.");
  if (["twb", "tds"].includes(extension)) {
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      invalid("Tableau XML must be UTF-8.");
    }
    if (
      !new RegExp(`<${extension === "twb" ? "workbook" : "datasource"}(?:\\s|>)`, "u").test(
        source,
      ) ||
      /<!DOCTYPE|<!ENTITY/iu.test(source)
    )
      invalid("Use Tableau workbook/data-source XML without a DTD or entity declarations.");
  }
  return { filename: file.filename, extension, bytes, sha256: digest(bytes) };
}
function condition(value, depth = 0) {
  if (depth > 4) invalid("Hyper conditions are limited to four nested levels.");
  record(value, ["op", "target-col", "source-col", "const", "args"]);
  if (["and", "or"].includes(value.op)) {
    if (
      Object.keys(value).some((k) => !["op", "args"].includes(k)) ||
      !Array.isArray(value.args) ||
      !value.args.length ||
      value.args.length > 8
    )
      invalid("Logical conditions require one to eight arguments.");
    return { op: value.op, args: value.args.map((v) => condition(v, depth + 1)) };
  }
  if (
    !["eq", "neq", "gt", "lt", "gte", "lte", "is", "has"].includes(value.op) ||
    value.args !== undefined
  )
    invalid("Unsupported Hyper comparison.");
  const out = { op: value.op, "target-col": requiredText(value["target-col"], 128) };
  if ((value["source-col"] !== undefined) === (value.const !== undefined))
    invalid("Use one source column or typed constant.");
  if (value["source-col"] !== undefined) out["source-col"] = requiredText(value["source-col"], 128);
  else {
    record(value.const, ["type", "v"]);
    if (!["string", "integer", "double", "boolean", "datetime"].includes(value.const.type))
      invalid("Unsupported Hyper constant type.");
    const v = value.const.v;
    if (
      !(
        v === null ||
        typeof v === "boolean" ||
        (typeof v === "number" && Number.isFinite(v)) ||
        (typeof v === "string" && v.length <= 256)
      )
    )
      invalid("Hyper constants must be bounded scalar values.");
    out.const = { type: value.const.type, v };
  }
  return out;
}
function hyperActions(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10)
    invalid("Use one to ten Hyper actions.");
  return value.map((a) => {
    record(a, [
      "action",
      "source-schema",
      "source-table",
      "target-schema",
      "target-table",
      "condition",
    ]);
    if (!["insert", "update", "upsert", "replace", "delete"].includes(a.action))
      invalid("Unsupported Hyper action.");
    const out = { action: a.action, "target-table": requiredText(a["target-table"], 128) };
    if (a.action !== "delete" || a["source-table"] !== undefined)
      out["source-table"] = requiredText(a["source-table"], 128);
    for (const key of ["source-schema", "target-schema"])
      if (a[key] !== undefined) out[key] = requiredText(a[key], 128);
    if (["update", "upsert", "delete"].includes(a.action)) out.condition = condition(a.condition);
    else if (a.condition !== undefined) invalid("Insert/replace actions do not take a condition.");
    return out;
  });
}
function metadataFingerprint(value) {
  return digest(
    JSON.stringify({
      id: value.id,
      name: value.name,
      description: value.description ?? "",
      updatedAt: value.updatedAt ?? null,
      project: value.project?.id ?? null,
      owner: value.owner?.id ?? null,
      showTabs: value.showTabs ?? null,
      isCertified: value.isCertified ?? null,
      certificationNote: value.certificationNote ?? "",
      tags: (value.tags?.tag ?? []).map((v) => v.label).sort(),
    }),
  );
}
function jobResult(job) {
  if (!job || !ID.test(job.id))
    throw failure("invalid_response", "Tableau returned no valid job receipt.");
  const result = pick(job, [
    "id",
    "mode",
    "type",
    "createdAt",
    "startedAt",
    "completedAt",
    "progress",
    "finishCode",
  ]);
  for (const key of [
    "extractRefreshJob",
    "updateHyperJob",
    "publishWorkbookJob",
    "publishDatasourceJob",
  ])
    if (job[key]) result[key] = pick(job[key], ["id", "status"]);
  return result;
}
class TableauChanges {
  #api;
  #plans = new Map();
  constructor(api) {
    this.#api = api;
  }
  clear() {
    this.#plans.clear();
  }
  #prune() {
    for (const [id, plan] of this.#plans) if (plan.expiresAt <= Date.now()) this.#plans.delete(id);
  }
  async #target(base, resource, id, options) {
    const value = (await this.#api.json(`${base}/${resource}/${identifier(id)}`, options))[
      resource.slice(0, -1)
    ];
    if (!value || value.id !== id)
      throw failure("invalid_response", "Tableau returned an unexpected target.");
    return value;
  }
  async invoke(name, input, context) {
    contextSignal(context);
    if (
      name === "tableau.changes.apply" &&
      (context.writeApproved !== true || typeof context.beginCommit !== "function")
    )
      throw failure(
        "write_not_approved",
        "Harness must approve this Tableau write before it can run.",
      );
    const c = await this.#api.credential();
    if (!this.#api.usable(c)) throw failure("connection_required", RECONNECT);
    const base = `${API}/sites/${identifier(c.siteId)}`;
    const options = { signal: context.signal, token: c.accessToken };
    if (name === "tableau.changes.prepare") return this.#prepare(input, c, base, options);
    if (name === "tableau.changes.apply") return this.#apply(input, c, base, options, context);
    record(input, ["id"]);
    const id = identifier(input.id);
    if (name === "tableau.jobs.get") {
      const job = jobResult((await this.#api.json(`${base}/jobs/${id}`, options)).job);
      return {
        status: "ok",
        job,
        completed: Boolean(job.completedAt),
        successful: job.completedAt ? String(job.finishCode) === "0" : null,
      };
    }
    if (name === "tableau.datasources.connections") {
      const data = await this.#api.json(`${base}/datasources/${id}/connections`, options);
      const connections = data.connections?.connection ?? [];
      if (!Array.isArray(connections) || connections.length > 100)
        throw failure("invalid_response", "Unexpected Tableau connections response.");
      return {
        status: "ok",
        connections: connections.map((v) => pick(v, ["id", "type", "serverAddress", "serverPort"])),
      };
    }
    const resource = name.split(".")[1];
    const detail = await this.#target(base, resource, id, options);
    const bytes = await this.#api.request(
      `${base}/${resource}/${id}/content?includeExtract=False`,
      { ...options, binary: true, maxBytes: 350_000, timeoutMs: 90_000 },
    );
    if (!bytes.length) throw failure("invalid_response", "Tableau returned an empty file.");
    const packed = bytes.length >= 2 && bytes.readUInt16LE(0) === 0x4b50;
    const extension =
      resource === "workbooks" ? (packed ? "twbx" : "twb") : packed ? "tdsx" : "tds";
    return {
      status: "ok",
      resource: this.#api.item(resource, detail),
      filename: `${id}.${extension}`,
      contentBase64: bytes.toString("base64"),
      bytes: bytes.length,
      sha256: digest(bytes),
      includeExtract: false,
      warning:
        "Preserve this original before editing. Packaged assets and connection metadata may be present. A workbook file is not a rendered preview; validate edits in Tableau before overwriting shared content.",
    };
  }
  async #prepare(input, c, base, options) {
    record(input, [
      "operation",
      "resource",
      "id",
      "changes",
      "tags",
      "tag",
      "name",
      "projectId",
      "file",
      "actions",
      "connectionId",
    ]);
    const operation = input.operation;
    const resource = input.resource;
    if (!["workbooks", "datasources", "views"].includes(resource))
      invalid("Choose workbooks, datasources, or views.");
    const allowed = {
      update: ["id", "changes"],
      tags_add: ["id", "tags"],
      tags_remove: ["id", "tag"],
      refresh: ["id"],
      publish: ["id", "name", "projectId", "file"],
      hyper_update: ["id", "file", "actions", "connectionId"],
    }[operation];
    if (
      !allowed ||
      Object.keys(input).some((k) => !["operation", "resource", ...allowed].includes(k))
    )
      invalid("Unexpected fields for this Tableau operation.");
    if (resource === "views" && !["tags_add", "tags_remove"].includes(operation))
      invalid("Views support tag changes; publish a workbook for dashboard content changes.");
    if (operation === "hyper_update" && resource !== "datasources")
      invalid("Hyper updates require a published data source.");
    const plan = {
      operation,
      resource,
      id: input.id === undefined ? null : identifier(input.id),
      userId: c.userId,
      siteId: c.siteId,
      expiresAt: Date.now() + PLAN_MS,
      operationId: randomUUID(),
    };
    if (!plan.id && operation !== "publish") invalid("An existing resource UUID is required.");
    if (plan.id) {
      const before = await this.#target(base, resource, plan.id, options);
      plan.before = this.#api.item(resource, before);
      plan.fingerprint = metadataFingerprint(before);
      plan.name = requiredText(before.name);
      plan.projectId = before.project?.id;
    }
    if (operation === "update") {
      const keys =
        resource === "workbooks"
          ? ["name", "description", "showTabs", "projectId"]
          : ["name", "isCertified", "certificationNote", "projectId"];
      record(input.changes, keys);
      if (!Object.keys(input.changes).length) invalid("Supply at least one changed field.");
      plan.changes = {};
      for (const [key, value] of Object.entries(input.changes)) {
        if (["showTabs", "isCertified"].includes(key)) {
          if (typeof value !== "boolean") invalid("Boolean metadata must be true or false.");
          plan.changes[key] = value;
        } else if (key === "projectId") plan.changes[key] = identifier(value);
        else plan.changes[key] = key === "name" ? requiredText(value) : description(value);
      }
    } else if (operation === "tags_add") {
      if (!Array.isArray(input.tags) || !input.tags.length || input.tags.length > 20)
        invalid("Use one to twenty tags.");
      plan.tags = [...new Set(input.tags.map((t) => requiredText(t, 100)))];
    } else if (operation === "tags_remove") {
      plan.tag = requiredText(input.tag, 100);
      if (plan.tag === "." || plan.tag === "..")
        invalid("A tag label cannot be a URL dot segment.");
    } else if (operation === "publish") {
      if (plan.id && (input.name !== undefined || input.projectId !== undefined))
        invalid("Overwrite uses the existing target name/project; update metadata separately.");
      if (!plan.id) {
        plan.name = requiredText(input.name);
        plan.projectId = identifier(input.projectId);
      } else identifier(plan.projectId);
      plan.file = filePayload(
        input.file,
        resource === "workbooks" ? ["twb", "twbx"] : ["tds", "tdsx", "hyper"],
      );
    } else if (operation === "hyper_update") {
      plan.file = filePayload(input.file, ["hyper"]);
      plan.actions = hyperActions(input.actions);
      if (input.connectionId !== undefined) plan.connectionId = identifier(input.connectionId);
      const data = await this.#api.json(`${base}/datasources/${plan.id}/connections`, options);
      const connections = data.connections?.connection;
      if (!Array.isArray(connections) || !connections.length || connections.length > 100)
        throw failure(
          "unsupported_datasource",
          "Tableau did not expose a supported data-source connection.",
        );
      const chosen = plan.connectionId
        ? connections.find((v) => v.id === plan.connectionId)
        : connections.length === 1
          ? connections[0]
          : null;
      if (!chosen || chosen.type !== "hyper")
        throw failure(
          "unsupported_datasource",
          "Select a live-to-Hyper connection. This API does not update arbitrary databases or refresh-backed extracts.",
        );
      plan.connectionFingerprint = digest(
        JSON.stringify(
          connections.map((v) => pick(v, ["id", "type"])).sort((a, b) => a.id.localeCompare(b.id)),
        ),
      );
    }
    this.#prune();
    if (this.#plans.size >= 4)
      throw failure(
        "too_many_previews",
        "Apply a pending preview or wait for it to expire before preparing another.",
      );
    const preview = {
      operation,
      resource,
      target: plan.before ?? { name: plan.name, projectId: plan.projectId },
      ...(plan.changes ? { changes: plan.changes } : {}),
      ...(plan.tags ? { tags: plan.tags } : {}),
      ...(plan.tag ? { tag: plan.tag } : {}),
      ...(plan.actions ? { actions: plan.actions, connectionId: plan.connectionId ?? null } : {}),
      ...(plan.file
        ? {
            file: {
              filename: plan.file.filename,
              bytes: plan.file.bytes.length,
              sha256: plan.file.sha256,
            },
          }
        : {}),
      overwrite: operation === "publish" && Boolean(plan.id),
      warning:
        operation === "hyper_update"
          ? "This changes published rows and may affect multiple reports. Row counts cannot be predicted from the payload. Replace removes all existing target rows; deletes require a condition."
          : operation === "publish"
            ? "Publishing changes the workbook/data source and can affect its consumers. Preview and validate the file in Tableau first. Existing-target protection is a preflight check, not an atomic server lock."
            : operation === "refresh"
              ? "This queues an extract refresh. Queued does not mean completed."
              : plan.changes?.projectId
                ? "Moving content may change inherited access. Review the destination project permissions."
                : null,
    };
    plan.previewHash = digest(JSON.stringify(preview));
    const planId = randomUUID();
    options.signal.throwIfAborted();
    this.#plans.set(planId, plan);
    return {
      status: "preview",
      planId,
      previewHash: plan.previewHash,
      expiresAt: new Date(plan.expiresAt).toISOString(),
      preview,
      next: "Review this exact change, then use tableau.changes.apply with planId and previewHash under Harness write approval. No remote change has occurred.",
    };
  }
  async #apply(input, c, base, options, context) {
    record(input, ["planId", "previewHash"]);
    identifier(input.planId);
    this.#prune();
    const plan = this.#plans.get(input.planId);
    if (
      !plan ||
      plan.previewHash !== input.previewHash ||
      plan.userId !== c.userId ||
      plan.siteId !== c.siteId
    )
      throw failure(
        "preview_required",
        "Prepare a fresh preview for this account and supply its exact hash.",
      );
    if (plan.id) {
      const current = await this.#target(base, plan.resource, plan.id, options);
      if (metadataFingerprint(current) !== plan.fingerprint) {
        this.#plans.delete(input.planId);
        throw failure(
          "conflict",
          "The Tableau resource changed since the preview. Read it and prepare a new change.",
        );
      }
    }
    if (plan.connectionFingerprint) {
      const data = await this.#api.json(`${base}/datasources/${plan.id}/connections`, options);
      const connections = data.connections?.connection ?? [];
      if (
        digest(
          JSON.stringify(
            connections
              .map((v) => pick(v, ["id", "type"]))
              .sort((a, b) => a.id.localeCompare(b.id)),
          ),
        ) !== plan.connectionFingerprint
      )
        throw failure("conflict", "The data-source connections changed. Prepare a new preview.");
    }
    if (Date.now() >= plan.expiresAt) {
      this.#plans.delete(input.planId);
      throw failure("preview_required", "The preview expired. Prepare a fresh preview.");
    }
    const signal = await context.beginCommit();
    if (!(signal instanceof AbortSignal))
      throw failure("invalid_context", "Harness returned an invalid commit signal.");
    // Consume before dispatch, including uncertain outcomes. Never automatically
    // retry a publishing, refresh, or row update after a lost response.
    this.#plans.delete(input.planId);
    const committed = { ...options, signal };
    let dispatched = false;
    let stage = "change";
    try {
      if (Date.now() >= plan.expiresAt)
        throw failure("preview_required", "The preview expired. Prepare a fresh preview.");
      signal.throwIfAborted();
      const target = `${base}/${plan.resource}/${plan.id}`;
      let receipt;
      if (plan.operation === "update") {
        const fields = { ...plan.changes };
        if (fields.projectId) {
          fields.project = { id: fields.projectId };
          delete fields.projectId;
        }
        for (const key of ["showTabs", "isCertified"])
          if (fields[key] !== undefined) fields[key] = String(fields[key]);
        dispatched = true;
        receipt = await this.#api.json(target, {
          ...committed,
          method: "PUT",
          contentType: "application/json",
          body: JSON.stringify({ [plan.resource.slice(0, -1)]: fields }),
        });
      } else if (plan.operation === "tags_add") {
        dispatched = true;
        receipt = await this.#api.json(`${target}/tags`, {
          ...committed,
          method: "PUT",
          contentType: "application/json",
          body: JSON.stringify({ tags: { tag: plan.tags.map((label) => ({ label })) } }),
        });
      } else if (plan.operation === "tags_remove") {
        dispatched = true;
        await this.#api.request(`${target}/tags/${encodeURIComponent(plan.tag)}`, {
          ...committed,
          method: "DELETE",
        });
        receipt = {};
      } else if (plan.operation === "refresh") {
        dispatched = true;
        receipt = await this.#api.json(`${target}/refresh`, {
          ...committed,
          method: "POST",
          contentType: "application/xml",
          body: "<tsRequest/>",
        });
      } else if (plan.operation === "publish") {
        const singular = plan.resource.slice(0, -1);
        const request = `<tsRequest><${singular} name="${xml(plan.name)}"><project id="${xml(plan.projectId)}"/></${singular}></tsRequest>`;
        const payload = multipart([
          { name: "request_payload", type: "text/xml", content: request },
          {
            name: `tableau_${singular}`,
            filename: plan.file.filename,
            type: "application/octet-stream",
            content: plan.file.bytes,
          },
        ]);
        dispatched = true;
        receipt = await this.#api.json(
          `${base}/${plan.resource}?overwrite=${Boolean(plan.id)}&asJob=true`,
          { ...committed, method: "POST", ...payload },
        );
      } else {
        stage = "payload_upload";
        dispatched = true;
        const upload = await this.#api.json(`${base}/fileUploads`, {
          ...committed,
          method: "POST",
        });
        const uploadId = upload.fileUpload?.uploadSessionId;
        if (typeof uploadId !== "string" || !/^[A-Za-z0-9_:-]{1,200}$/u.test(uploadId))
          throw failure("invalid_response", "Tableau returned an invalid upload receipt.");
        const payload = multipart([
          { name: "request_payload", type: "text/xml", content: "" },
          {
            name: "tableau_file",
            filename: plan.file.filename,
            type: "application/octet-stream",
            content: plan.file.bytes,
          },
        ]);
        await this.#api.json(`${base}/fileUploads/${encodeURIComponent(uploadId)}?sequenceID=1`, {
          ...committed,
          method: "PUT",
          ...payload,
        });
        stage = "data_update";
        const connection = plan.connectionId ? `/connections/${plan.connectionId}` : "";
        receipt = await this.#api.json(
          `${target}${connection}/data?uploadSessionId=${encodeURIComponent(uploadId)}`,
          {
            ...committed,
            method: "PATCH",
            contentType: "application/json",
            requestId: plan.operationId,
            body: JSON.stringify({ actions: plan.actions }),
          },
        );
      }
      if (["refresh", "publish", "hyper_update"].includes(plan.operation))
        return {
          status: "queued",
          operationId: plan.operationId,
          job: jobResult(
            plan.operation === "hyper_update" ? { id: receipt["job-id"] } : receipt.job,
          ),
          message:
            "Tableau accepted an asynchronous job. Use tableau.jobs.get to verify completion.",
        };
      const singular = plan.resource.slice(0, -1);
      return {
        status: "applied",
        operationId: plan.operationId,
        operation: plan.operation,
        ...(receipt[singular]
          ? { resource: this.#api.item(plan.resource, receipt[singular]) }
          : {}),
        message:
          "Tableau acknowledged the change. Read the resource again to verify its current state.",
      };
    } catch (error) {
      const knownRejection =
        error?._tag === "PluginFailure" &&
        [
          "access_denied",
          "not_found",
          "connection_required",
          "authorization_expired",
          "tableau_request_rejected",
        ].includes(error.code);
      if (!dispatched || knownRejection)
        return { ...resultError(error), retryable: false, operationId: plan.operationId };
      if (stage === "payload_upload")
        return {
          status: "upload_incomplete",
          retryable: false,
          operationId: plan.operationId,
          message:
            "The upload did not complete; no data-update request was sent. Temporary upload data may remain in Tableau. Prepare a new preview to try again.",
        };
      return {
        status: "outcome_unknown",
        retryable: false,
        operationId: plan.operationId,
        message:
          "The request was sent but its final outcome is unconfirmed. Check the resource and Tableau jobs before preparing another write; do not retry blindly.",
      };
    }
  }
}
