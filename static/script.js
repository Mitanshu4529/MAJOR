/* TripMate AI — frontend
   Talks to the FastAPI backend:
     POST /api/travel            start a plan (returns a draft awaiting review)
     POST /api/travel/approve    approve (final plan) or request changes (new draft)
     GET  /api/travel/{thread}   restore a draft still awaiting review
     GET  /health                status + LLM fallback chain
*/

const PENDING_THREAD_KEY = "travel_pending_thread_id";
const THEME_KEY = "tripmate_theme";
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const AGENTS = {
  flight_agent: { label: "Flights", icon: "plane" },
  hotel_agent: { label: "Hotels", icon: "hotel" },
  weather_agent: { label: "Weather", icon: "weather" },
  budget_agent: { label: "Budget", icon: "wallet" },
  itinerary_agent: { label: "Itinerary", icon: "route" },
};

const RESEARCH = [
  { key: "flight_results", label: "Flights", icon: "plane" },
  { key: "hotel_results", label: "Hotels", icon: "hotel" },
  { key: "weather_results", label: "Weather", icon: "weather", preformatted: true },
  { key: "budget_results", label: "Budget", icon: "wallet" },
];

const RUN_COPY = {
  draft: { title: "Planning your trip", hint: "Agents are researching — usually about 40 seconds" },
  revise: { title: "Revising your draft", hint: "Applying your feedback — usually under 30 seconds" },
  final: { title: "Writing your final plan", hint: "Polishing the approved draft — usually under 30 seconds" },
};

const $ = (id) => document.getElementById(id);
const els = {
  composer: $("composer"),
  input: $("userInput"),
  sendBtn: $("sendBtn"),
  lock: $("composerLock"),
  discardBtn: $("discardDraftBtn"),
  howto: $("howto"),
  error: $("errorBox"),
  errorText: $("errorText"),
  errorClose: $("errorClose"),
  run: $("runPanel"),
  runTitle: $("runTitle"),
  runHint: $("runHint"),
  runElapsed: $("runElapsed"),
  runAgents: $("runAgents"),
  workspace: $("workspace"),
  badge: $("planBadge"),
  title: $("planTitle"),
  meta: $("planMeta"),
  guard: $("guardBadge"),
  agentList: $("agentList"),
  whyBox: $("whyBox"),
  reasoning: $("supervisorReasoning"),
  toc: $("toc"),
  tocList: $("tocList"),
  planDoc: $("planDoc"),
  result: $("resultBox"),
  research: $("research"),
  tabs: $("researchTabs"),
  researchPanel: $("researchPanel"),
  threadInfo: $("threadInfo"),
  copyBtn: $("copyBtn"),
  pdfBtn: $("pdfBtn"),
  newPlanBtn: $("newPlanBtn"),
  review: $("approvalSection"),
  reviewText: $("approvalRequest"),
  feedback: $("approvalFeedback"),
  approveBtn: $("approveBtn"),
  reviseBtn: $("reviseBtn"),
  toasts: $("toasts"),
  statusPill: $("statusPill"),
  statusText: $("statusText"),
  statusTip: $("statusTip"),
  themeToggle: $("themeToggle"),
};

const state = {
  threadId: null,
  awaitingApproval: false,
  busy: false,
  data: null,
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function autosize(textarea, max) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
  textarea.classList.toggle("is-scrollable", textarea.scrollHeight > max);
}

function scrollToEl(node) {
  node.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
}

function slugify(text, used) {
  let base = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";
  let slug = base;
  let n = 2;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

/* Markdown → sanitized HTML. The output includes web-search text, so it is
   always sanitized; without both libraries we fall back to plain text. */
function renderMarkdown(target, markdown) {
  const source = markdown || "";
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    target.textContent = source;
    return;
  }
  target.innerHTML = DOMPurify.sanitize(marked.parse(source));

  target.querySelectorAll("a[href]").forEach((a) => {
    if (/^https?:/i.test(a.getAttribute("href"))) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  });
  target.querySelectorAll("table").forEach((table) => {
    const wrap = el("div", "table-wrap");
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  });
}

/* ------------------------------------------------------------------ */
/* Toasts + errors                                                     */
/* ------------------------------------------------------------------ */

function toast(message, kind = "success") {
  const node = el("div", `toast toast--${kind}`);
  node.setAttribute("role", "status");
  node.append(icon(kind === "success" ? "check" : "alert"), el("span", "", message));
  els.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add("is-leaving");
    node.addEventListener("animationend", () => node.remove(), { once: true });
  }, 2600);
}

function friendlyError(error) {
  const message = (error && error.message) || String(error || "");
  if (error instanceof TypeError || /failed to fetch|networkerror/i.test(message)) {
    return "Can't reach the TripMate server. Check that it's running and try again.";
  }
  if (/all llms failed/i.test(message) || /rate.?limit|429/i.test(message)) {
    return "All AI models are busy or unavailable right now. Wait a minute and try again.";
  }
  if (/connection.*(timeout|refused)|could not connect|database/i.test(message)) {
    return "The planner couldn't reach its database. Check your network connection and try again.";
  }
  return message || "Something went wrong. Please try again.";
}

function showError(error) {
  els.errorText.textContent = friendlyError(error);
  els.error.hidden = false;
  els.error.style.animation = "none";
  void els.error.offsetWidth; // restart entrance animation
  els.error.style.animation = "";
}

function hideError() {
  els.error.hidden = true;
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error(`The server returned an unexpected response (${response.status}).`);
  }
  if (!response.ok || !data.success) {
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Running state                                                       */
/* ------------------------------------------------------------------ */

let runTimer = null;

function startRun(mode) {
  const copy = RUN_COPY[mode];
  state.busy = true;
  els.runTitle.textContent = copy.title;
  els.runHint.textContent = copy.hint;
  els.runElapsed.textContent = "0s";
  els.runAgents.hidden = mode !== "draft";
  [...els.runAgents.children].forEach((li, i) => li.style.setProperty("--i", i));

  els.howto.hidden = true;
  els.run.hidden = false;
  if (!els.workspace.hidden) els.workspace.classList.add("is-stale");

  const started = Date.now();
  clearInterval(runTimer);
  runTimer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    els.runElapsed.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    if (s === 90) els.runHint.textContent = "Taking longer than usual — local fallback models are slower";
  }, 1000);

  setControlsDisabled(true);
  requestAnimationFrame(() => scrollToEl(els.run));
}

function endRun() {
  state.busy = false;
  clearInterval(runTimer);
  els.run.hidden = true;
  els.workspace.classList.remove("is-stale");
  setControlsDisabled(false);
}

function setControlsDisabled(disabled) {
  const lockComposer = disabled || state.awaitingApproval;
  els.input.disabled = lockComposer;
  els.sendBtn.disabled = lockComposer;
  els.composer.querySelectorAll(".chip").forEach((chip) => (chip.disabled = lockComposer));
  els.approveBtn.disabled = disabled;
  els.reviseBtn.disabled = disabled;
  els.feedback.disabled = disabled;
  els.newPlanBtn.disabled = disabled;
}

function setLoading(button, loading) {
  button.classList.toggle("is-loading", loading);
  button.setAttribute("aria-busy", loading ? "true" : "false");
}

/* ------------------------------------------------------------------ */
/* Rendering a plan                                                    */
/* ------------------------------------------------------------------ */

function renderMeta(constraints) {
  els.meta.innerHTML = "";
  const c = constraints || {};
  const items = [];
  if (c.origin && c.destination) items.push(["pin", `${c.origin} → `, c.destination]);
  else if (c.destination) items.push(["pin", "", c.destination]);
  if (c.duration) items.push(["clock", "", c.duration]);
  if (c.budget) items.push(["wallet", "Budget ", c.budget]);
  if (c.travel_style) items.push(["sparkles", "", c.travel_style]);

  items.forEach(([iconName, prefix, value]) => {
    const li = el("li");
    const strong = el("strong", "", value);
    li.append(icon(iconName));
    if (prefix) li.append(document.createTextNode(prefix));
    li.append(strong);
    els.meta.appendChild(li);
  });
  els.meta.hidden = items.length === 0;
}

function renderPipeline(data) {
  const blocked = data.guardrail_allowed === false;
  els.guard.className = `guard${blocked ? " is-blocked" : ""}`;
  els.guard.replaceChildren(
    icon(blocked ? "shield-alert" : "shield-check"),
    document.createTextNode(blocked ? "Blocked by guardrail" : "Guardrail passed")
  );

  els.agentList.innerHTML = "";
  (data.selected_agents || []).forEach((name, i) => {
    const info = AGENTS[name] || { label: name, icon: "layers" };
    const li = el("li", "agent");
    li.style.setProperty("--i", i);
    li.append(icon(info.icon), document.createTextNode(info.label));
    els.agentList.appendChild(li);
  });

  const reasoning = (data.supervisor_reasoning || "").trim();
  els.reasoning.textContent = reasoning;
  els.whyBox.hidden = blocked || !reasoning;
  els.whyBox.open = false;
}

function buildToc() {
  const headings = [...els.result.querySelectorAll("h2, h3")];
  const used = new Set();
  els.tocList.innerHTML = "";
  headings.forEach((h) => {
    h.id = slugify(h.textContent, used);
    const li = el("li", h.tagName === "H3" ? "toc--sub" : "");
    const a = el("a", "", h.textContent.replace(/\s+/g, " ").trim());
    a.href = `#${h.id}`;
    li.appendChild(a);
    els.tocList.appendChild(li);
  });
  els.toc.hidden = headings.length < 3;
  if (!els.toc.hidden) watchHeadings(headings);
}

let headingObserver = null;
function watchHeadings(headings) {
  if (headingObserver) headingObserver.disconnect();
  const links = new Map([...els.tocList.querySelectorAll("a")].map((a) => [a.hash.slice(1), a]));
  headingObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((a) => a.classList.remove("is-active"));
        const active = links.get(entry.target.id);
        if (active) active.classList.add("is-active");
      });
    },
    { rootMargin: "-15% 0px -70% 0px" }
  );
  headings.forEach((h) => headingObserver.observe(h));
}

let revealObserver = null;
function revealOnScroll(container) {
  if (prefersReducedMotion || !("IntersectionObserver" in window)) return;
  if (revealObserver) revealObserver.disconnect();
  revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in-view");
        entry.target.classList.remove("in-view-pending");
        revealObserver.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -6% 0px" }
  );
  [...container.children].forEach((child, i) => {
    if (i < 3) return; // the first lines are already on screen
    child.classList.add("in-view-pending");
    revealObserver.observe(child);
  });
}

function renderResearch(data) {
  const available = RESEARCH.filter((r) => String(data[r.key] || "").trim());
  els.research.hidden = available.length === 0 || data.guardrail_allowed === false;
  if (els.research.hidden) return;

  els.tabs.querySelectorAll(".tab").forEach((t) => t.remove());
  available.forEach((r, i) => {
    const tab = el("button", "tab");
    tab.type = "button";
    tab.id = `tab-${r.key}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "researchPanel");
    tab.setAttribute("aria-selected", i === 0 ? "true" : "false");
    tab.tabIndex = i === 0 ? 0 : -1;
    tab.dataset.key = r.key;
    tab.append(icon(r.icon), document.createTextNode(r.label));
    tab.addEventListener("click", () => selectTab(tab, data));
    els.tabs.appendChild(tab);
  });
  selectTab(els.tabs.querySelector(".tab"), data, true);
}

function selectTab(tab, data, initial = false) {
  const tabs = [...els.tabs.querySelectorAll(".tab")];
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;
  });
  els.researchPanel.setAttribute("aria-labelledby", tab.id);

  const info = RESEARCH.find((r) => r.key === tab.dataset.key);
  const text = String(data[info.key] || "").trim();
  if (info.preformatted) {
    els.researchPanel.innerHTML = "";
    const pre = el("pre");
    pre.appendChild(el("code", "", text));
    els.researchPanel.appendChild(pre);
  } else {
    renderMarkdown(els.researchPanel, text);
  }
  els.researchPanel.scrollTop = 0;
  if (!initial) {
    els.researchPanel.classList.remove("is-switching");
    void els.researchPanel.offsetWidth;
    els.researchPanel.classList.add("is-switching");
  }
  moveIndicator(tab);
}

function moveIndicator(tab) {
  const indicator = els.tabs.querySelector(".tabs__indicator");
  if (!tab || !indicator) return;
  indicator.style.setProperty("--x", `${tab.offsetLeft}px`);
  indicator.style.setProperty("--w", `${tab.offsetWidth}px`);
}

function renderBlocked(data) {
  els.result.innerHTML = "";
  const note = el("div", "blocked-note");
  const body = el("div");
  body.append(
    el("h3", "", "TripMate can only help with travel planning"),
    el("p", "", data.guardrail_reason || data.answer || "This request was blocked by the travel guardrail.")
  );
  note.append(icon("shield-alert"), body);
  els.result.appendChild(note);
}

function renderResponse(data) {
  state.data = data;
  state.threadId = data.thread_id;
  state.awaitingApproval = Boolean(data.requires_approval);

  const blocked = data.guardrail_allowed === false;
  const destination = (data.trip_constraints || {}).destination;

  // Status badge + title
  els.badge.className = "badge";
  if (blocked) {
    els.badge.classList.add("badge--blocked");
    els.badge.textContent = "Not a travel request";
    els.title.textContent = "Request blocked";
  } else if (data.requires_approval) {
    const revision = (data.approval_request || "").match(/Revision (\d+)/i);
    els.badge.textContent = revision ? `Draft · revision ${revision[1]}` : "Draft · awaiting your review";
    els.title.textContent = destination ? `Your ${destination} trip` : "Your trip draft";
  } else {
    els.badge.classList.add("badge--final");
    els.badge.textContent = "Final plan";
    els.title.textContent = destination ? `Your ${destination} trip` : "Your travel plan";
  }

  renderMeta(blocked ? {} : data.trip_constraints);
  renderPipeline(data);

  if (blocked) {
    renderBlocked(data);
  } else {
    renderMarkdown(els.result, data.requires_approval ? data.itinerary || data.answer : data.answer);
  }
  if (blocked) {
    els.toc.hidden = true;
  } else {
    buildToc();
    revealOnScroll(els.result);
  }
  renderResearch(data);

  els.copyBtn.hidden = blocked;
  els.pdfBtn.hidden = blocked;
  els.threadInfo.textContent = data.thread_id ? `Plan ID ${data.thread_id}` : "";

  // Review bar + persistence
  if (data.requires_approval) {
    localStorage.setItem(PENDING_THREAD_KEY, data.thread_id);
    els.reviewText.textContent =
      data.approval_request || "Approve the draft, or tell the planner what to change.";
    els.feedback.value = "";
    autosize(els.feedback, 140);
    showReview(true);
  } else {
    localStorage.removeItem(PENDING_THREAD_KEY);
    showReview(false);
  }

  els.howto.hidden = true;
  els.workspace.hidden = false;
  els.composer.classList.toggle("is-locked", state.awaitingApproval);
  els.lock.hidden = !state.awaitingApproval;
  setControlsDisabled(false);
}

/* Review bar height feeds --review-h so content and toasts never sit under it. */
const reviewResize = new ResizeObserver(() => {
  const h = els.review.hidden ? 0 : els.review.offsetHeight;
  document.documentElement.style.setProperty("--review-h", `${h}px`);
});
reviewResize.observe(els.review);

function showReview(show) {
  els.review.hidden = !show;
  document.documentElement.style.setProperty("--review-h", show ? `${els.review.offsetHeight}px` : "0px");
}

function focusPlan() {
  els.title.setAttribute("tabindex", "-1");
  scrollToEl(els.workspace);
  els.title.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function sendMessage() {
  if (state.busy) return;
  hideError();

  if (state.awaitingApproval) {
    showError("Finish reviewing the current draft, or discard it, before starting a new plan.");
    return;
  }

  const message = els.input.value.trim();
  if (!message) {
    els.input.focus();
    showError("Describe the trip you'd like to plan first.");
    return;
  }

  setLoading(els.sendBtn, true);
  startRun("draft");
  try {
    const data = await api("/api/travel", { method: "POST", body: JSON.stringify({ message }) });
    endRun();
    renderResponse(data);
    focusPlan();
    if (data.requires_approval) toast("Draft ready for your review");
  } catch (error) {
    endRun();
    els.howto.hidden = !els.workspace.hidden; // bring back the empty state if there's no plan
    showError(error);
  } finally {
    setLoading(els.sendBtn, false);
  }
}

async function submitApproval(approved) {
  if (state.busy) return;
  hideError();

  if (!state.threadId || !state.awaitingApproval) {
    showError("There's no draft waiting for review.");
    return;
  }

  const feedback = els.feedback.value.trim();
  if (!approved && !feedback) {
    els.feedback.classList.remove("is-invalid");
    void els.feedback.offsetWidth;
    els.feedback.classList.add("is-invalid");
    els.feedback.placeholder = "Tell the planner what to change first…";
    els.feedback.focus();
    return;
  }

  const button = approved ? els.approveBtn : els.reviseBtn;
  setLoading(button, true);
  startRun(approved ? "final" : "revise");
  try {
    const data = await api("/api/travel/approve", {
      method: "POST",
      body: JSON.stringify({ thread_id: state.threadId, approved, feedback }),
    });
    endRun();
    renderResponse(data);
    focusPlan();
    toast(approved ? "Final plan ready" : "Revised draft ready for review");
  } catch (error) {
    endRun();
    showError(error);
  } finally {
    setLoading(button, false);
  }
}

function resetToStart() {
  localStorage.removeItem(PENDING_THREAD_KEY);
  Object.assign(state, { threadId: null, awaitingApproval: false, data: null });
  showReview(false);
  els.workspace.hidden = true;
  els.lock.hidden = true;
  els.composer.classList.remove("is-locked");
  els.howto.hidden = false;
  hideError();
  setControlsDisabled(false);
  window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
  els.input.focus({ preventScroll: true });
}

function startNewPlan() {
  if (state.awaitingApproval && !window.confirm("Discard the draft that's waiting for your review?")) return;
  resetToStart();
}

/* Clipboard API needs a secure context (https or localhost); fall back to a
   hidden textarea so copying also works when opened over plain http. */
function legacyCopy(text) {
  const area = el("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (_) {
    ok = false;
  }
  area.remove();
  return ok;
}

async function copyResult() {
  const text = els.result.innerText.trim();
  if (!text) return;
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error("no clipboard api");
    await navigator.clipboard.writeText(text);
    toast("Plan copied to clipboard");
  } catch (_) {
    if (legacyCopy(text)) toast("Plan copied to clipboard");
    else toast("Couldn't copy — select the text instead", "error");
  }
}

function downloadPDF() {
  if (typeof html2pdf === "undefined") {
    toast("PDF export is still loading — try again in a moment", "error");
    return;
  }
  const destination = ((state.data || {}).trip_constraints || {}).destination || "travel";
  const filename = `tripmate-${destination.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-plan.pdf`;

  // Export a light, print-style copy so dark mode doesn't end up in the PDF.
  const clone = els.planDoc.cloneNode(true);
  clone.classList.add("pdf-export");
  clone.querySelectorAll(".in-view-pending").forEach((n) => n.classList.remove("in-view-pending"));
  const heading = el("p", "", `${els.title.textContent} · ${els.badge.textContent}`);
  heading.style.cssText = "margin:0 0 20px;color:#7b7f79;font:600 12px Manrope,sans-serif;letter-spacing:.04em;text-transform:uppercase";
  clone.prepend(heading);

  setLoading(els.pdfBtn, true);
  els.pdfBtn.disabled = true;
  html2pdf()
    .set({
      margin: [0.4, 0.4, 0.5, 0.4],
      filename,
      image: { type: "jpeg", quality: 0.96 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
      jsPDF: { unit: "in", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"], avoid: ["tr", "h2", "h3", "li", "blockquote"] },
    })
    .from(clone)
    .save()
    .then(() => toast("PDF downloaded"))
    .catch(() => toast("Couldn't create the PDF", "error"))
    .finally(() => {
      setLoading(els.pdfBtn, false);
      els.pdfBtn.disabled = false;
    });
}

async function restorePendingDraft() {
  const threadId = localStorage.getItem(PENDING_THREAD_KEY);
  if (!threadId) return;
  try {
    const data = await api(`/api/travel/${encodeURIComponent(threadId)}`);
    if (data.requires_approval) {
      renderResponse(data);
      toast("Restored the draft awaiting your review");
    } else {
      localStorage.removeItem(PENDING_THREAD_KEY);
    }
  } catch (error) {
    if (/no travel plan found|404/i.test(error.message)) localStorage.removeItem(PENDING_THREAD_KEY);
  }
}

/* ------------------------------------------------------------------ */
/* Status + theme                                                      */
/* ------------------------------------------------------------------ */

function prettyModel(label) {
  const [provider, ...rest] = label.split(":");
  const name = rest.join(":").split("/").pop();
  return { provider: provider === "ollama" ? "local" : provider, name };
}

async function refreshStatus() {
  try {
    const response = await fetch("/health", { cache: "no-store" });
    const data = await response.json();
    const chain = data.llm_chain || [];
    els.statusPill.classList.add("is-online");
    els.statusPill.classList.remove("is-offline");
    if (chain.length) {
      const first = prettyModel(chain[0]);
      els.statusText.textContent = `Online · ${first.name}`;
      els.statusTip.innerHTML = "";
      els.statusTip.append(el("strong", "", "Model fallback order"));
      const list = el("ol");
      chain.forEach((label) => {
        const m = prettyModel(label);
        list.appendChild(el("li", "", `${m.name} (${m.provider})`));
      });
      els.statusTip.appendChild(list);
    } else {
      els.statusText.textContent = "Online";
      els.statusTip.textContent = data.message || "TripMate API is running.";
    }
  } catch (_) {
    els.statusPill.classList.remove("is-online");
    els.statusPill.classList.add("is-offline");
    els.statusText.textContent = "Offline";
    els.statusTip.textContent = "Can't reach the TripMate server.";
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeToggle.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});

els.input.addEventListener("input", () => autosize(els.input, 260));
els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendMessage();
  }
});

els.composer.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    els.input.value = chip.dataset.prompt;
    autosize(els.input, 260);
    els.input.focus();
    els.input.setSelectionRange(els.input.value.length, els.input.value.length);
  });
});

els.feedback.addEventListener("input", () => {
  autosize(els.feedback, 140);
  els.feedback.classList.remove("is-invalid");
});
els.feedback.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submitApproval(!els.feedback.value.trim());
  }
});

els.approveBtn.addEventListener("click", () => submitApproval(true));
els.reviseBtn.addEventListener("click", () => submitApproval(false));
els.copyBtn.addEventListener("click", copyResult);
els.pdfBtn.addEventListener("click", downloadPDF);
els.newPlanBtn.addEventListener("click", startNewPlan);
els.discardBtn.addEventListener("click", () => {
  if (window.confirm("Discard the draft that's waiting for your review?")) resetToStart();
});
els.errorClose.addEventListener("click", hideError);

els.tabs.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...els.tabs.querySelectorAll(".tab")];
  const current = tabs.indexOf(document.activeElement);
  if (current === -1) return;
  event.preventDefault();
  let next = current;
  if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
  if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = tabs.length - 1;
  tabs[next].focus();
  tabs[next].click();
});

window.addEventListener("resize", () => moveIndicator(els.tabs.querySelector('.tab[aria-selected="true"]')));

els.themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});
applyTheme(document.documentElement.dataset.theme || "light");

const topbar = document.querySelector(".topbar");
const onScroll = () => topbar.classList.toggle("is-scrolled", window.scrollY > 8);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

refreshStatus();
setInterval(refreshStatus, 60000);
restorePendingDraft();
