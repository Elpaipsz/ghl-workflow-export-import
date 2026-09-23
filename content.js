// Isolated-world content script: owns the floating UI panel and performs
// the actual export/import calls, reusing the token/locationId/companyId
// that inject.js observes from the page's own traffic.

(function () {
  // Injection now happens on demand (click on the toolbar icon, see
  // background.js) instead of automatically on page load, so a second click
  // on the same tab would re-run this entire script.
  if (window.__ghlWfContentLoaded) return;
  window.__ghlWfContentLoaded = true;

  const BASE = "https://backend.leadconnectorhq.com";
  const state = { token: null, locationId: null, companyId: null };
  const netLog = []; // { ts, method, url, status, reqBody, resBody, ms }
  const NET_LOG_MAX = 500;
  let netCaptureOn = true;

  // GHL nests parts of its own UI in iframes (a different frame per
  // sub-app). This script runs in every one of them (needed so inject.js
  // can watch each frame's own traffic), but only the top-level frame
  // should ever draw the floating panel - otherwise you get a separate,
  // independently-positioned panel per iframe, popping up in odd spots.
  // Frames that aren't the top just relay what they capture upward.
  let isTop = true;
  try {
    isTop = window.top === window.self;
  } catch (e) {
    isTop = false; // cross-origin frame, can't even check - treat as non-top
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "ghl-wf-tool") return;

    if (!isTop) {
      // Not the frame that owns the panel: bubble the raw message straight
      // to the top frame (regardless of nesting depth) and stop.
      try {
        window.top.postMessage(data, "*");
      } catch (e) {}
      return;
    }

    if (data.type === "creds") {
      if (data.token) {
        state.token = data.token;
        state.tokenExp = parseJwtExp(data.token);
        const payload = parseJwtPayload(data.token);
        if (payload && payload.user_id) state.userId = payload.user_id;
      }
      if (data.tokenId) state.tokenId = data.tokenId;
      if (data.locationId) state.locationId = data.locationId;
      if (data.companyId) state.companyId = data.companyId;
      updateStatus();
    }

    if (data.type === "network-log" && netCaptureOn && enabled) {
      netLog.push(data.entry);
      if (netLog.length > NET_LOG_MAX) netLog.shift();
      renderNetLog();
    }
  });

  function authHeaders(extra) {
    return Object.assign(
      {
        authorization: state.token,
        channel: "APP",
        source: "WEB_USER",
        version: "2021-07-28",
        "content-type": "application/json",
      },
      extra || {}
    );
  }

  // The /emails/builder/* endpoints (email templates) additionally require
  // "token-id", a second, separately-rotating Firebase JWT that GHL's own
  // frontend sends alongside the normal Authorization bearer.
  function emailAuthHeaders(extra) {
    return authHeaders(Object.assign({ "token-id": state.tokenId }, extra || {}));
  }

  // Central place every network call goes through, so every failure carries
  // the same level of detail: which step, which URL, HTTP status, and the
  // raw response body GHL sent back (usually has the real reason).
  async function callApi(step, url, options) {
    appendLog(`-> [${step}] ${options && options.method ? options.method : "GET"} ${url}`);
    let res;
    try {
      res = await fetch(url, options);
    } catch (networkErr) {
      throw new StepError(step, url, null, null, `Network failure: ${networkErr.message}`, networkErr.stack);
    }
    const bodyText = await res.text().catch(() => "<could not read body>");
    let bodyJson = null;
    try {
      bodyJson = bodyText ? JSON.parse(bodyText) : null;
    } catch (e) {
      /* not json, keep raw text */
    }
    if (!res.ok) {
      throw new StepError(step, url, res.status, bodyText, `HTTP ${res.status} ${res.statusText}`);
    }
    appendLog(`<- [${step}] ${res.status} OK`);
    return bodyJson !== null ? bodyJson : bodyText;
  }

  class StepError extends Error {
    constructor(step, url, status, body, message, stack) {
      super(message);
      this.step = step;
      this.url = url;
      this.status = status;
      this.body = body;
      if (stack) this.stack = stack;
    }
    report() {
      const lines = [
        `FAILED STEP: ${this.step}`,
        `URL: ${this.url}`,
        this.status != null ? `HTTP status: ${this.status}` : null,
        this.body ? `Server response:\n${truncate(this.body, 1000)}` : null,
        `Message: ${this.message}`,
      ].filter(Boolean);
      return lines.join("\n");
    }
  }

  function truncate(str, n) {
    if (typeof str !== "string") str = JSON.stringify(str);
    return str.length > n ? str.slice(0, n) + "... (truncated)" : str;
  }

  async function exportWorkflow(workflowId) {
    if (!state.token || !state.locationId) {
      throw new StepError(
        "precheck",
        "-",
        null,
        null,
        "Haven't captured token/locationId yet. Open or save a workflow in GHL first (with the panel visible) and retry."
      );
    }
    const data = await getWorkflow(workflowId);

    // Some workflows keep the real step tree only in Firebase Storage.
    if ((!data.workflowData || !data.workflowData.templates || !data.workflowData.templates.length) && data.fileUrl) {
      try {
        appendLog(`-> [GET fileUrl] ${data.fileUrl}`);
        const fRes = await fetch(data.fileUrl);
        if (fRes.ok) {
          const fJson = await fRes.json();
          data.workflowData = fJson.workflowData || fJson;
          appendLog("<- [GET fileUrl] OK, content taken from Firebase Storage");
        } else {
          appendLog(`<- [GET fileUrl] HTTP ${fRes.status} (ignored, exported without full templates)`);
        }
      } catch (e) {
        appendLog(`<- [GET fileUrl] network failure: ${e.message} (ignored)`);
      }
    }

    // Triggers live in a separate collection, not inside the workflow doc.
    try {
      data.triggers = await getTriggers(workflowId);
    } catch (e) {
      appendLog(`(warning) couldn't read triggers, exporting without them:\n${e.report ? e.report() : e.message}`);
      data.triggers = [];
    }

    // Email steps often only reference a separate email-builder template by
    // id - embed the actual content so it survives the trip to another
    // account (see recreateEmailTemplates on import).
    const templatesForEmails = (data.workflowData && data.workflowData.templates) || [];
    await embedEmailTemplates(templatesForEmails);

    return data;
  }

  // ---- Email Builder templates (referenced by workflow "email" steps) ----
  // A workflow's email step usually doesn't carry the email's content - it
  // only stores a template_id pointing at a separate document in
  // Marketing > Emails (the "email builder"). Importing the workflow into
  // another account leaves that id dangling (the template doesn't exist
  // there), so the step shows up blank/broken. We embed the full template at
  // export time and recreate it at import time, remapping the id - same
  // pattern as remapTriggers above.
  function isEmailBuilderStep(step) {
    return !!(
      step &&
      step.attributes &&
      step.attributes.template_id &&
      step.attributes.templatesource === "email-builder"
    );
  }

  async function getEmailTemplate(templateId) {
    const meta = await callApi(
      "GET email template meta",
      `${BASE}/emails/builder/meta/${state.locationId}/${templateId}?isInternal=false`,
      { headers: emailAuthHeaders() }
    );
    const data = await callApi(
      "GET email template data",
      `${BASE}/emails/builder/data/${state.locationId}/${templateId}?isInternal=false`,
      { headers: emailAuthHeaders() }
    );
    return { meta, data };
  }

  async function embedEmailTemplates(templates) {
    for (const step of templates || []) {
      if (!isEmailBuilderStep(step)) continue;
      const templateId = step.attributes.template_id;
      try {
        appendLog(`-> Embedding email template content ${templateId}...`);
        step.attributes._embeddedEmailTemplate = await getEmailTemplate(templateId);
      } catch (e) {
        appendLog(
          `(warning) couldn't read email template ${templateId}, exporting with the ID only:\n${e.report ? e.report() : e.message}`
        );
      }
    }
  }

  // NOTE: the exact shape /emails/builder/data expects for "html"-type
  // templates (raw HTML/code) wasn't fully visible in the captured network
  // log - the save request body was truncated before the actual content
  // field. This mirrors GHL's own request as closely as observed; if a
  // recreated "html"-type template comes out empty, capture a fresh network
  // log while editing one so we can see the missing field name.
  async function createEmailTemplate(embedded) {
    const meta = embedded.meta || {};
    const type = meta.templateType === "html" ? "html" : "blank";
    const created = await callApi("POST create email template", `${BASE}/emails/builder`, {
      method: "POST",
      headers: emailAuthHeaders(),
      body: JSON.stringify({
        locationId: state.locationId,
        type,
        updatedBy: state.userId,
        title: meta.name || "Imported template",
        isPlainText: !!meta.isPlainText,
        language: "en-US",
      }),
    });
    const newId = created.id || created.redirect;

    const editorData = embedded.data && embedded.data.editorData;
    const saveBody = { locationId: state.locationId, templateId: newId, updatedBy: state.userId };
    if (type === "html") {
      saveBody.html = typeof editorData === "string" ? editorData : "";
      saveBody.dnd = { elements: [], attrs: {} };
    } else {
      saveBody.dnd = editorData && typeof editorData === "object" ? editorData : { elements: [], attrs: {} };
    }
    await callApi("POST save email template content", `${BASE}/emails/builder/data`, {
      method: "POST",
      headers: emailAuthHeaders(),
      body: JSON.stringify(saveBody),
    });

    return newId;
  }

  async function recreateEmailTemplates(templates) {
    for (const step of templates || []) {
      if (!step || !step.attributes || !step.attributes._embeddedEmailTemplate) continue;
      const embedded = step.attributes._embeddedEmailTemplate;
      try {
        appendLog(`-> Recreating email template for step "${step.name || step.id}"...`);
        const newId = await createEmailTemplate(embedded);
        step.attributes.template_id = newId;
        delete step.attributes._embeddedEmailTemplate;
        appendLog(`   New template created: ${newId}`);
      } catch (e) {
        appendLog(
          `(warning) couldn't recreate the email template for step "${step.name || step.id}", it keeps the old (broken) ID:\n${e.report ? e.report() : e.message}`
        );
      }
    }
  }

  async function getWorkflow(workflowId) {
    return callApi(
      "GET workflow",
      `${BASE}/workflow/${state.locationId}/${workflowId}`,
      { headers: authHeaders() }
    );
  }

  async function getTriggers(workflowId) {
    return callApi(
      "GET triggers",
      `${BASE}/workflow/${state.locationId}/trigger?workflowId=${workflowId}`,
      { headers: authHeaders() }
    );
  }

  // Simple Firestore-like random id, good enough as a unique id for a
  // freshly minted trigger the server hasn't seen before.
  function genId(len) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < (len || 20); i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  // Takes the triggers copied from the source workflow and points every
  // reference (its own id, location_id, and the workflow_id each action
  // targets) at the freshly created destination workflow.
  function remapTriggers(triggers, newWorkflowId) {
    return (triggers || []).map((t) => {
      const copy = Object.assign({}, t);
      copy.id = genId();
      copy.location_id = state.locationId;
      copy.workflow_id = newWorkflowId;
      copy.date_added = new Date().toISOString();
      copy.date_updated = new Date().toISOString();
      if (Array.isArray(copy.actions)) {
        copy.actions = copy.actions.map((a) =>
          a && a.type === "add_to_workflow" ? Object.assign({}, a, { workflow_id: newWorkflowId }) : a
        );
      }
      return copy;
    });
  }

  async function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function createEmptyWorkflow(name) {
    return callApi("POST create workflow", `${BASE}/workflow/${state.locationId}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        name: name || `Import ${Date.now()}`,
        status: "draft",
        parentId: null,
        meta: {},
        modifiedSteps: [],
        workflowData: { templates: [] },
        deletedSteps: [],
        createdSteps: [],
        senderAddress: {},
        stopOnResponse: false,
        allowMultiple: true,
        allowMultipleOpportunity: true,
        autoMarkAsRead: false,
        eventStartDate: "",
        timezone: "account",
        triggersChanged: false,
        company_id: state.companyId,
        company_age: 0,
      }),
    }); // { id, assetWarnings }
  }

  async function saveWorkflowContent(workflowId, sourceJson) {
    const templates =
      (sourceJson.workflowData && sourceJson.workflowData.templates) ||
      sourceJson.templates ||
      [];

    // GHL checks optimistic-concurrency fields (version/dataVersion) on
    // auto-save: they must match what the server currently has for this
    // workflow, or it rejects with 422 "Your version is outdated". So we
    // read the just-created doc back and build the save payload from it,
    // only swapping in the imported templates - instead of guessing values.
    appendLog("Reading the workflow's current state to avoid clashing with version control...");
    const current = await getWorkflow(workflowId);

    const sourceTriggers = sourceJson.triggers || sourceJson.newTriggers || [];
    const newTriggers = remapTriggers(sourceTriggers, workflowId);
    if (newTriggers.length) appendLog(`Copying ${newTriggers.length} trigger(s)...`);

    const body = Object.assign({}, current, {
      _id: workflowId,
      id: workflowId,
      locationId: state.locationId,
      companyId: state.companyId,
      workflowData: { templates },
      scheduledPauseDates: current.scheduledPauseDates || [],
      modifiedSteps: [],
      deletedSteps: [],
      createdSteps: [],
      triggersChanged: newTriggers.length > 0,
      oldTriggers: [],
      newTriggers,
      isAutoSave: true,
    });
    // fileUrl/filePath describe where the OLD content lives - remove them so
    // the server doesn't try to reuse stale Firebase Storage content.
    delete body.fileUrl;
    delete body.filePath;

    return callApi(
      "PUT auto-save (write content)",
      `${BASE}/workflow/${state.locationId}/${workflowId}/auto-save`,
      { method: "PUT", headers: authHeaders(), body: JSON.stringify(body) }
    );
  }

  async function validateAssets(templates, triggers) {
    try {
      return await callApi("POST validate-assets", `${BASE}/workflow/${state.locationId}/validate-assets`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ templates: templates || [], triggers: triggers || [], companyId: state.companyId }),
      });
    } catch (e) {
      // Non-fatal: log it but let the import continue.
      appendLog(`(warning) validate-assets failed, continuing anyway:\n${e.report ? e.report() : e.message}`);
      return null;
    }
  }

  // Fetches every workflow visible in this location (published + draft),
  // paginating through the list endpoint, so bulk export doesn't need the
  // user to pick IDs one by one.
  async function getAllWorkflows(onProgress) {
    if (!state.token || !state.locationId) {
      throw new StepError("precheck", "-", null, null, "Haven't captured token/locationId yet. Open the Workflows section in GHL first.");
    }
    const statuses = ["published", "draft"];
    const seen = new Set();
    const all = [];
    const limit = 100;
    for (const status of statuses) {
      let offset = 0;
      for (;;) {
        onProgress && onProgress(`Listing workflows (${status}, from ${offset})...`);
        const res = await callApi(
          `GET workflow list (${status})`,
          `${BASE}/workflow/${state.locationId}/list?status=${status}&sortBy=name&sortOrder=asc&search=&limit=${limit}&offset=${offset}`,
          { headers: authHeaders() }
        );
        const rows = res.rows || [];
        for (const r of rows) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            all.push(r);
          }
        }
        offset += limit;
        if (rows.length < limit) break;
      }
    }
    return all;
  }

  // Exports every workflow in the location into one array. Tolerant of
  // per-workflow failures - a broken one is logged and skipped, not fatal
  // for the rest of the batch.
  async function exportAllWorkflows(nameFilter) {
    const list = await getAllWorkflows(appendLog);
    const filtered = nameFilter
      ? list.filter((w) => (w.name || "").toLowerCase().includes(nameFilter.toLowerCase()))
      : list;
    appendLog(`Found ${filtered.length} workflow(s) to export (out of ${list.length} total in the account).`);

    const results = [];
    let failed = 0;
    for (const wf of filtered) {
      try {
        appendLog(`-> Exporting "${wf.name}" (${wf.id})...`);
        const data = await exportWorkflow(wf.id);
        results.push(data);
      } catch (e) {
        appendLog(`   FAILED "${wf.name}":\n${e.report ? e.report() : e.message}`);
        failed++;
      }
    }
    appendLog(`DONE. ${results.length} exported, ${failed} failed out of ${filtered.length}.`);
    return results;
  }

  async function importOneWorkflow(json) {
    const templates = (json.workflowData && json.workflowData.templates) || json.templates || [];
    const triggers = json.triggers || json.newTriggers || [];

    appendLog("Validating referenced assets (tags/custom fields/etc)...");
    const warnings = await validateAssets(templates, triggers);

    appendLog("Recreating referenced email templates (if any)...");
    await recreateEmailTemplates(templates);

    appendLog("Creating empty workflow in destination...");
    const created = await createEmptyWorkflow(json.name ? `${json.name} (import)` : undefined);

    appendLog(`Workflow created: ${created.id}. Writing content...`);
    await saveWorkflowContent(created.id, json);

    return { id: created.id, warnings };
  }

  // Accepts either a single exported workflow (an object) or a bulk export
  // (an array of them) and imports every one, continuing past individual
  // failures so one bad workflow doesn't abort the whole batch.
  async function importWorkflowFile(file) {
    let json;
    try {
      const text = await file.text();
      json = JSON.parse(text);
    } catch (e) {
      throw new StepError("read file", file.name, null, null, `File is not valid JSON: ${e.message}`, e.stack);
    }

    const list = Array.isArray(json) ? json : [json];
    if (list.length > 1) appendLog(`Importing ${list.length} workflow(s)...`);

    let ok = 0;
    let failed = 0;
    for (const wfJson of list) {
      try {
        appendLog(`\n=== Workflow "${wfJson.name || "(unnamed)"}" ===`);
        const { id, warnings } = await importOneWorkflow(wfJson);
        appendLog(
          `DONE. Workflow created as draft: ${id}` +
            (warnings && warnings.length ? `\nMissing-asset warnings: ${JSON.stringify(warnings)}` : "\nNo missing-asset warnings.")
        );
        ok++;
      } catch (e) {
        appendLog(`FAILED "${wfJson.name || "(unnamed)"}":\n${e.report ? e.report() : e.message}`);
        failed++;
      }
    }
    if (list.length > 1) appendLog(`\nTOTAL: ${ok} created, ${failed} failed out of ${list.length}.`);
  }

  // ---- WhatsApp templates ----
  // Discovered via the live network capture (no public API for this):
  //   GET  /phone-system/whatsapp/location/{locationId}/template  -> list
  //   POST /phone-system/whatsapp/location/{locationId}/template  -> create (201, status:"PENDING")

  async function getWhatsappTemplates() {
    if (!state.token || !state.locationId) {
      throw new StepError("precheck", "-", null, null, "Haven't captured token/locationId yet. Interact with GHL first.");
    }
    return callApi("GET whatsapp templates", `${BASE}/phone-system/whatsapp/location/${state.locationId}/template`, {
      headers: authHeaders(),
    });
  }

  // Strips a template object (as returned by GET, which includes server-side
  // fields like id/status/whatsAppBusinessAccountId/createdAt/etc) down to
  // just what the create endpoint accepts.
  function buildTemplateCreatePayload(t) {
    const components = (t.components || []).map((c) => {
      const clean = { type: c.type, text: c.text, customVariables: c.customVariables || [] };
      if (c.format) clean.format = c.format;
      if (Array.isArray(c.buttons)) {
        clean.buttons = c.buttons.map((b) => {
          const bb = { type: b.type, text: b.text };
          if (b.url) bb.url = b.url;
          if (b.isTriggerLink) bb.isTriggerLink = b.isTriggerLink;
          return bb;
        });
      }
      return clean;
    });
    return {
      cta_url_link_tracking_opted_out: true,
      name: t.name,
      language: t.language,
      category: t.category,
      components,
    };
  }

  async function createWhatsappTemplate(templateObj) {
    const payload = buildTemplateCreatePayload(templateObj);
    return callApi("POST create WhatsApp template", `${BASE}/phone-system/whatsapp/location/${state.locationId}/template`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
  }

  async function exportWhatsappTemplates(onlyName) {
    const all = await getWhatsappTemplates();
    if (!onlyName) return all;
    const match = all.find((t) => t.name === onlyName);
    if (!match) throw new StepError("filter template", "-", null, null, `Couldn't find a template named "${onlyName}" in this account.`);
    return [match];
  }

  async function importWhatsappTemplatesFile(file) {
    let json;
    try {
      const text = await file.text();
      json = JSON.parse(text);
    } catch (e) {
      throw new StepError("read file", file.name, null, null, `File is not valid JSON: ${e.message}`, e.stack);
    }
    const list = Array.isArray(json) ? json : [json];
    appendLog(`Importing ${list.length} WhatsApp template(s)...`);

    let ok = 0;
    let failed = 0;
    for (const t of list) {
      try {
        appendLog(`-> Creating template "${t.name}"...`);
        const res = await createWhatsappTemplate(t);
        appendLog(`   OK: "${t.name}" -> id ${res.id}, status ${res.status} (pending Meta approval)`);
        ok++;
      } catch (e) {
        appendLog(`   FAILED "${t.name}":\n${e.report ? e.report() : e.message}`);
        failed++;
      }
    }
    appendLog(`DONE. ${ok} created, ${failed} failed out of ${list.length} total.`);
  }

  // ---- UI ----
  let panel, toggleBtn, statusEl, logEl, logLines = [];
  const ENABLED_KEY = "ghlwf_enabled";
  let enabled = true;
  try {
    const saved = localStorage.getItem(ENABLED_KEY);
    if (saved !== null) enabled = saved === "1";
  } catch (e) {}

  function injectStyles() {
    if (document.getElementById("ghlwf-styles")) return;
    const style = document.createElement("style");
    style.id = "ghlwf-styles";
    style.textContent = `
      #ghlwf-panel {
        position: fixed; top: 12px; right: 12px; z-index: 999999;
        width: 380px; max-height: 92vh;
        background: #15181f; color: #e6e6e6;
        font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.55);
        border: 1px solid #262b36; overflow: hidden;
      }
      #ghlwf-header {
        display: flex; justify-content: space-between; align-items: center;
        cursor: move; user-select: none; padding: 10px 12px;
        background: linear-gradient(135deg, #1f2937, #161a22);
        border-bottom: 1px solid #262b36;
      }
      #ghlwf-header .ghlwf-title { font-weight: 700; font-size: 12.5px; letter-spacing: .2px; }
      #ghlwf-min {
        background: #262b36; color: #cbd5e1; border: none; border-radius: 6px;
        width: 22px; height: 22px; cursor: pointer; font-size: 13px; line-height: 1;
      }
      #ghlwf-min:hover { background: #333a48; }
      #ghlwf-body { padding: 12px; max-height: calc(92vh - 44px); overflow-y: auto; }
      #ghlwf-body::-webkit-scrollbar { width: 8px; }
      #ghlwf-body::-webkit-scrollbar-thumb { background: #2a2f3a; border-radius: 4px; }
      .ghlwf-lead { color: #8a93a6; margin-bottom: 10px; font-size: 11.5px; }
      #ghlwf-status {
        margin-bottom: 12px; padding: 6px 8px; border-radius: 6px;
        background: #10251a; font-size: 11.5px; font-weight: 600;
      }
      .ghlwf-section { border-top: 1px solid #262b36; padding-top: 10px; margin-bottom: 12px; }
      .ghlwf-section-title {
        font-weight: 700; color: #7cc4ff; margin-bottom: 6px; font-size: 12.5px;
        display: flex; align-items: center; gap: 6px;
      }
      .ghlwf-section-title .ghlwf-badge {
        background: #1c3a57; color: #7cc4ff; border-radius: 999px;
        width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center;
        font-size: 10.5px; font-weight: 700;
      }
      .ghlwf-hint { color: #9aa3b2; margin-bottom: 8px; font-size: 11px; line-height: 1.5; }
      .ghlwf-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
      .ghlwf-input {
        flex: 1; font: 11px monospace; padding: 6px 8px; border-radius: 6px;
        border: 1px solid #2a2f3a; background: #0f1218; color: #e6e6e6;
      }
      .ghlwf-input:focus { outline: none; border-color: #3b82f6; }
      .ghlwf-btn {
        background: #3b82f6; color: #fff; border: none; border-radius: 6px;
        padding: 6px 12px; font-size: 11.5px; font-weight: 600; cursor: pointer; white-space: nowrap;
      }
      .ghlwf-btn:hover { background: #2f6fd6; }
      .ghlwf-btn-ghost {
        background: transparent; color: #9aa3b2; border: 1px solid #2a2f3a; border-radius: 6px;
        padding: 4px 8px; font-size: 10.5px; cursor: pointer;
      }
      .ghlwf-btn-ghost:hover { background: #1b1f28; color: #cbd5e1; }
      details.ghlwf-section summary {
        font-weight: 700; color: #f5c26b; cursor: pointer; font-size: 12.5px; list-style: none;
      }
      details.ghlwf-section summary::-webkit-details-marker { display: none; }
      details.ghlwf-section summary:before { content: "▸ "; }
      details.ghlwf-section[open] summary:before { content: "▾ "; }
      .ghlwf-netlog, #ghlwf-log {
        border: 1px solid #262b36; border-radius: 6px; padding: 6px;
        background: #0f1218;
      }
      .ghlwf-footer-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
      .ghlwf-footer-row > span { color: #6b7280; font-size: 11px; }
      #ghlwf-toggle {
        position: fixed; z-index: 999998; bottom: 16px; right: 16px;
        display: flex; align-items: center; gap: 6px;
        background: #15181f; color: #cbd5e1; border: 1px solid #262b36;
        border-radius: 999px; padding: 6px 12px 6px 10px; cursor: pointer;
        font: 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 4px 14px rgba(0,0,0,.45); user-select: none;
      }
      #ghlwf-toggle .ghlwf-dot { width: 8px; height: 8px; border-radius: 50%; background: #4b5563; }
      #ghlwf-toggle.on .ghlwf-dot { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
      #ghlwf-toggle:hover { border-color: #3b3f4a; }
    `;
    document.documentElement.appendChild(style);
  }

  function buildToggleButton() {
    toggleBtn = document.createElement("div");
    toggleBtn.id = "ghlwf-toggle";
    toggleBtn.innerHTML = `<span class="ghlwf-dot"></span><span id="ghlwf-toggle-label"></span>`;
    document.documentElement.appendChild(toggleBtn);
    toggleBtn.addEventListener("click", () => {
      enabled = !enabled;
      try {
        localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
      } catch (e) {}
      applyEnabledState();
    });
    applyEnabledState();
  }

  function applyEnabledState() {
    if (toggleBtn) {
      toggleBtn.classList.toggle("on", enabled);
      toggleBtn.querySelector("#ghlwf-toggle-label").textContent = enabled ? "GHL Tool: on" : "GHL Tool: off";
    }
    if (panel) panel.style.display = enabled ? "" : "none";
  }

  function buildPanel() {
    injectStyles();
    buildToggleButton();

    panel = document.createElement("div");
    panel.id = "ghlwf-panel";

    panel.innerHTML = `
      <div id="ghlwf-header">
        <span class="ghlwf-title">GHL Workflow Import/Export</span>
        <button id="ghlwf-min" title="Minimize / restore">–</button>
      </div>
      <div id="ghlwf-body">
      <div class="ghlwf-lead">Uses your current session · drag from the title bar</div>
      <div id="ghlwf-status"></div>

      <div class="ghlwf-section">
        <div class="ghlwf-section-title"><span class="ghlwf-badge">1</span> Export workflow</div>
        <div class="ghlwf-hint">
          Use this <b>from the source account</b>, once you have the workflow
          you want to copy. Open that workflow in the GHL editor (so the tool
          detects its ID by itself), or paste the ID manually. Downloads a
          .json file with the full content.
        </div>
        <div class="ghlwf-row">
          <input id="ghlwf-wfid" class="ghlwf-input" placeholder="workflowId (optional if already open)" />
          <button id="ghlwf-export" class="ghlwf-btn">Export</button>
        </div>
        <div class="ghlwf-hint" style="margin-top:8px">
          <b>Bulk</b>: pulls every workflow in this account (or those matching
          a text in the name) into a single .json file.
        </div>
        <div class="ghlwf-row">
          <input id="ghlwf-wf-filter" class="ghlwf-input" placeholder="name filter (optional, empty = all)" />
          <button id="ghlwf-export-all" class="ghlwf-btn">Export ALL</button>
        </div>
      </div>

      <div class="ghlwf-section">
        <div class="ghlwf-section-title"><span class="ghlwf-badge">2</span> Import workflow</div>
        <div class="ghlwf-hint">
          Use this <b>from the destination account/sub-account</b>, with the
          GHL Workflows page open (so the extension has your session from
          there). Pick the .json exported in step 1 and it creates the
          workflow as a <b>draft</b> (review it and publish it yourself in
          GHL).
        </div>
        <div class="ghlwf-row">
          <input id="ghlwf-file" type="file" accept="application/json" />
          <button id="ghlwf-import" class="ghlwf-btn">Import</button>
        </div>
      </div>

      <div class="ghlwf-section">
        <div class="ghlwf-section-title"><span class="ghlwf-badge">3</span> WhatsApp templates</div>
        <div class="ghlwf-hint">
          <b>Export</b>: from the source account, leave the field empty to
          pull ALL templates, or type an exact name to pull just that one.
          <b>Import</b>: from the destination account, upload the .json and
          it creates each template via Meta's API - they land in
          <b>PENDING</b> status, Meta's approval can take hours and is out of
          our control.
        </div>
        <div class="ghlwf-row">
          <input id="ghlwf-wa-name" class="ghlwf-input" placeholder="leave empty = ALL, or exact name of one" />
          <button id="ghlwf-wa-export" class="ghlwf-btn">Export</button>
        </div>
        <div class="ghlwf-row">
          <input id="ghlwf-wa-file" type="file" accept="application/json" />
          <button id="ghlwf-wa-import" class="ghlwf-btn">Import</button>
        </div>
      </div>

      <details class="ghlwf-section">
        <summary>4. Live network capture (to discover new endpoints)</summary>
        <div class="ghlwf-hint" style="margin-top:6px">
          With this open, every call GHL makes to its own backend gets logged
          here automatically - method, URL, what was sent and what it
          replied. Use it when you want to capture, for example, how a
          WhatsApp template gets created: leave it on and then create the
          template normally in GHL. No need to open DevTools.
        </div>
        <div class="ghlwf-row">
          <label style="display:flex;align-items:center;gap:4px;color:#9aa3b2">
            <input id="ghlwf-net-on" type="checkbox" checked /> Capturing
          </label>
          <input id="ghlwf-net-filter" class="ghlwf-input" placeholder="filter by text in the URL (e.g.: template)" />
        </div>
        <div class="ghlwf-row">
          <button id="ghlwf-net-download" class="ghlwf-btn">Download log (.json)</button>
          <button id="ghlwf-net-clear" class="ghlwf-btn-ghost">Clear capture</button>
          <span id="ghlwf-net-count" style="color:#6b7280;font-size:11px;margin-left:auto"></span>
        </div>
        <div id="ghlwf-netlog" class="ghlwf-netlog" style="max-height:220px;overflow:auto"></div>
      </details>

      <div class="ghlwf-footer-row">
        <span>Status / result:</span>
        <div>
          <button id="ghlwf-copy" class="ghlwf-btn-ghost">Copy log</button>
          <button id="ghlwf-clear" class="ghlwf-btn-ghost">Clear</button>
        </div>
      </div>
      <pre id="ghlwf-log" style="white-space:pre-wrap;max-height:160px;overflow:auto;margin:0;color:#ccc"></pre>
      </div>
    `;
    document.documentElement.appendChild(panel);
    restorePanelPosition();
    setupDragAndMinimize();
    applyEnabledState();

    statusEl = panel.querySelector("#ghlwf-status");
    logEl = panel.querySelector("#ghlwf-log");
    updateStatus();
    renderNetLog();
    appendLog("Ready to use. Follow the instructions in each step above.");

    panel.querySelector("#ghlwf-export").addEventListener("click", async () => {
      const id = panel.querySelector("#ghlwf-wfid").value.trim() || guessWorkflowIdFromUrl();
      if (!id) return appendLog("ERROR: enter a workflowId (or open that workflow in the editor first).");
      try {
        appendLog(`Exporting workflow ${id}...`);
        const data = await exportWorkflow(id);
        await downloadJson(data, `${data.name || id}.json`);
        appendLog(`DONE. Exported: ${data.name || id}.json`);
      } catch (e) {
        reportError(e);
      }
    });

    panel.querySelector("#ghlwf-export-all").addEventListener("click", async () => {
      const filter = panel.querySelector("#ghlwf-wf-filter").value.trim();
      try {
        appendLog(filter ? `Exporting workflows containing "${filter}"...` : "Exporting ALL workflows in this account...");
        const data = await exportAllWorkflows(filter || null);
        if (!data.length) return appendLog("Nothing exported (0 workflows found or all failed).");
        await downloadJson(data, `workflows-bulk-export-${Date.now()}.json`);
        appendLog(`Downloaded a file with ${data.length} workflow(s).`);
      } catch (e) {
        reportError(e);
      }
    });

    panel.querySelector("#ghlwf-import").addEventListener("click", async () => {
      const fileInput = panel.querySelector("#ghlwf-file");
      const file = fileInput.files[0];
      if (!file) return appendLog("ERROR: choose a .json file first");
      try {
        await importWorkflowFile(file);
      } catch (e) {
        reportError(e);
      }
    });

    panel.querySelector("#ghlwf-wa-export").addEventListener("click", async () => {
      const name = panel.querySelector("#ghlwf-wa-name").value.trim();
      try {
        appendLog(name ? `Exporting template "${name}"...` : "Exporting ALL WhatsApp templates...");
        const data = await exportWhatsappTemplates(name || null);
        await downloadJson(data, name ? `${name}.json` : `whatsapp-templates-${Date.now()}.json`);
        appendLog(`DONE. Exported ${data.length} template(s).`);
      } catch (e) {
        reportError(e);
      }
    });

    panel.querySelector("#ghlwf-wa-import").addEventListener("click", async () => {
      const fileInput = panel.querySelector("#ghlwf-wa-file");
      const file = fileInput.files[0];
      if (!file) return appendLog("ERROR: choose a .json file first");
      try {
        await importWhatsappTemplatesFile(file);
      } catch (e) {
        reportError(e);
      }
    });

    panel.querySelector("#ghlwf-copy").addEventListener("click", () => {
      navigator.clipboard
        .writeText(logLines.join("\n"))
        .then(() => appendLog("(log copied to clipboard)"))
        .catch((e) => appendLog("Couldn't copy: " + e.message));
    });

    panel.querySelector("#ghlwf-net-on").addEventListener("change", (e) => {
      netCaptureOn = e.target.checked;
    });
    panel.querySelector("#ghlwf-net-filter").addEventListener("input", renderNetLog);
    panel.querySelector("#ghlwf-net-download").addEventListener("click", () => {
      downloadJson(netLog, `ghl-network-log-${Date.now()}.json`);
    });
    panel.querySelector("#ghlwf-net-clear").addEventListener("click", () => {
      netLog.length = 0;
      renderNetLog();
    });

    panel.querySelector("#ghlwf-clear").addEventListener("click", () => {
      logLines = [];
      logEl.textContent = "";
    });
  }

  const POS_KEY = "ghlwf_panel_pos";

  function restorePanelPosition() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    } catch (e) {}
    if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
      panel.style.left = saved.left + "px";
      panel.style.top = saved.top + "px";
      panel.style.right = "auto";
    }
    if (saved && saved.collapsed) {
      setCollapsed(true);
    }
  }

  function savePanelPosition() {
    try {
      const rect = panel.getBoundingClientRect();
      const collapsed = panel.querySelector("#ghlwf-body").style.display === "none";
      localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top, collapsed }));
    } catch (e) {}
  }

  function setCollapsed(collapsed) {
    const body = panel.querySelector("#ghlwf-body");
    const btn = panel.querySelector("#ghlwf-min");
    body.style.display = collapsed ? "none" : "block";
    btn.textContent = collapsed ? "▢" : "–";
  }

  function setupDragAndMinimize() {
    const header = panel.querySelector("#ghlwf-header");
    const minBtn = panel.querySelector("#ghlwf-min");
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    header.addEventListener("mousedown", (e) => {
      if (e.target === minBtn) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      panel.style.right = "auto"; // switch to free left/top positioning
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const maxLeft = window.innerWidth - 40;
      const maxTop = window.innerHeight - 30;
      const left = Math.min(Math.max(0, e.clientX - offsetX), maxLeft);
      const top = Math.min(Math.max(0, e.clientY - offsetY), maxTop);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    });

    document.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        savePanelPosition();
      }
    });

    minBtn.addEventListener("click", () => {
      const body = panel.querySelector("#ghlwf-body");
      const nowCollapsed = body.style.display !== "none";
      setCollapsed(nowCollapsed);
      savePanelPosition();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderNetLog() {
    if (!panel) return;
    const container = panel.querySelector("#ghlwf-netlog");
    const countEl = panel.querySelector("#ghlwf-net-count");
    const filterInput = panel.querySelector("#ghlwf-net-filter");
    const filter = (filterInput && filterInput.value.trim().toLowerCase()) || "";

    const filtered = filter ? netLog.filter((e) => e.url.toLowerCase().includes(filter)) : netLog;
    countEl.textContent = `${filtered.length}/${netLog.length} requests`;

    // Render newest first. Each entry is a <details> so the full req/res
    // body only shows up when you click it - keeps the list scannable.
    container.innerHTML = filtered
      .slice()
      .reverse()
      .map((e, i) => {
        const time = new Date(e.ts).toLocaleTimeString();
        const statusColor = e.status >= 200 && e.status < 300 ? "#9c9" : "#f88";
        return `
          <details style="border-bottom:1px solid #222;padding:3px 0">
            <summary style="cursor:pointer;color:${statusColor}">
              [${time}] ${e.method} ${e.status} - ${escapeHtml(shortUrl(e.url))} (${e.ms}ms)
            </summary>
            <div style="color:#888;margin:4px 0 2px">Full URL:</div>
            <div style="word-break:break-all;color:#ccc">${escapeHtml(e.url)}</div>
            ${e.reqHeaders && Object.keys(e.reqHeaders).length ? `<div style="color:#888;margin:4px 0 2px">Request headers:</div><pre style="white-space:pre-wrap;margin:0;color:#ccc">${escapeHtml(JSON.stringify(e.reqHeaders, null, 2))}</pre>` : ""}
            ${e.reqBody ? `<div style="color:#888;margin:4px 0 2px">Request body:</div><pre style="white-space:pre-wrap;margin:0;color:#ccc">${escapeHtml(e.reqBody)}</pre>` : ""}
            <div style="color:#888;margin:4px 0 2px">Response body:</div>
            <pre style="white-space:pre-wrap;margin:0;color:#ccc">${escapeHtml(e.resBody || "")}</pre>
          </details>
        `;
      })
      .join("");
  }

  function shortUrl(url) {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch (e) {
      return url;
    }
  }

  function reportError(e) {
    console.error("[GHL Workflow Tool]", e);
    const detail = e && e.report ? e.report() : `${e.message}\n${e.stack || ""}`;
    appendLog(`ERROR\n${detail}\n(also check the browser console with F12 for the full technical detail)`);
  }

  function guessWorkflowIdFromUrl() {
    const m = location.href.match(/workflow\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  function appendLog(msg) {
    const ts = new Date().toLocaleTimeString();
    const line = `[${ts}] ${msg}`;
    logLines.push(line);
    if (logEl) {
      logEl.textContent = logLines.join("\n");
      logEl.scrollTop = logEl.scrollHeight;
    }
    console.log("[GHL Workflow Tool]", msg);
  }

  function parseJwtPayload(token) {
    try {
      const raw = token.replace(/^Bearer\s+/i, "");
      return JSON.parse(atob(raw.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    } catch (e) {
      return null;
    }
  }

  function parseJwtExp(token) {
    const payload = parseJwtPayload(token);
    return payload && payload.exp ? payload.exp * 1000 : null; // ms epoch
  }

  function updateStatus() {
    if (!statusEl) return;
    if (!state.token) {
      statusEl.style.color = "#9c9";
      statusEl.textContent = "Waiting for activity in GHL (click something, open a workflow, etc.)...";
      return;
    }
    const now = Date.now();
    if (state.tokenExp && now > state.tokenExp) {
      statusEl.style.color = "#f88";
      const minsAgo = Math.round((now - state.tokenExp) / 60000);
      statusEl.textContent = `TOKEN EXPIRED ${minsAgo} min ago - click something inside GHL to renew it before using the buttons.`;
      return;
    }
    statusEl.style.color = "#9c9";
    const minsLeft = state.tokenExp ? Math.max(0, Math.round((state.tokenExp - now) / 60000)) : null;
    statusEl.textContent =
      `Session captured. location=${state.locationId || "?"}` +
      (minsLeft != null ? ` (token expires in ~${minsLeft} min)` : "");
  }

  // Re-check token expiry periodically so the warning shows up even if the
  // user hasn't triggered any new GHL traffic (and thus no new "creds" msg).
  setInterval(updateStatus, 30000);

  if (isTop) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", buildPanel);
    } else {
      buildPanel();
    }
  }
  // Non-top frames build nothing - they only relay messages (see the
  // "message" listener above).
})();
