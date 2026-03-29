// Request Analysis — list and detail view for execution traces.
// XSS safety: all user-generated content rendered via escHtml() before innerHTML insertion.

const tracesApi = {
  list: () => fetch('/api/v1/traces').then(r => r.json()),
  get: (id) => fetch(`/api/v1/traces/${id}`).then(r => r.json()),
  clearAll: () => fetch('/api/v1/traces', { method: 'DELETE' }).then(r => r.json()),
};

let tracesData = [];

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDuration(ms) {
  return ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** Build a plain-text representation of a trace for clipboard. */
function traceToText(trace) {
  const lines = [];
  lines.push(`${fmtDuration(trace.duration_ms)}`);
  lines.push(`${trace.total_iterations} iterations`);
  lines.push(`${(trace.total_tokens || 0).toLocaleString()} tokens`);
  lines.push(`${trace.steps.length} steps`);
  if (trace.cognition_model) lines.push(`Cognition: ${trace.cognition_model}`);
  if (trace.execution_model) lines.push(`Execution: ${trace.execution_model}`);

  lines.push(`Request`);
  lines.push(trace.request);

  if (trace.cognition) {
    const c = trace.cognition;
    lines.push(`Cognition Phase`);
    if (c.intent_type) lines.push(c.intent_type);
    if (c.is_fallback) {
      lines.push(`⚠ Cognition fallback — all tools loaded`);
      if (c.fallback_reason) lines.push(c.fallback_reason);
    }
    if (c.success_criteria) lines.push(`Success criteria: ${c.success_criteria}`);
    if (c.understanding) lines.push(c.understanding);
    if (c.plan && c.plan.length) c.plan.forEach(s => lines.push(s));
    if (c.discovered_tools && c.discovered_tools.length) {
      lines.push(`Tools discovered: ${c.discovered_tools.length} — ${c.discovered_tools.join(', ')}`);
    }
    if (c.discovery_steps && c.discovery_steps.length) {
      lines.push(`Discovery Steps (${c.discovery_steps.length})`);
      c.discovery_steps.forEach(s => {
        lines.push(`#${s.iteration}`);
        lines.push(s.tool);
        lines.push(s.args_summary);
        if (s.result_summary) lines.push(s.result_summary);
      });
    }
  }

  if (trace.steps.length) {
    lines.push(`Execution Steps (${trace.steps.length})`);
    trace.steps.forEach(s => {
      const parts = [`#${s.iteration}`, s.tool];
      if (s.is_error) parts.push('error');
      if (s.args_summary) {
        try {
          const p = JSON.parse(s.args_summary);
          parts.push(Object.entries(p).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', '));
        } catch (_) { parts.push(s.args_summary); }
      }
      lines.push(parts.join('\n'));
      if (s.guard_decision && s.guard_decision !== 'allow') lines.push(`  guard: ${s.guard_decision}`);
      if (s.browser_stuck_level) lines.push(`  stuck_level: ${s.browser_stuck_level}`);
      if (s.visual_check) lines.push(`  visual: ${s.visual_check}`);
      if (s.iteration_budget) lines.push(`  budget: ${s.iteration_budget}`);
      if (s.result_summary) lines.push(s.result_summary);
    });
  }

  if (trace.stop_reason) {
    lines.push(`Stop Reason: ${trace.stop_reason}`);
    if (trace.final_budget) lines.push(`Final Budget: ${trace.final_budget}`);
  }

  if (trace.final_response) {
    lines.push(`Final Response`);
    lines.push(trace.final_response);
  }
  return lines.join('\n');
}

/** Copy trace text to clipboard and show toast feedback. */
function copyTrace(trace) {
  const text = traceToText(trace);
  navigator.clipboard.writeText(text).then(() => {
    if (window.showToast) showToast('Trace copied to clipboard', 'success');
  }).catch(() => {
    if (window.showToast) showToast('Failed to copy trace', 'error');
  });
}

// ── List rendering ─────────────────────────────────────────────────────────────

function renderTracesList() {
  const container = document.getElementById('traces-list');
  const countEl = document.getElementById('traces-count');
  if (!container) return;

  countEl.textContent = `${tracesData.length} trace${tracesData.length !== 1 ? 's' : ''}`;

  if (tracesData.length === 0) {
    container.textContent = 'No traces yet. Run an agent request to see execution details here.';
    return;
  }

  const items = tracesData.map(t => {
    const intentHtml = t.intent_type
      ? `<span class="trace-intent badge-${escHtml(t.intent_type)}">${escHtml(t.intent_type)}</span>`
      : '';
    const fallbackHtml = t.is_fallback
      ? '<span class="badge badge-danger">fallback</span>'
      : '';
    const statusClass = t.status === 'completed' ? 'badge-success' : 'badge-warning';
    const time = new Date(t.started_at).toLocaleString();
    const model = t.execution_model ? `<span class="trace-model">${escHtml(t.execution_model)}</span>` : '';
    return `<div class="trace-list-item" data-id="${escHtml(t.id)}">
      <div class="trace-list-row">
        <span class="trace-channel">${escHtml(t.channel)}</span>
        ${intentHtml}
        ${fallbackHtml}
        <span class="badge ${statusClass}">${escHtml(t.status)}</span>
        <span class="trace-time">${escHtml(time)}</span>
      </div>
      <div class="trace-request-line">${escHtml(t.request_summary)}</div>
      <div class="trace-meta">
        ${model}
        <span>${t.steps} steps</span>
        <span>${t.total_iterations} iter</span>
        <span>${(t.total_tokens || 0).toLocaleString()} tok</span>
        <span>${escHtml(fmtDuration(t.duration_ms))}</span>
      </div>
    </div>`;
  }).join('');

  container.innerHTML = items;  // safe: all dynamic content escaped via escHtml

  container.querySelectorAll('.trace-list-item').forEach(el => {
    el.addEventListener('click', () => showTraceDetail(el.dataset.id));
  });
}

// ── Detail rendering ─────────────────────────────────────────────────────────

async function showTraceDetail(id) {
  document.querySelectorAll('.trace-list-item').forEach(el => {
    el.classList.toggle('is-active', el.dataset.id === id);
  });

  const detailEl = document.getElementById('traces-detail');
  const emptyEl = document.getElementById('traces-empty');
  detailEl.style.display = 'block';
  emptyEl.style.display = 'none';
  detailEl.textContent = 'Loading…';

  try {
    const trace = await tracesApi.get(id);
    renderTraceDetail(detailEl, trace);
  } catch (e) {
    detailEl.textContent = `Failed to load trace: ${e}`;
  }
}

let _currentTrace = null; // stored for copy button

function renderTraceDetail(container, trace) {
  _currentTrace = trace;
  const statusClass = trace.status === 'completed' ? 'badge-success' : 'badge-warning';
  const time = new Date(trace.started_at).toLocaleString();

  // Models info row
  const cogModel = trace.cognition_model ? escHtml(trace.cognition_model) : '—';
  const exeModel = trace.execution_model ? escHtml(trace.execution_model) : '—';

  let html = `<div class="trace-detail-header">
    <div class="trace-detail-meta">
      <span class="badge ${statusClass}">${escHtml(trace.status)}</span>
      <span class="trace-channel-badge">${escHtml(trace.channel)}</span>
      <span class="trace-detail-time">${escHtml(time)}</span>
      <button class="btn btn-ghost btn-sm trace-copy-btn" title="Copy trace">
        <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="6" y="6" width="9" height="9" rx="1.5"/>
          <path d="M3 12.5V3.5A1.5 1.5 0 0 1 4.5 2h9"/>
        </svg>
        Copy
      </button>
    </div>
    <div class="trace-stats-row">
      <span>${escHtml(fmtDuration(trace.duration_ms))}</span>
      <span>${trace.total_iterations} iterations</span>
      <span>${(trace.total_tokens || 0).toLocaleString()} tokens</span>
      <span>${trace.steps.length} steps</span>
    </div>
    <div class="trace-models-row">
      <span><strong>Cognition:</strong> <code>${cogModel}</code></span>
      <span><strong>Execution:</strong> <code>${exeModel}</code></span>
    </div>
  </div>
  <section class="trace-section">
    <h3 class="trace-section-title">Request</h3>
    <pre class="trace-pre">${escHtml(trace.request)}</pre>
  </section>`;

  if (trace.cognition) {
    html += renderCognitionSection(trace.cognition);
  }

  if (trace.steps.length > 0) {
    html += renderStepsSection(trace.steps);
  }

  if (trace.stop_reason) {
    html += `<section class="trace-section" style="border-left:3px solid var(--warning);padding-left:12px;">
      <h3 class="trace-section-title">Stop Reason</h3>
      <pre class="trace-pre" style="color:var(--warning);">${escHtml(trace.stop_reason)}</pre>
      ${trace.final_budget ? `<div style="font-size:0.8rem;opacity:0.7;">Final budget: ${trace.final_budget} iterations</div>` : ''}
    </section>`;
  }

  if (trace.final_response) {
    html += `<section class="trace-section">
      <h3 class="trace-section-title">Final Response</h3>
      <pre class="trace-pre">${escHtml(trace.final_response)}</pre>
    </section>`;
  }

  container.innerHTML = html;  // safe: all user content escaped via escHtml()

  // Bind copy button
  const copyBtn = container.querySelector('.trace-copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => copyTrace(_currentTrace));
  }
}

function renderCognitionSection(c) {
  const intentHtml = c.intent_type
    ? `<span class="trace-intent badge-${escHtml(c.intent_type)}">${escHtml(c.intent_type)}</span>`
    : '<span class="badge badge-warning">no intent</span>';
  const directBadge = c.answer_directly
    ? '<span class="badge badge-info">answered directly</span>'
    : '';
  const fallbackHtml = c.is_fallback
    ? `<div class="trace-fallback-warning">
         <strong>⚠ Cognition fallback — all tools loaded</strong>
         ${c.fallback_reason ? `<div class="trace-fallback-reason">${escHtml(c.fallback_reason)}</div>` : ''}
       </div>`
    : '';
  const criteriaHtml = c.success_criteria
    ? `<div class="trace-criteria"><strong>Success criteria:</strong> ${escHtml(c.success_criteria)}</div>`
    : '';
  const understandingHtml = c.understanding
    ? `<div class="trace-understanding">${escHtml(c.understanding)}</div>`
    : '';
  const planHtml = c.plan && c.plan.length > 0
    ? `<ol class="trace-plan">${c.plan.map(s => `<li>${escHtml(s)}</li>`).join('')}</ol>`
    : '';
  const toolsHtml = c.discovered_tools && c.discovered_tools.length > 0
    ? `<div class="trace-discovered">Tools discovered: <strong>${c.discovered_tools.length}</strong> — ${c.discovered_tools.slice(0, 10).map(t => `<code>${escHtml(t)}</code>`).join(', ')}${c.discovered_tools.length > 10 ? ` <em>+${c.discovered_tools.length - 10} more</em>` : ''}</div>`
    : '';

  // Discovery steps from the cognition mini-loop
  const discoveryHtml = c.discovery_steps && c.discovery_steps.length > 0
    ? `<div class="trace-discovery-steps">
         <div class="trace-discovery-title">Discovery Steps (${c.discovery_steps.length})</div>
         ${c.discovery_steps.map(s => `
           <div class="trace-discovery-step">
             <span class="trace-step-iter">#${s.iteration}</span>
             <code class="trace-step-tool">${escHtml(s.tool)}</code>
             <span class="trace-discovery-args">${escHtml(s.args_summary)}</span>
             <span class="trace-discovery-result">${escHtml(s.result_summary)}</span>
           </div>`).join('')}
       </div>`
    : '';

  return `<section class="trace-section trace-cognition">
    <h3 class="trace-section-title">Cognition Phase ${intentHtml} ${directBadge}</h3>
    ${fallbackHtml}
    ${criteriaHtml}
    ${understandingHtml}
    ${planHtml}
    ${toolsHtml}
    ${discoveryHtml}
  </section>`;
}

function renderStepsSection(steps) {
  const rows = steps.map(s => {
    // Show args inline — try to parse JSON for clean display
    let argsDisplay = s.args_summary || '';
    try {
      const parsed = JSON.parse(argsDisplay);
      argsDisplay = Object.entries(parsed)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(', ');
    } catch (e) { /* keep raw */ }

    // Truncate result for inline display, full in expandable
    const resultShort = (s.result_summary || '').substring(0, 120);
    const hasMore = (s.result_summary || '').length > 120;

    // Browser guard metadata badges
    const guardBadge = s.guard_decision && s.guard_decision !== 'allow'
      ? `<span class="badge badge-warning">${escHtml(s.guard_decision.substring(0, 30))}</span>` : '';
    const stuckBadge = s.browser_stuck_level && s.browser_stuck_level > 0
      ? `<span class="badge badge-danger">stuck:${s.browser_stuck_level}</span>` : '';
    const budgetInfo = s.iteration_budget
      ? `<span style="opacity:0.5;font-size:0.75rem;">budget:${s.iteration_budget}</span>` : '';
    const visualInfo = s.visual_check
      ? `<div style="margin-top:4px;padding:4px 8px;background:var(--surface-2);border-radius:4px;font-size:0.8rem;"><strong>Visual:</strong> ${escHtml(s.visual_check)}</div>` : '';

    return `
    <div class="trace-step${s.is_error ? ' trace-step-error' : ''}">
      <div class="trace-step-header">
        <span class="trace-step-iter">#${s.iteration}</span>
        <code class="trace-step-tool">${escHtml(s.tool)}</code>
        ${s.is_error ? '<span class="badge badge-danger">error</span>' : ''}
        ${guardBadge}${stuckBadge}${budgetInfo}
        ${argsDisplay ? `<span class="trace-step-args-inline">${escHtml(argsDisplay)}</span>` : ''}
      </div>
      ${visualInfo}
      ${s.result_summary ? `<div class="trace-step-result-preview">${escHtml(resultShort)}${hasMore ? '…' : ''}</div>` : ''}
      ${hasMore ? `<details class="trace-step-details"><summary>Full result</summary><pre class="trace-pre">${escHtml(s.result_summary)}</pre></details>` : ''}
    </div>`;
  }).join('');

  return `<section class="trace-section">
    <h3 class="trace-section-title">Execution Steps (${steps.length})</h3>
    <div class="trace-steps">${rows}</div>
  </section>`;
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadTracesList() {
  const container = document.getElementById('traces-list');
  try {
    tracesData = await tracesApi.list();
    renderTracesList();
  } catch (e) {
    if (container) container.textContent = `Failed to load traces: ${e}`;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Support both standalone page and settings modal.
// On standalone pages the script runs after DOM is ready; in the modal the
// settings-section-loaded event fires after the HTML fragment is injected.
function initTracesSection() {
  loadTracesList();
  const refreshBtn = document.getElementById('traces-refresh-btn');
  if (refreshBtn) {
    refreshBtn.replaceWith(refreshBtn.cloneNode(true));
    document.getElementById('traces-refresh-btn').addEventListener('click', loadTracesList);
  }
  const clearBtn = document.getElementById('traces-clear-btn');
  if (clearBtn) {
    clearBtn.replaceWith(clearBtn.cloneNode(true));
    document.getElementById('traces-clear-btn').addEventListener('click', async () => {
      if (!confirm('Delete all traces? This cannot be undone.')) return;
      const result = await tracesApi.clearAll();
      if (typeof showToast === 'function') showToast(`Deleted ${result.deleted} traces`, 'success');
      loadTracesList();
      const detail = document.getElementById('traces-detail');
      if (detail) detail.style.display = 'none';
      const empty = document.getElementById('traces-empty');
      if (empty) empty.style.display = '';
    });
  }
}

initTracesSection();
document.addEventListener('settings-section-loaded', initTracesSection);
