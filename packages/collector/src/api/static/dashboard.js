const state = {
  overview: null,
  env: null,
  promptIndex: null,
  selectedPromptSource: "",
  promptDetail: null,
  selectedEntity: "",
  bundle: null,
  busy: new Set(),
};

const $ = (id) => document.getElementById(id);
const overviewEndpoint = "/dashboard/api/overview";
const envEndpoint = "/dashboard/api/env-settings";
const sourcePromptIndexEndpoint = "/dashboard/api/source-prompts";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtDate(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function fmtNumber(value) {
  if (value === null || value === undefined || value === "") return "0";
  const num = Number(value);
  return Number.isFinite(num) ? new Intl.NumberFormat().format(num) : String(value);
}

function coerceValue(setting, raw) {
  if (setting.input_type === "boolean" || typeof setting.value === "boolean") {
    return raw === true || raw === "true" || raw === "on" || raw === "1";
  }
  if (setting.input_type === "integer" || setting.input_type === "float" || typeof setting.value === "number") {
    const num = Number(raw);
    return Number.isFinite(num) ? num : raw;
  }
  return raw;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { detail: text };
    }
  }
  if (!response.ok) {
    const message = payload?.detail?.reason || payload?.detail || response.statusText || "Request failed";
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return payload;
}

function showMessage(targetId, text, kind = "ok") {
  const node = $(targetId);
  if (!node) return;
  node.textContent = text;
  node.className = `message show ${kind}`;
}

function clearMessage(targetId) {
  const node = $(targetId);
  if (!node) return;
  node.textContent = "";
  node.className = "message";
}

function clearAllMessages() {
  ["globalMessage", "promptMessage", "envMessage"].forEach(clearMessage);
}

function setBusy(key, busy) {
  if (busy) state.busy.add(key);
  else state.busy.delete(key);
  const disabled = state.busy.size > 0;
  ["refreshBtn", "collectAllBtn", "entityRefreshBtn"].forEach((id) => {
    if ($(id)) $(id).disabled = disabled;
  });
  const envSubmit = $("envForm")?.querySelector('button[type="submit"]');
  if (envSubmit) envSubmit.disabled = disabled;
  const promptSubmit = $("promptForm")?.querySelector('button[type="submit"]');
  if (promptSubmit) promptSubmit.disabled = disabled;
  const promptRun = $("promptRunBtn");
  if (promptRun) promptRun.disabled = disabled;
  const promptRefresh = $("promptRefreshBtn");
  if (promptRefresh) promptRefresh.disabled = disabled;
}

function summaryCard(label, value, note = "") {
  return `
    <article class="summary-card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value)}</div>
      ${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}
    </article>
  `;
}

function overviewValues() {
  const o = state.overview || {};
  const health = o.health || {};
  const runtime = o.runtime || {};
  const analysis = o.analysis || {};
  const sourceAgents = o.source_agents || {};
  return [
    {
      label: "Health",
      value: health.status || "unknown",
      note: health.analysis_enabled ? "analysis enabled" : "analysis disabled",
    },
    {
      label: "Sources",
      value: fmtNumber(o.sources?.length || 0),
      note: `${fmtNumber(runtime.active_source_count || 0)} active`,
    },
    {
      label: "Source Agents",
      value: fmtNumber(sourceAgents.enabled_source_count || 0),
      note: `${fmtNumber(sourceAgents.latest_run_count || 0)} sources have agent history`,
    },
    {
      label: "Candidates",
      value: fmtNumber(o.candidates?.length || 0),
      note: analysis.enabled === false ? "analysis disabled" : `${fmtNumber(analysis.queue_size || 0)} queued`,
    },
    {
      label: "Evidence",
      value: fmtNumber(o.recent_evidence?.length || 0),
      note: "recent items",
    },
    {
      label: "Generated",
      value: o.generated_at ? fmtDate(o.generated_at) : "pending",
      note: "latest overview",
    },
  ];
}

function renderSummary() {
  $("summaryGrid").innerHTML = overviewValues().map((item) => summaryCard(item.label, item.value, item.note)).join("");
}

function sourceStatusPill(source) {
  const status = source.enabled === false
    ? "disabled"
    : source.runnable === false
      ? "not runnable"
      : source.run_state === "running"
        ? "running"
        : source.run_state === "failed"
          ? "failed"
          : "enabled";
  const cls = source.enabled === false
    ? "bad"
    : source.runnable === false
      ? "warn"
      : source.run_state === "failed"
        ? "bad"
        : source.run_state === "running"
          ? "warn"
          : "good";
  return `<span class="pill ${cls}">${escapeHtml(status)}</span>`;
}

function agentStatusPill(source) {
  if (!source.agent_enabled) return `<span class="pill warn">agent off</span>`;
  const status = source.source_agent_status || source.last_agent_status || "ready";
  const cls = status === "failed" ? "bad" : status === "completed" ? "good" : status === "running" ? "warn" : "warn";
  return `<span class="pill ${cls}">${escapeHtml(status)}</span>`;
}

function compactJoin(items) {
  return items.filter(Boolean).join(" · ");
}

function sourceDetailLines(source) {
  const details = [];
  details.push(compactJoin([
    source.kind || "source",
    source.capabilities?.length ? `caps: ${source.capabilities.slice(0, 3).join(", ")}` : "",
    source.request_kinds_supported?.length ? `requests: ${source.request_kinds_supported.join(", ")}` : "",
  ]));
  details.push(compactJoin([
    source.current_stage ? `stage: ${source.current_stage}` : "",
    source.current_stage_message || "",
  ]));
  details.push(compactJoin([
    source.last_outcome ? `outcome: ${source.last_outcome}` : "",
    typeof source.payload_total === "number" && source.payload_total > 0 ? `payloads ${source.payloads_processed || 0}/${source.payload_total}` : "",
    typeof source.evidence_total === "number" && source.evidence_total > 0 ? `evidence ${source.evidence_total}` : "",
    typeof source.resolve_miss_total === "number" && source.resolve_miss_total > 0 ? `resolve miss ${source.resolve_miss_total}` : "",
  ]));
  details.push(compactJoin([
    source.source_agent_status ? `agent: ${source.source_agent_status}` : "",
    source.source_agent_error || source.last_agent_error || "",
  ]));
  details.push(compactJoin([
    source.last_warning_kind ? `warning: ${source.last_warning_kind}` : "",
    source.last_warning_targets?.length ? `targets: ${source.last_warning_targets.join(", ")}` : "",
    source.last_failure_kind ? `failure: ${source.last_failure_kind}` : "",
  ]));
  return details.filter(Boolean);
}

function renderSources() {
  const sources = state.overview?.sources || [];
  $("sourceMeta").textContent = `${fmtNumber(sources.length)} sources`;
  $("sourcesBody").innerHTML = sources
    .map((source) => {
      const id = source.source_id || "";
      const tier = source.configured_tier ?? "";
      const promptHint = source.agent_prompt_path ? source.agent_prompt_path.split("/").slice(-2).join("/") : "no prompt";
      const detailLines = sourceDetailLines(source);
      return `
        <tr>
          <td data-label="Source">
            <div class="source-name">${escapeHtml(id)}</div>
            ${detailLines.map((line) => `<div class="source-sub">${escapeHtml(line)}</div>`).join("")}
            <div class="source-sub">${escapeHtml(`prompt: ${promptHint}`)}</div>
          </td>
          <td data-label="Status">
            <div class="inline">
              ${sourceStatusPill(source)}
              ${agentStatusPill(source)}
              ${source.scheduled ? `<span class="pill">scheduled</span>` : ""}
            </div>
          </td>
          <td data-label="Tier">
            <div class="source-actions">
              <input type="number" min="1" max="3" step="1" value="${escapeHtml(tier)}" data-tier-input="${escapeHtml(id)}" />
              <label class="pill">
                <input type="checkbox" ${source.enabled ? "checked" : ""} data-enable-input="${escapeHtml(id)}" />
                enabled
              </label>
              <span class="pill">effective ${escapeHtml(source.effective_tier ?? tier)}</span>
            </div>
          </td>
          <td data-label="Run">
            <div class="source-actions">
              <button class="btn btn-ghost btn-small" type="button" data-run-source="${escapeHtml(id)}" ${(!source.enabled || !source.runnable) ? "disabled" : ""}>Run source</button>
              ${source.agent_prompt_path ? `<button class="btn btn-ghost btn-small" type="button" data-edit-prompt="${escapeHtml(id)}">Edit prompt</button>` : ""}
              ${source.agent_prompt_path ? `<button class="btn btn-ghost btn-small" type="button" data-run-agent="${escapeHtml(id)}" ${!source.agent_enabled ? "disabled" : ""}>Run agent</button>` : ""}
            </div>
          </td>
        </tr>
      `;
    })
    .join("") || `<tr><td colspan="4"><p class="empty">No sources returned.</p></td></tr>`;

  $("sourcesBody").querySelectorAll("[data-run-source]").forEach((button) => {
    button.addEventListener("click", () => runSource(button.dataset.runSource));
  });
  $("sourcesBody").querySelectorAll("[data-run-agent]").forEach((button) => {
    button.addEventListener("click", () => runSourceAgent(button.dataset.runAgent));
  });
  $("sourcesBody").querySelectorAll("[data-edit-prompt]").forEach((button) => {
    button.addEventListener("click", () => selectPromptSource(button.dataset.editPrompt, true));
  });
  $("sourcesBody").querySelectorAll("[data-enable-input]").forEach((input) => {
    input.addEventListener("change", () => toggleSource(input.dataset.enableInput, input.checked));
  });
  $("sourcesBody").querySelectorAll("[data-tier-input]").forEach((input) => {
    const commit = () => updateTier(input.dataset.tierInput, input.value);
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    });
  });
}

function candidateText(candidate) {
  return (
    candidate.display_label ||
    candidate.primary_entity ||
    candidate.entity ||
    candidate.name ||
    candidate.label ||
    candidate.topic ||
    candidate.id ||
    "Candidate"
  );
}

function renderCandidates() {
  const candidates = state.overview?.candidates || [];
  $("candidateMeta").textContent = `${fmtNumber(candidates.length)} candidates`;
  $("candidatesList").innerHTML = candidates.length
    ? candidates.map((candidate) => {
        const entity = candidateText(candidate);
        const score = candidate.emergence_score ?? candidate.velocity_score ?? candidate.score ?? "";
        const inspectKey = candidate.primary_entity || entity;
        const summary =
          candidate.event_summary ||
          candidate.analysis_summary ||
          candidate.desire_summary ||
          candidate.analysis_reason ||
          "Emerging signal";
        const facetSummary = [
          candidate.graph_summary,
          candidate.theme_tags?.length ? `themes: ${candidate.theme_tags.join(", ")}` : "",
          candidate.supporting_terms?.length ? `terms: ${candidate.supporting_terms.slice(0, 4).join(", ")}` : "",
        ].filter(Boolean).join(" · ");
        return `
          <article class="card">
            <div class="stacked">
              <h3>${escapeHtml(entity)}</h3>
              <p class="muted">${escapeHtml(summary)}</p>
              ${facetSummary ? `<p class="muted">${escapeHtml(facetSummary)}</p>` : ""}
              <div class="row">
                <span class="pill">${escapeHtml(score === "" ? "n/a" : score)}</span>
                ${candidate.candidate_kind ? `<span class="pill">${escapeHtml(candidate.candidate_kind)}</span>` : ""}
                ${candidate.cluster_id ? `<span class="pill">${escapeHtml(candidate.cluster_id)}</span>` : ""}
                <span class="muted">${escapeHtml(candidate.source_count ? `${candidate.source_count} sources` : candidate.status || "")}</span>
              </div>
            </div>
            <div class="card-actions">
              <button class="btn btn-ghost btn-small" type="button" data-inspect-entity="${escapeHtml(inspectKey)}">Inspect</button>
            </div>
          </article>
        `;
      }).join("")
    : `<p class="empty">No emerging candidates yet.</p>`;
  $("candidatesList").querySelectorAll("[data-inspect-entity]").forEach((button) => {
    button.addEventListener("click", () => selectEntity(button.dataset.inspectEntity));
  });
}

function renderEvidence() {
  const evidence = state.overview?.recent_evidence || [];
  $("evidenceList").innerHTML = evidence.length
    ? evidence.slice(0, 12).map((item) => {
        const primaryEntity = item.entity_candidates?.[0] || "";
        const title = item.title_or_label || primaryEntity || item.source || item.evidence_id || "Evidence";
        const subtitle = item.url_or_ref || item.signal_type || "";
        return `
          <article class="card">
            <h3>${escapeHtml(title)}</h3>
            <p class="muted">${escapeHtml(subtitle)}</p>
            <div class="row">
              <span class="pill">${escapeHtml(item.signal_type || "evidence")}</span>
              <span class="muted">${escapeHtml(fmtDate(item.collected_at || ""))}</span>
            </div>
            <div class="card-actions">
              ${primaryEntity ? `<button class="btn btn-ghost btn-small" type="button" data-inspect-entity="${escapeHtml(primaryEntity)}">Inspect entity</button>` : ""}
            </div>
          </article>
        `;
      }).join("")
    : `<p class="empty">No recent evidence available.</p>`;
  $("evidenceList").querySelectorAll("[data-inspect-entity]").forEach((button) => {
    button.addEventListener("click", () => selectEntity(button.dataset.inspectEntity));
  });
}

function renderSubmissions() {
  const submissions = state.overview?.submissions || [];
  $("submissionsList").innerHTML = submissions.length
    ? submissions.slice(0, 12).map((submission) => {
        const statusClass =
          submission.status === "failed"
            ? "bad"
            : submission.status === "pending" || submission.status === "running" || submission.status === "pending_human"
              ? "warn"
              : "good";
        const progress = submission.metadata?.progress || {};
        const detail = compactJoin([
          progress.stage ? `stage: ${progress.stage}` : "",
          progress.message || "",
          submission.metadata?.source_agent_status ? `agent: ${submission.metadata.source_agent_status}` : "",
        ]);
        return `
          <article class="card">
            <h3>${escapeHtml(submission.source_id || submission.submission_id || "Submission")}</h3>
            <p class="muted">${escapeHtml(detail || submission.error_message || submission.producer_ref || "")}</p>
            <div class="row">
              <span class="pill ${statusClass}">${escapeHtml(submission.status || "unknown")}</span>
              <span class="muted">${escapeHtml(fmtDate(submission.processed_at || submission.received_at || ""))}</span>
            </div>
          </article>
        `;
      }).join("")
    : `<p class="empty">No submissions returned.</p>`;
}

function topEntityChoices() {
  return (state.overview?.top_entities || []).map((item) => item.display_label || item.entity).filter(Boolean);
}

function renderEntityPanel() {
  const selected = state.selectedEntity || topEntityChoices()[0] || "";
  if (!selected) {
    $("entityPanel").innerHTML = `<p class="empty">Select a candidate or top entity to inspect its evidence bundle.</p>`;
    return;
  }
  const bundle = state.bundle && state.bundle.entity === selected ? state.bundle : null;
  const items = bundle?.evidence || [];
  $("entityPanel").innerHTML = `
    <div class="entity-head">
      <div>
        <div class="entity-title">${escapeHtml(selected)}</div>
        <div class="muted">${bundle ? `${fmtNumber(bundle.count ?? items.length)} evidence items` : "Loading bundle"}</div>
      </div>
      <span class="pill">${bundle?.count ?? items.length ?? 0}</span>
    </div>
    <div class="card-actions">
      ${topEntityChoices().slice(0, 6).map((entity) => `<button class="btn btn-ghost btn-small" type="button" data-select-top-entity="${escapeHtml(entity)}">${escapeHtml(entity)}</button>`).join("")}
    </div>
    <div class="bundle-list">
      ${
        items.length
          ? items.slice(0, 10).map((item) => `
              <div class="bundle-item">
                <div class="item-title">${escapeHtml(item.title_or_label || item.evidence_id || item.source || "Evidence item")}</div>
                <div class="muted">${escapeHtml(item.url_or_ref || item.signal_type || "")}</div>
              </div>
            `).join("")
          : `<p class="empty">${bundle ? "No evidence items in this bundle." : "Open a bundle to view evidence."}</p>`
      }
    </div>
  `;
  $("entityPanel").querySelectorAll("[data-select-top-entity]").forEach((button) => {
    button.addEventListener("click", () => selectEntity(button.dataset.selectTopEntity));
  });
}

function renderEnvSettings() {
  const payload = state.env;
  $("envMeta").textContent = payload?.available ? (payload.env_file_path || "env available") : "unavailable";
  if (!payload?.available) {
    $("envSections").innerHTML = `<p class="empty">Environment settings are unavailable.</p>`;
    return;
  }
  const sections = new Map();
  for (const setting of payload.settings || []) {
    const section = setting.section || "General";
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push(setting);
  }
  $("envSections").innerHTML = [...sections.entries()]
    .map(([section, settings]) => `
      <section class="env-section">
        <h3>${escapeHtml(section)}</h3>
        <div class="field-grid">
          ${settings.map(renderSettingField).join("")}
        </div>
      </section>
    `)
    .join("") || `<p class="empty">No environment settings returned.</p>`;
}

function renderSettingField(setting) {
  const id = `setting-${setting.key}`;
  const value = setting.value ?? "";
  const options = Array.isArray(setting.options) ? setting.options : [];
  const description = setting.description ? `<small>${escapeHtml(setting.description)}</small>` : "";
  const restart = setting.restart_required ? `<span class="pill warn">restart required</span>` : "";
  let control = "";
  if (options.length) {
    control = `<select id="${escapeHtml(id)}" name="${escapeHtml(setting.key)}">${options.map((option) => `<option value="${escapeHtml(option)}" ${String(option) === String(value) ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select>`;
  } else if (setting.input_type === "boolean" || typeof value === "boolean") {
    control = `
      <label class="field-inline">
        <input id="${escapeHtml(id)}" name="${escapeHtml(setting.key)}" type="checkbox" ${value ? "checked" : ""} />
        <span>${value ? "Enabled" : "Disabled"}</span>
      </label>
    `;
  } else {
    const type = setting.input_type === "integer" || setting.input_type === "float" ? "number" : "text";
    const step = setting.input_type === "float" ? ' step="0.01"' : "";
    control = `<input id="${escapeHtml(id)}" name="${escapeHtml(setting.key)}" type="${type}"${step} value="${escapeHtml(value)}" />`;
  }
  return `
    <div class="field">
      <div class="field-head">
        <label for="${escapeHtml(id)}">${escapeHtml(setting.label || setting.key)}</label>
        ${restart}
      </div>
      ${description}
      ${control}
    </div>
  `;
}

function renderPromptEditor() {
  const index = state.promptIndex;
  const detail = state.promptDetail;
  $("promptMeta").textContent = index ? `${fmtNumber(index.count || 0)} prompt files` : "unavailable";
  if (!index?.prompts?.length) {
    $("promptPanel").innerHTML = `<p class="empty">No source prompt files are registered.</p>`;
    return;
  }
  const selected = state.selectedPromptSource || index.prompts[0].source_id;
  const selectedMeta = index.prompts.find((item) => item.source_id === selected) || index.prompts[0];
  const content = detail?.source_id === selected ? detail.content ?? "" : "";
  $("promptPanel").innerHTML = `
    <div class="prompt-toolbar">
      <div class="field">
        <div class="field-head">
          <label for="promptSourceSelect">Prompt source</label>
          <span class="pill ${selectedMeta.agent_enabled ? "good" : "warn"}">${selectedMeta.agent_enabled ? "agent on" : "agent off"}</span>
        </div>
        <select id="promptSourceSelect" name="promptSourceSelect">
          ${index.prompts.map((item) => `<option value="${escapeHtml(item.source_id)}" ${item.source_id === selected ? "selected" : ""}>${escapeHtml(item.source_id)}</option>`).join("")}
        </select>
      </div>
      <div class="rowline">
        <span class="muted">${escapeHtml(selectedMeta.agent_prompt_path || "no prompt path")}</span>
        <span class="pill">${escapeHtml(selectedMeta.source_agent_status || selectedMeta.last_agent_status || (selectedMeta.exists ? "file exists" : "file missing"))}</span>
      </div>
      <div class="field">
        <div class="field-head">
          <label for="promptContent">Markdown prompt</label>
          <small>${escapeHtml(detail?.exists ? `${fmtNumber(detail.char_count)} chars` : "new file will be created on save")}</small>
        </div>
        <textarea id="promptContent" name="promptContent" spellcheck="false">${escapeHtml(content)}</textarea>
      </div>
      <div class="prompt-actions">
        <button class="btn btn-ghost btn-small" id="promptRefreshBtn" type="button">Reload prompt</button>
        <button class="btn btn-ghost btn-small" id="promptRunBtn" type="button" ${!selectedMeta.agent_enabled ? "disabled" : ""}>Run source agent</button>
        <button class="btn btn-primary" type="submit">Save prompt</button>
      </div>
    </div>
  `;
  $("promptSourceSelect").addEventListener("change", (event) => selectPromptSource(event.target.value));
  $("promptRefreshBtn").addEventListener("click", () => loadPromptDetail());
  $("promptRunBtn").addEventListener("click", () => runSourceAgent());
}

async function loadOverview() {
  setBusy("overview", true);
  try {
    state.overview = await fetchJson(overviewEndpoint);
    if (!state.selectedEntity) {
      state.selectedEntity = topEntityChoices()[0] || candidateText(state.overview.candidates?.[0] || {}) || "";
    }
    renderSummary();
    renderSources();
    renderCandidates();
    renderEvidence();
    renderSubmissions();
    renderEntityPanel();
  } finally {
    setBusy("overview", false);
  }
}

async function loadEnvSettings() {
  setBusy("env", true);
  try {
    state.env = await fetchJson(envEndpoint);
    renderEnvSettings();
  } finally {
    setBusy("env", false);
  }
}

async function loadPromptIndex() {
  setBusy("prompts-index", true);
  try {
    state.promptIndex = await fetchJson(sourcePromptIndexEndpoint);
    if (!state.selectedPromptSource && state.promptIndex.prompts?.length) {
      state.selectedPromptSource = state.promptIndex.prompts[0].source_id;
    }
    renderPromptEditor();
  } finally {
    setBusy("prompts-index", false);
  }
}

async function loadPromptDetail(sourceId = state.selectedPromptSource) {
  if (!sourceId) {
    renderPromptEditor();
    return;
  }
  setBusy(`prompt:${sourceId}`, true);
  try {
    state.promptDetail = await fetchJson(`${sourcePromptIndexEndpoint}/${encodeURIComponent(sourceId)}`);
    renderPromptEditor();
  } catch (error) {
    state.promptDetail = {
      source_id: sourceId,
      content: "",
      exists: false,
      char_count: 0,
    };
    renderPromptEditor();
    showMessage("promptMessage", error.message, "warn");
  } finally {
    setBusy(`prompt:${sourceId}`, false);
  }
}

async function refreshAll() {
  clearAllMessages();
  await Promise.all([loadOverview(), loadEnvSettings(), loadPromptIndex()]);
  if (state.selectedPromptSource) {
    await loadPromptDetail(state.selectedPromptSource);
  }
}

async function runCollect() {
  setBusy("collect", true);
  try {
    const result = await fetchJson("/collect/run", {
      method: "POST",
      body: JSON.stringify({ async_mode: true }),
    });
    showMessage("globalMessage", `Collect queued: ${fmtNumber(result.queued_count ?? result.evidence_count ?? 0)} source(s).`, "ok");
    await loadOverview();
  } catch (error) {
    showMessage("globalMessage", error.message, "error");
  } finally {
    setBusy("collect", false);
  }
}

async function runSource(sourceId) {
  setBusy(`run:${sourceId}`, true);
  try {
    await fetchJson(`/internal/sources/run/${encodeURIComponent(sourceId)}`, { method: "POST", body: "{}" });
    showMessage("globalMessage", `Queued run for ${sourceId}.`, "ok");
    await loadOverview();
  } catch (error) {
    showMessage("globalMessage", error.message, "error");
  } finally {
    setBusy(`run:${sourceId}`, false);
  }
}

async function runSourceAgent(sourceId = state.selectedPromptSource) {
  if (!sourceId) return;
  setBusy(`run-agent:${sourceId}`, true);
  try {
    const payload = await fetchJson(`/internal/source-agents/run/${encodeURIComponent(sourceId)}`, {
      method: "POST",
      body: "{}",
    });
    showMessage("promptMessage", `Source agent ran for ${sourceId}. Derived evidence: ${fmtNumber(payload.derived_evidence_count || 0)}.`, "ok");
    await Promise.all([loadOverview(), loadPromptIndex()]);
  } catch (error) {
    showMessage("promptMessage", error.message, "error");
  } finally {
    setBusy(`run-agent:${sourceId}`, false);
  }
}

async function toggleSource(sourceId, enabled) {
  setBusy(`enable:${sourceId}`, true);
  try {
    await fetchJson(`/internal/sources/${encodeURIComponent(sourceId)}/enable`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
    showMessage("globalMessage", `${sourceId} ${enabled ? "enabled" : "disabled"}.`, "ok");
    await loadOverview();
  } catch (error) {
    showMessage("globalMessage", error.message, "error");
    await loadOverview();
  } finally {
    setBusy(`enable:${sourceId}`, false);
  }
}

async function updateTier(sourceId, value) {
  const configuredTier = Number(value);
  if (!Number.isFinite(configuredTier)) {
    showMessage("globalMessage", `Tier for ${sourceId} must be a number.`, "warn");
    await loadOverview();
    return;
  }
  setBusy(`tier:${sourceId}`, true);
  try {
    await fetchJson(`/internal/sources/${encodeURIComponent(sourceId)}/tier`, {
      method: "PATCH",
      body: JSON.stringify({ configured_tier: configuredTier }),
    });
    showMessage("globalMessage", `${sourceId} moved to tier ${configuredTier}.`, "ok");
    await loadOverview();
  } catch (error) {
    showMessage("globalMessage", error.message, "error");
    await loadOverview();
  } finally {
    setBusy(`tier:${sourceId}`, false);
  }
}

async function selectEntity(entity) {
  if (!entity) return;
  state.selectedEntity = entity;
  state.bundle = null;
  renderEntityPanel();
  await loadEntityBundle(entity);
}

async function loadEntityBundle(entity = state.selectedEntity) {
  if (!entity) return;
  setBusy(`bundle:${entity}`, true);
  try {
    state.bundle = await fetchJson(`/evidence/bundles/${encodeURIComponent(entity)}`);
    renderEntityPanel();
  } catch (error) {
    state.bundle = { entity, count: 0, evidence: [] };
    renderEntityPanel();
    showMessage("globalMessage", error.message, "error");
  } finally {
    setBusy(`bundle:${entity}`, false);
  }
}

async function selectPromptSource(sourceId, scrollIntoView = false) {
  if (!sourceId) return;
  state.selectedPromptSource = sourceId;
  state.promptDetail = null;
  renderPromptEditor();
  await loadPromptDetail(sourceId);
  if (scrollIntoView) {
    $("promptPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function saveSourcePrompt(event) {
  event.preventDefault();
  clearMessage("promptMessage");
  const sourceId = state.selectedPromptSource;
  if (!sourceId) {
    showMessage("promptMessage", "Select a source prompt first.", "warn");
    return;
  }
  const content = $("promptContent")?.value ?? "";
  setBusy(`prompt-save:${sourceId}`, true);
  try {
    await fetchJson(`${sourcePromptIndexEndpoint}/${encodeURIComponent(sourceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    });
    showMessage("promptMessage", `Saved prompt for ${sourceId}.`, "ok");
    await Promise.all([loadPromptIndex(), loadPromptDetail(sourceId), loadOverview()]);
  } catch (error) {
    showMessage("promptMessage", error.message, "error");
  } finally {
    setBusy(`prompt-save:${sourceId}`, false);
  }
}

async function saveEnvSettings(event) {
  event.preventDefault();
  clearMessage("envMessage");
  const payload = state.env;
  if (!payload?.available) {
    showMessage("envMessage", "Environment settings are unavailable.", "warn");
    return;
  }
  const settings = {};
  for (const setting of payload.settings || []) {
    const field = event.currentTarget.querySelector(`[name="${CSS.escape(setting.key)}"]`);
    if (!field) continue;
    settings[setting.key] = field.type === "checkbox" ? field.checked : coerceValue(setting, field.value);
  }
  setBusy("env-save", true);
  try {
    await fetchJson(envEndpoint, {
      method: "PATCH",
      body: JSON.stringify({ settings }),
    });
    showMessage("envMessage", "Environment settings saved.", "ok");
    await loadEnvSettings();
  } catch (error) {
    showMessage("envMessage", error.message, "error");
  } finally {
    setBusy("env-save", false);
  }
}

function bindEvents() {
  $("refreshBtn").addEventListener("click", refreshAll);
  $("collectAllBtn").addEventListener("click", runCollect);
  $("entityRefreshBtn").addEventListener("click", () => loadEntityBundle());
  $("envForm").addEventListener("submit", saveEnvSettings);
  $("promptForm").addEventListener("submit", saveSourcePrompt);
}

async function init() {
  bindEvents();
  renderSummary();
  renderSources();
  renderCandidates();
  renderEvidence();
  renderSubmissions();
  renderEntityPanel();
  renderPromptEditor();
  renderEnvSettings();
  await refreshAll();
  if (state.selectedEntity) {
    await loadEntityBundle();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => showMessage("globalMessage", error.message, "error"));
});
