/* ── NIBEX Application Core ──────────────────────────────────── */

// ── Configuration ─────────────────────────────────────────────
const CONFIG = {
  supabaseUrl: 'https://ksrrurabddfngnhfoqln.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtzcnJ1cmFiZGRmbmduaGZvcWxuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MjM3MjAsImV4cCI6MjA5NTk5OTcyMH0.qMBCLb1X1FdR8LPjrswxAM6kJNRIeY6gt055-qYynNc',
  anthropicProxy: '/api/claude', // Server-side proxy for Anthropic API
};

// ── Score metadata ─────────────────────────────────────────────
const SCORE_META = {
  '-1': { label: 'Dereliction', desc: 'Active legal jeopardy — the business is in breach of a legal obligation creating risk to customers, employees, investors, or the business itself. A dimension ceiling of 2 is applied until resolved.', chipClass: 'chip-neg', btnClass: 'selected-neg' },
  '0':  { label: 'Absent', desc: 'Should exist but does not. No active harm but a meaningful gap.', chipClass: 'chip-0', btnClass: 'selected-0' },
  '1':  { label: 'Minimal', desc: 'Exists in name only. Would not survive scrutiny or pressure.', chipClass: 'chip-1', btnClass: 'selected-1' },
  '2':  { label: 'Basic', desc: 'A foundation exists but is incomplete, undocumented, or fragile.', chipClass: 'chip-2', btnClass: 'selected-2' },
  '3':  { label: 'Functional', desc: 'Works adequately for current needs. Identifiable gaps exist but are not critical.', chipClass: 'chip-3', btnClass: 'selected-3' },
  '4':  { label: 'Developed', desc: 'Well-established and systematic. Holds up under pressure or scrutiny.', chipClass: 'chip-4', btnClass: 'selected-4' },
  '5':  { label: 'Optimised', desc: 'Best practice for this type and scale of business. Systematic and monitored.', chipClass: 'chip-5', btnClass: 'selected-5' },
  'na': { label: 'N/A', desc: 'This sub-element genuinely does not apply to this business. Excluded from score calculation.', chipClass: 'chip-na', btnClass: 'selected-na' },
  'p':  { label: 'Pending', desc: 'Applicable but cannot be scored yet — insufficient information. Shown as a gap in the output.', chipClass: 'chip-pending', btnClass: 'selected-pending' },
};

// ── Offline data store ─────────────────────────────────────────
const LocalStore = {
  prefix: 'nibex_',

  set(key, value) {
    try {
      localStorage.setItem(this.prefix + key, JSON.stringify(value));
      return true;
    } catch(e) {
      console.error('LocalStore.set failed:', e);
      return false;
    }
  },

  get(key) {
    try {
      const item = localStorage.getItem(this.prefix + key);
      return item ? JSON.parse(item) : null;
    } catch(e) {
      return null;
    }
  },

  delete(key) {
    localStorage.removeItem(this.prefix + key);
  },

  // Queue a write for background sync
  queueSync(operation) {
    const queue = this.get('sync_queue') || [];
    queue.push({ ...operation, queuedAt: Date.now() });
    this.set('sync_queue', queue);
  },

  getSyncQueue() {
    return this.get('sync_queue') || [];
  },

  clearSyncQueue() {
    this.delete('sync_queue');
  }
};

// ── Connectivity manager ───────────────────────────────────────
const Connectivity = {
  isOnline: navigator.onLine,
  listeners: [],

  init() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.notify();
      SyncEngine.flush();
    });
    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.notify();
    });

    // Service worker sync message
    navigator.serviceWorker?.addEventListener('message', event => {
      if (event.data.type === 'SYNC_READY') SyncEngine.flush();
    });
  },

  onChange(fn) { this.listeners.push(fn); },
  notify() { this.listeners.forEach(fn => fn(this.isOnline)); }
};

// ── Sync engine ────────────────────────────────────────────────
const SyncEngine = {
  async save(sessionId, data) {
    // Always save locally first
    LocalStore.set(`session_${sessionId}`, data);

    if (Connectivity.isOnline && CONFIG.supabaseUrl) {
      await this.pushToCloud(sessionId, data);
    } else {
      // Queue for later
      LocalStore.queueSync({ type: 'upsert', sessionId, data });
      UI.showSyncStatus('offline');
    }
  },

  async flush() {
    const queue = LocalStore.getSyncQueue();
    if (!queue.length) return;

    UI.showSyncStatus('syncing');
    const failed = [];

    for (const op of queue) {
      try {
        await this.pushToCloud(op.sessionId, op.data);
      } catch(e) {
        failed.push(op);
      }
    }

    if (failed.length) {
      LocalStore.set('sync_queue', failed);
      UI.showSyncStatus('offline');
    } else {
      LocalStore.clearSyncQueue();
      UI.showSyncStatus('online');
    }
  },

  async pushToCloud(sessionId, data) {
  if (!CONFIG.supabaseUrl) return;
  
  const doRequest = async () => {
    return await fetch(`${CONFIG.supabaseUrl}/rest/v1/nibex_sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': CONFIG.supabaseKey,
        'Authorization': `Bearer ${Auth.token}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ id: sessionId, user_id: Auth.user?.id, data, updated_at: new Date().toISOString() })
    });
  };

  let response = await doRequest();
  
  if (response.status === 401) {
    const refreshed = await Auth.refresh();
    if (refreshed) {
      response = await doRequest();
    } else {
      UI.showSyncStatus('offline');
      throw new Error('Session expired — please sign in again');
    }
  }
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('Supabase sync failed:', response.status, errorText);
    throw new Error('Cloud sync failed');
  }
  
  UI.showSyncStatus('online');
},

  async load(sessionId) {
    // Try cloud first if online
    if (Connectivity.isOnline && CONFIG.supabaseUrl) {
      try {
        const response = await fetch(
          `${CONFIG.supabaseUrl}/rest/v1/nibex_sessions?id=eq.${sessionId}&select=data`,
          {
            headers: {
              'apikey': CONFIG.supabaseKey,
              'Authorization': `Bearer ${Auth.token}`
            }
          }
        );
        if (response.ok) {
          const rows = await response.json();
          if (rows.length) {
            const cloudData = rows[0].data;
            LocalStore.set(`session_${sessionId}`, cloudData);
            return cloudData;
          }
        }
      } catch(e) {
        console.warn('Cloud load failed, falling back to local');
      }
    }
    return LocalStore.get(`session_${sessionId}`);
  },

  async listSessions() {
    if (Connectivity.isOnline && CONFIG.supabaseUrl) {
      try {
        const response = await fetch(
          `${CONFIG.supabaseUrl}/rest/v1/nibex_sessions?select=id,data->>business_name,data->>nibex_score,updated_at&order=updated_at.desc`,
          {
            headers: {
              'apikey': CONFIG.supabaseKey,
              'Authorization': `Bearer ${Auth.token}`
            }
          }
        );
        if (response.ok) return await response.json();
      } catch(e) {}
    }
    // Fall back to local sessions
    return Object.keys(localStorage)
      .filter(k => k.startsWith('nibex_session_'))
      .map(k => {
        const data = LocalStore.get(k.replace('nibex_', ''));
        return { id: k.replace('nibex_session_', ''), data };
      });
  }
};

// ── Authentication ─────────────────────────────────────────────
const Auth = {
  token: null,
  user: null,

  async signIn(email, password) {
    if (!CONFIG.supabaseUrl) {
      // Dev mode — skip auth
      this.token = 'dev';
      this.user = { email };
      LocalStore.set('auth_token', 'dev');
      LocalStore.set('auth_user', { email });
      return { success: true };
    }

    const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': CONFIG.supabaseKey },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();
    if (response.ok) {
      this.token = data.access_token;
      this.user = data.user;
      LocalStore.set('auth_token', data.access_token);
      LocalStore.set('auth_refresh_token', data.refresh_token);
      LocalStore.set('auth_user', data.user);
      return { success: true };
    }
    return { success: false, error: data.error_description || 'Sign in failed' };
  },

  async signOut() {
    this.token = null;
    this.user = null;
    LocalStore.delete('auth_token');
    LocalStore.delete('auth_user');
  },
  
  async refresh() {
  if (!CONFIG.supabaseUrl) return false;
  try {
    const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': CONFIG.supabaseKey },
      body: JSON.stringify({ refresh_token: LocalStore.get('auth_refresh_token') })
    });
    if (response.ok) {
      const data = await response.json();
      this.token = data.access_token;
      LocalStore.set('auth_token', data.access_token);
      LocalStore.set('auth_refresh_token', data.refresh_token);
      return true;
    }
  } catch(e) {}
  return false;
},
  
  restore() {
    this.token = LocalStore.get('auth_token');
    this.user = LocalStore.get('auth_user');
    return !!this.token;
  }
};

// ── Session state ──────────────────────────────────────────────
const Session = {
  id: null,
  data: {
    business_name: '',
    business_type: '',
    owner_name: '',
    tier: 'standard',
    active_dimensions: [],
    scores: {},         // { 'dim.sub': score }
    notes: {},          // { 'dim.sub': string }
    tasks: {},          // { 'dim.sub': string }
    evidence_basis: {}, // { 'dim.sub': string }
    ai_suggestions: {}, // { 'dim.sub': { score, reasoning } }
    created_at: null,
    updated_at: null,
    nibex_score: null,
    dimension_scores: {}
  },

  new(businessName, tier = 'standard') {
    this.id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    this.data = {
      ...this.data,
      business_name: businessName,
      tier,
      active_dimensions: this.getDimensionsForTier(tier),
      created_at: new Date().toISOString(),
    };
  },

  getDimensionsForTier(tier) {
    const all = [1,2,3,4,5,6,7,8,9,10,11];
    const foundations = [6, 8, 9]; // Operations, Customer, Digital
    const standard = [1, 3, 5, 6, 8, 9, 10]; // + Economic, Revenue, Stakeholders, Strategic
    return tier === 'foundations' ? foundations : tier === 'complete' ? all : standard;
  },

  setScore(dimId, subId, score) {
    const key = `${dimId}.${subId}`;
    this.data.scores[key] = score;
    this.data.updated_at = new Date().toISOString();
    this.recalculate();
    this.save();
  },

  setNotes(dimId, subId, text) {
    this.data.notes[`${dimId}.${subId}`] = text;
    this.data.updated_at = new Date().toISOString();
    this.save();
  },

  setTasks(dimId, subId, text) {
    this.data.tasks[`${dimId}.${subId}`] = text;
    this.data.updated_at = new Date().toISOString();
    this.save();
  },

  setEvidence(dimId, subId, basis) {
    this.data.evidence_basis[`${dimId}.${subId}`] = basis;
    this.save();
  },

  setAISuggestion(dimId, subId, suggestion) {
    this.data.ai_suggestions[`${dimId}.${subId}`] = suggestion;
    this.save();
  },

  recalculate() {
    const dimScores = {};
    let totalWeightedScore = 0;
    let totalWeight = 0;

    for (const dimDef of DIMENSIONS) {
      if (!this.data.active_dimensions.includes(dimDef.id)) continue;

      let dimTotal = 0;
      let dimCount = 0;
      let hasDereliction = false;

      for (const sub of dimDef.subElements) {
        const key = `${dimDef.id}.${sub.id}`;
        const score = this.data.scores[key];
        if (score === undefined || score === 'na' || score === 'p') continue;
        const numeric = score === '-1' ? -1 : Number(score);
        if (numeric === -1) hasDereliction = true;
        dimTotal += numeric;
        dimCount++;
      }

      if (dimCount === 0) continue;

      let dimAvg = dimTotal / dimCount;
      if (hasDereliction && dimAvg > 2) dimAvg = 2; // Apply ceiling
      dimScores[dimDef.id] = { score: dimAvg, hasDereliction, count: dimCount, total: dimDef.subElements.length };

      const weight = dimDef.weight || 1;
      totalWeightedScore += dimAvg * weight;
      totalWeight += weight;
    }

    this.data.dimension_scores = dimScores;

    if (totalWeight > 0) {
      const rawScore = totalWeightedScore / totalWeight;
      // Normalise from -1..5 range to 0..100
      this.data.nibex_score = Math.round(((rawScore + 1) / 6) * 100);
    }
  },

  async save() {
    await SyncEngine.save(this.id, this.data);
    UI.updateNibexBanner();
    UI.updateTabStatuses();
  },

  async load(sessionId) {
    const data = await SyncEngine.load(sessionId);
    if (data) {
      this.id = sessionId;
      this.data = data;
      return true;
    }
    return false;
  },

  getTabStatus(dimId) {
    const dimDef = DIMENSIONS.find(d => d.id === dimId);
    if (!dimDef) return 'not-started';

    let hasDereliction = false;
    let scored = 0;
    let total = dimDef.subElements.length;

    for (const sub of dimDef.subElements) {
      const key = `${dimId}.${sub.id}`;
      const score = this.data.scores[key];
      if (score !== undefined) {
        scored++;
        if (score === '-1') hasDereliction = true;
      }
    }

    if (hasDereliction) return 'derelict';
    if (scored === 0) return 'not-started';
    if (scored < total) return 'in-progress';
    return 'complete';
  }
};

// ── AI scoring ─────────────────────────────────────────────────
const AIScoring = {
  async suggest(dimId, subId, notes, scoringCriteria, question) {
    const sub = DIMENSIONS.find(d => d.id === dimId)?.subElements.find(s => s.id === subId);
    if (!sub) return null;

    const prompt = `You are an expert business assessor using the NIBEX (Nicomachea Business Index) framework.

Assess the following sub-element and suggest a score based on the assessor's notes.

SUB-ELEMENT: ${sub.label}
DIMENSION: ${DIMENSIONS.find(d => d.id === dimId)?.label}

SCORING SCALE:
-1 = Dereliction — active legal jeopardy or legal breach
0 = Absent — should exist but does not
1 = Minimal — exists in name only
2 = Basic — foundation exists but fragile
3 = Functional — works for current needs, gaps exist
4 = Developed — systematic, holds under pressure
5 = Optimised — best practice for type and scale
N/A = Not applicable to this business
Pending = Cannot assess with available information

SCORING CRITERIA FOR THIS SUB-ELEMENT:
${scoringCriteria}

ASSESSOR'S NOTES:
${notes}

Respond ONLY with valid JSON in this exact format:
{"score": "-1|0|1|2|3|4|5|na|p", "reasoning": "One to two sentences explaining the suggested score based on the notes provided."}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) throw new Error('API error');
      const data = await response.json();
      const text = data.content?.[0]?.text || '';
      const cleaned = text.replace(/```json|```/g, '').trim();
      return JSON.parse(cleaned);
    } catch(e) {
      console.error('AI scoring failed:', e);
      return null;
    }
  }
};

// ── UI ─────────────────────────────────────────────────────────
const UI = {
  currentDim: null,

  showSyncStatus(status) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    el.className = 'sync-indicator sync-' + status;
    el.innerHTML = status === 'online' ? '● Synced' : status === 'offline' ? '● Offline' : '↻ Syncing';
  },

  updateNibexBanner() {
    const scoreEl = document.getElementById('nibex-score');
    if (!scoreEl) return;
    const score = Session.data.nibex_score;
    scoreEl.textContent = score !== null ? score : '—';

    // Check for any derelictions
    const hasDerelictions = Object.values(Session.data.scores).includes('-1');
    const ceilingWarn = document.getElementById('ceiling-warning');
    if (ceilingWarn) ceilingWarn.style.display = hasDerelictions ? 'flex' : 'none';
  },

  updateTabStatuses() {
    const tabs = document.querySelectorAll('.tab[data-dim]');
    tabs.forEach(tab => {
      const dimId = parseInt(tab.dataset.dim);
      const status = Session.getTabStatus(dimId);
      const dot = tab.querySelector('.tab-status');
      if (dot) {
        dot.className = 'tab-status ' + status;
      }
      // Update count
      const dimDef = DIMENSIONS.find(d => d.id === dimId);
      if (dimDef) {
        const scored = dimDef.subElements.filter(s =>
          Session.data.scores[`${dimId}.${s.id}`] !== undefined
        ).length;
        const countEl = tab.querySelector('.tab-count');
        if (countEl) countEl.textContent = `${scored}/${dimDef.subElements.length}`;
      }
    });
  },

  switchTab(dimId) {
    // Hide all panels
    document.querySelectorAll('.dimension-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));

    // Show selected
    const panel = document.getElementById(`dim-panel-${dimId}`);
    const tab = document.querySelector(`.tab[data-dim="${dimId}"]`);
    if (panel) panel.classList.add('active');
    if (tab) {
      tab.classList.add('active');
      tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }

    this.currentDim = dimId;
    LocalStore.set('last_tab', dimId);

    // Restore open sub-element for this dimension
    const lastOpen = LocalStore.get(`open_sub_${dimId}`);
    if (lastOpen) {
      const sub = document.getElementById(`sub-${dimId}-${lastOpen}`);
      if (sub) this.openSubElement(sub);
    }
  },

  openSubElement(subEl) {
    subEl.classList.add('open');
    const ta = subEl.querySelector('textarea');
    if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
  },

  toggleSubElement(subEl) {
    const isOpen = subEl.classList.contains('open');
    // Close all others in this dimension
    const panel = subEl.closest('.dimension-panel');
    panel?.querySelectorAll('.sub-element.open').forEach(s => s.classList.remove('open'));

    if (!isOpen) {
      this.openSubElement(subEl);
      const subId = subEl.dataset.sub;
      const dimId = subEl.dataset.dim;
      LocalStore.set(`open_sub_${dimId}`, subId);
    } else {
      LocalStore.delete(`open_sub_${this.currentDim}`);
    }
  },

  renderScoreChip(score) {
    const meta = SCORE_META[String(score)];
    if (!meta) return '<span class="sub-element-score-chip chip-empty">—</span>';
    const label = score === 'na' ? 'N/A' : score === 'p' ? 'P' : score;
    return `<span class="sub-element-score-chip ${meta.chipClass}">${label}</span>`;
  },

  selectScore(dimId, subId, score, btnEl) {
    // Update button states
    const row = btnEl.closest('.score-buttons');
    row.querySelectorAll('.score-btn').forEach(b => {
      b.className = 'score-btn';
    });
    const meta = SCORE_META[String(score)];
    if (meta) btnEl.classList.add(meta.btnClass);

    // Show descriptor
    const descriptor = btnEl.closest('.score-section').querySelector('.score-descriptor');
    if (descriptor && meta) {
      descriptor.textContent = `${meta.label} — ${meta.desc}`;
      descriptor.className = `score-descriptor visible ${meta.btnClass.replace('selected-', 'desc-')}`;
      // Apply colour to descriptor
      if (score === '-1') descriptor.style.background = 'var(--score-neg-bg)';
      else if (score === '5') descriptor.style.background = 'var(--score-max-bg)';
      else if (score === '4') descriptor.style.background = 'var(--score-high-bg)';
      else if (score === '3') descriptor.style.background = 'var(--score-mid-bg)';
      else descriptor.style.background = 'var(--surface-raised)';
    }

    // Update header chip
    const subEl = document.getElementById(`sub-${dimId}-${subId}`);
    const chipSlot = subEl?.querySelector('.chip-slot');
    if (chipSlot) chipSlot.innerHTML = this.renderScoreChip(score);

    // Apply dereliction class
    if (subEl) {
      subEl.classList.toggle('derelict', score === '-1');
    }

    // Save
    Session.setScore(dimId, subId, score);

    // Update dimension progress
    this.updateDimensionProgress(dimId);
  },

  updateDimensionProgress(dimId) {
    const dimDef = DIMENSIONS.find(d => d.id === dimId);
    if (!dimDef) return;
    const total = dimDef.subElements.length;
    const scored = dimDef.subElements.filter(s =>
      Session.data.scores[`${dimId}.${s.id}`] !== undefined
    ).length;
    const pct = total ? Math.round((scored / total) * 100) : 0;
    const fill = document.getElementById(`progress-fill-${dimId}`);
    const label = document.getElementById(`progress-label-${dimId}`);
    if (fill) fill.style.width = pct + '%';
    if (label) label.textContent = `${scored} of ${total} scored`;
  },

  async requestAIScore(dimId, subId, btnEl) {
    const sub = DIMENSIONS.find(d => d.id === dimId)?.subElements.find(s => s.id === subId);
    if (!sub) return;

    const notesEl = document.getElementById(`notes-${dimId}-${subId}`);
    const notes = notesEl?.value?.trim();

    if (!notes || notes.length < 20) {
      alert('Please add some notes about this sub-element before requesting an AI score. The AI needs context to make a useful suggestion.');
      return;
    }

    const loadingEl = document.getElementById(`ai-loading-${dimId}-${subId}`);
    const suggestionEl = document.getElementById(`ai-suggestion-${dimId}-${subId}`);
    if (loadingEl) loadingEl.classList.add('visible');
    if (suggestionEl) suggestionEl.classList.remove('visible');
    btnEl.disabled = true;

    const result = await AIScoring.suggest(dimId, subId, notes, sub.scoringCriteria || '', sub.question || '');

    if (loadingEl) loadingEl.classList.remove('visible');
    btnEl.disabled = false;

    if (result) {
      Session.setAISuggestion(dimId, subId, result);
      const meta = SCORE_META[result.score];
      const scoreLabel = meta ? `${result.score} — ${meta.label}` : result.score;

      const suggestedScoreEl = document.getElementById(`ai-suggested-score-${dimId}-${subId}`);
      const reasoningEl = document.getElementById(`ai-reasoning-${dimId}-${subId}`);

      if (suggestedScoreEl) suggestedScoreEl.textContent = `Suggested: ${scoreLabel}`;
      if (reasoningEl) reasoningEl.textContent = result.reasoning;
      if (suggestionEl) suggestionEl.classList.add('visible');
    } else {
      alert('AI scoring is not available right now. Please score manually.');
    }
  },

  acceptAIScore(dimId, subId) {
    const suggestion = Session.data.ai_suggestions[`${dimId}.${subId}`];
    if (!suggestion) return;

    const scoreSection = document.querySelector(`#sub-${dimId}-${subId} .score-section`);
    const btn = scoreSection?.querySelector(`.score-btn[data-score="${suggestion.score}"]`);
    if (btn) {
      this.selectScore(dimId, subId, suggestion.score, btn);
    }

    // Mark evidence as AI-assisted
    Session.setEvidence(dimId, subId, 'AI-assisted — assessor confirmed');
    const evidenceSelect = document.getElementById(`evidence-${dimId}-${subId}`);
    if (evidenceSelect) evidenceSelect.value = 'AI-assisted — assessor confirmed';
  }
};

// ── App router ─────────────────────────────────────────────────
const App = {
  async init() {
    // Register service worker
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('./sw.js');
      } catch(e) {
        console.warn('SW registration failed:', e);
      }
    }

    Connectivity.init();
    Connectivity.onChange(online => UI.showSyncStatus(online ? 'online' : 'offline'));

    const isAuthed = Auth.restore();
    if (!isAuthed) {
      this.showAuth();
    } else {
      this.showSessionPicker();
    }
  },

  showAuth() {
    document.getElementById('app').innerHTML = this.renderAuth();
  },

  async handleSignIn(e) {
    e.preventDefault();
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    const errorEl = document.getElementById('auth-error');
    const btn = document.getElementById('auth-btn');

    btn.textContent = 'Signing in...';
    btn.disabled = true;

    const result = await Auth.signIn(email, password);

    if (result.success) {
      App.showSessionPicker();
    } else {
      errorEl.textContent = result.error;
      errorEl.style.display = 'block';
      btn.textContent = 'Sign in';
      btn.disabled = false;
    }
  },

  async showSessionPicker() {
    const sessions = await SyncEngine.listSessions();
    document.getElementById('app').innerHTML = this.renderSessionPicker(sessions);
  },

  showAssessment(sessionId) {
    Session.load(sessionId).then(() => {
      this.renderAssessment();
    });
  },

  newSession() {
    const name = prompt('Business name:');
    if (!name?.trim()) return;
    Session.new(name.trim());
    this.renderAssessment();
  },

  renderAssessment() {
    document.getElementById('app').innerHTML = this.buildAssessmentHTML();

    // Restore last active tab
    const lastTab = LocalStore.get('last_tab');
    const firstDim = Session.data.active_dimensions[0];
    UI.switchTab(lastTab && Session.data.active_dimensions.includes(lastTab) ? lastTab : firstDim);

    UI.updateNibexBanner();
    UI.updateTabStatuses();

    // Init auto-resize on all textareas
    document.querySelectorAll('textarea').forEach(ta => {
      ta.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = this.scrollHeight + 'px';
      });
    });

    UI.showSyncStatus(Connectivity.isOnline ? 'online' : 'offline');
  },

  buildAssessmentHTML() {
    const activeDims = Session.data.active_dimensions.map(id => DIMENSIONS.find(d => d.id === id)).filter(Boolean);

    const tabs = activeDims.map(dim => `
      <div class="tab" data-dim="${dim.id}" onclick="UI.switchTab(${dim.id})">
        <span class="tab-num">${dim.id}</span>
        <span>${dim.shortLabel}</span>
        <div class="tab-status not-started"></div>
        <span class="tab-count" style="font-size:11px;color:var(--ink-faint)">0/${dim.subElements.length}</span>
      </div>
    `).join('');

    const panels = activeDims.map(dim => this.buildDimensionPanel(dim)).join('');

    return `
      <div class="toolbar">
        <div class="toolbar-brand">
          NIBEX
          <span>Nicomachea Business Assessment</span>
        </div>
        <div class="toolbar-meta">
          <div id="sync-status" class="sync-indicator sync-offline">● Offline</div>
        </div>
      </div>

      <div class="tab-bar" id="tab-bar">${tabs}</div>

      <div class="main">
        <div class="nibex-banner">
          <div>
            <div class="nibex-score-label">NIBEX Score</div>
            <div class="nibex-score-display">
              <span class="nibex-score-number" id="nibex-score">—</span>
              <span class="nibex-score-denom">/100</span>
            </div>
          </div>
          <div>
            <div class="nibex-score-label" style="text-align:right">${Session.data.business_name}</div>
            <div class="nibex-tier-badge">${Session.data.tier}</div>
          </div>
        </div>

        <div id="ceiling-warning" class="ceiling-warning" style="display:none">
          ⚠ One or more dimensions have dereliction flags applied. Affected dimension scores are capped at 2 until resolved.
        </div>

        ${panels}

        <div style="height:100px;flex-shrink:0;"></div>
      </div>

      <div class="bottom-bar">
        <button class="btn btn-ghost" onclick="App.showSessionPicker()">← Sessions</button>
        <button class="btn btn-primary" onclick="App.generateTaskList()">Generate task list</button>
      </div>
    `;
  },

  buildDimensionPanel(dim) {
    const subElements = dim.subElements.map(sub => this.buildSubElement(dim.id, sub)).join('');

    return `
      <div class="dimension-panel" id="dim-panel-${dim.id}">
        <div class="dimension-header">
          <div class="dimension-title">${dim.id}. ${dim.label}</div>
          <div class="dimension-meta">
            <span>${dim.subElements.length} sub-elements</span>
            <span>${dim.description || ''}</span>
          </div>
          <div class="dimension-progress">
            <div class="progress-bar">
              <div class="progress-fill" id="progress-fill-${dim.id}" style="width:0%"></div>
            </div>
            <span class="progress-label" id="progress-label-${dim.id}">0 of ${dim.subElements.length} scored</span>
          </div>
        </div>
        ${subElements}
      </div>
    `;
  },

  buildSubElement(dimId, sub) {
    const key = `${dimId}.${sub.id}`;
    const currentScore = Session.data.scores[key];
    const currentNotes = Session.data.notes[key] || '';
    const currentTasks = Session.data.tasks[key] || '';
    const currentEvidence = Session.data.evidence_basis[key] || '';

    const scoreButtons = ['-1','0','1','2','3','4','5','na','p'].map(s => {
      const label = s === 'na' ? 'N/A' : s === 'p' ? 'P' : s;
      const meta = SCORE_META[s];
      const selectedClass = currentScore === s ? (meta?.btnClass || '') : '';
      return `<button class="score-btn ${selectedClass}" data-score="${s}"
        onclick="UI.selectScore(${dimId}, '${sub.id}', '${s}', this)">${label}</button>`;
    }).join('');

    const currentMeta = currentScore ? SCORE_META[String(currentScore)] : null;
    const descriptorText = currentMeta ? `${currentMeta.label} — ${currentMeta.desc}` : '';
    const descriptorVisible = currentMeta ? 'visible' : '';

    return `
      <div class="sub-element" id="sub-${dimId}-${sub.id}" data-dim="${dimId}" data-sub="${sub.id}">
        <div class="sub-element-header" onclick="UI.toggleSubElement(this.closest('.sub-element'))">
          <span class="sub-element-num">${dimId}.${sub.id}</span>
          <span class="sub-element-title">${sub.label}</span>
          <span class="chip-slot">${UI.renderScoreChip(currentScore)}</span>
          <i class="ti ti-chevron-down chevron" aria-hidden="true"></i>
        </div>
        <div class="sub-element-body">

          ${sub.question ? `
          <div class="guidance-toggle" onclick="this.nextElementSibling.classList.toggle('open')">
            <i class="ti ti-help-circle" aria-hidden="true" style="font-size:16px"></i>
            Assessment guidance
            <i class="ti ti-chevron-down" aria-hidden="true" style="font-size:14px"></i>
          </div>
          <div class="guidance-panel">
            ${sub.question ? `<div class="guidance-section"><div class="guidance-label">Ask the client</div><div class="guidance-text">${sub.question}</div></div>` : ''}
            ${sub.listenFor ? `<div class="guidance-section"><div class="guidance-label">Listen for</div><div class="guidance-text">${sub.listenFor}</div></div>` : ''}
            ${sub.scoringCriteria ? `<div class="guidance-section"><div class="guidance-label">Scoring guide</div><div class="guidance-text">${sub.scoringCriteria}</div></div>` : ''}
          </div>` : ''}

          <div class="field-group">
            <label class="field-label" for="notes-${dimId}-${sub.id}">Assessor notes</label>
            <textarea id="notes-${dimId}-${sub.id}" placeholder="Record what the client said, what you observed, and any relevant context..."
              oninput="Session.setNotes(${dimId}, '${sub.id}', this.value)">${currentNotes}</textarea>
          </div>

          <div class="ai-section">
            <div class="ai-header">
              <span class="ai-label">AI scoring</span>
              <button class="ai-analyse-btn" onclick="UI.requestAIScore(${dimId}, '${sub.id}', this)">
                <i class="ti ti-sparkles" aria-hidden="true" style="font-size:14px"></i>
                Analyse notes
              </button>
            </div>
            <div class="ai-loading" id="ai-loading-${dimId}-${sub.id}">Analysing notes...</div>
            <div class="ai-suggestion" id="ai-suggestion-${dimId}-${sub.id}">
              <div class="ai-suggestion-header">
                <span class="ai-suggested-score" id="ai-suggested-score-${dimId}-${sub.id}"></span>
                <button class="ai-accept-btn" onclick="UI.acceptAIScore(${dimId}, '${sub.id}')">Accept</button>
              </div>
              <div class="ai-reasoning" id="ai-reasoning-${dimId}-${sub.id}"></div>
            </div>
          </div>

          <div class="score-section">
            <div class="score-label">Score</div>
            <div class="score-buttons">${scoreButtons}</div>
            <div class="score-descriptor ${descriptorVisible}" style="${currentScore === '-1' ? 'background:var(--score-neg-bg)' : currentScore === '5' ? 'background:var(--score-max-bg)' : ''}">${descriptorText}</div>
          </div>

          <div class="tasks-section">
            <label class="tasks-label" for="tasks-${dimId}-${sub.id}">Tasks to be completed</label>
            <textarea id="tasks-${dimId}-${sub.id}" placeholder="List any actions required to address gaps or improve this sub-element..."
              oninput="Session.setTasks(${dimId}, '${sub.id}', this.value)">${currentTasks}</textarea>
          </div>

          <div class="evidence-section field-group">
            <label class="field-label" for="evidence-${dimId}-${sub.id}">Evidence basis</label>
            <select id="evidence-${dimId}-${sub.id}" onchange="Session.setEvidence(${dimId}, '${sub.id}', this.value)">
              <option value="">— select —</option>
              <option ${currentEvidence === 'Document verified' ? 'selected' : ''}>Document verified</option>
              <option ${currentEvidence === 'Client disclosed' ? 'selected' : ''}>Client disclosed</option>
              <option ${currentEvidence === 'Assessor observation' ? 'selected' : ''}>Assessor observation</option>
              <option ${currentEvidence === 'Public record' ? 'selected' : ''}>Public record</option>
              <option ${currentEvidence === 'AI-assisted — assessor confirmed' ? 'selected' : ''}>AI-assisted — assessor confirmed</option>
              <option ${currentEvidence === 'Unverifiable — Pending' ? 'selected' : ''}>Unverifiable — Pending</option>
            </select>
          </div>

        </div>
      </div>
    `;
  },

  generateTaskList() {
    const tasks = [];
    for (const [key, task] of Object.entries(Session.data.tasks)) {
      if (!task?.trim()) continue;
      const [dimId, subId] = key.split('.');
      const dim = DIMENSIONS.find(d => d.id === parseInt(dimId));
      const sub = dim?.subElements.find(s => s.id === subId);
      if (!sub) continue;
      const score = Session.data.scores[key];
      tasks.push({ dimension: dim.label, subElement: sub.label, task, score });
    }

    if (!tasks.length) {
      alert('No tasks recorded yet. Add tasks to sub-elements as you complete the assessment.');
      return;
    }

    const html = `
      <div style="padding:16px">
        <h2 style="font-family:var(--font-serif);font-size:24px;margin-bottom:16px">Task completion list — ${Session.data.business_name}</h2>
        ${tasks.map(t => `
          <div style="border:0.5px solid var(--rule);border-radius:var(--radius);padding:12px;margin-bottom:8px">
            <div style="font-size:11px;color:var(--ink-muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">${t.dimension} — ${t.subElement}</div>
            <div style="font-size:14px">${t.task}</div>
          </div>
        `).join('')}
      </div>
    `;

    const win = window.open('', '_blank');
    win.document.write(`<!DOCTYPE html><html><head><title>Task list</title><link rel="stylesheet" href="/styles.css"></head><body>${html}</body></html>`);
  },

  renderAuth() {
    return `
      <div class="auth-screen">
        <div class="auth-card">
          <div class="auth-brand">NIBEX<span>Nicomachea Business Assessment</span></div>
          <p class="auth-title">Sign in to access your assessments</p>
          <form onsubmit="App.handleSignIn(event)">
            <div class="field-group">
              <label class="field-label" for="auth-email">Email</label>
              <input type="email" id="auth-email" required autocomplete="email">
            </div>
            <div class="field-group" style="margin-top:12px">
              <label class="field-label" for="auth-password">Password</label>
              <input type="password" id="auth-password" required autocomplete="current-password">
            </div>
            <div id="auth-error" class="auth-error"></div>
            <button type="submit" id="auth-btn" class="btn btn-primary" style="width:100%;margin-top:16px">Sign in</button>
          </form>
        </div>
      </div>
    `;
  },

  renderSessionPicker(sessions) {
    const sessionCards = sessions.length ? sessions.map(s => {
      const name = s.data?.business_name || s.business_name || 'Unnamed session';
      const score = s.data?.nibex_score ?? s.nibex_score ?? '—';
      const date = s.data?.updated_at || s.updated_at;
      const dateStr = date ? new Date(date).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : '';
      return `
        <div class="session-card" onclick="App.showAssessment('${s.id}')">
          <div>
            <div class="session-name">${name}</div>
            <div class="session-meta">${dateStr}</div>
          </div>
          <div class="session-nibex">${score}</div>
        </div>
      `;
    }).join('') : '<p style="color:var(--ink-muted);font-size:14px;padding:16px 0">No assessments yet.</p>';

    return `
      <div style="padding:24px;max-width:600px;margin:0 auto">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:24px">
          <div>
            <div style="font-family:var(--font-serif);font-size:28px">NIBEX</div>
            <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:var(--gold)">Nicomachea Business Assessment</div>
          </div>
          <button class="btn btn-ghost" onclick="Auth.signOut().then(()=>App.showAuth())" style="height:36px;padding:0 12px;font-size:13px">Sign out</button>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <span style="font-size:14px;font-weight:500">Your assessments</span>
          <button class="btn btn-secondary" onclick="App.newSession()" style="height:36px;padding:0 16px;font-size:13px">+ New assessment</button>
        </div>
        ${sessionCards}
      </div>
    `;
  }
};

// ── Dimensions data ────────────────────────────────────────────
// Dimension 1 — Economic Position (full sub-elements with guidance)
// Remaining dimensions follow same structure
// Abbreviated here — full data in dimensions.js

const DIMENSIONS = [
  {
    id: 1,
    label: 'Economic position and trajectory',
    shortLabel: 'Economic',
    description: 'Financial health, trajectory, and monitoring quality',
    weight: 1.2,
    subElements: [
      {
        id: '1',
        label: 'Revenue trajectory',
        question: 'Can you walk me through how your turnover has changed over the last two or three years? Are you bringing in more than you were, about the same, or less?',
        listenFor: 'Vagueness about actual numbers, confusion between turnover and profit, defensive responses, lack of awareness that a trend exists at all.',
        scoringCriteria: '-1: Business reporting unverifiable turnover creating fraud exposure. 0: No awareness of revenue trend whatsoever. 1: Declining significantly, owner unaware or in denial. 2: Declining or flat with no strategy. 3: Stable, owner aware, no clear growth strategy. 4: Growing steadily, trend understood and planned. 5: Growing consistently, trend monitored with data, growth strategy actively managed.',
      },
      {
        id: '2',
        label: 'Profitability awareness',
        question: 'Do you have a clear sense of what your actual profit margin looks like — not just what comes in, but what\'s left after all costs?',
        listenFor: 'Confusion between turnover and profit. Owners who describe themselves as doing well based on how busy they are rather than what they earn.',
        scoringCriteria: '0: No awareness of profit or margin. 1: Knows if business feels profitable but has no data. 2: Approximate awareness, confuses turnover with profit. 3: Understands gross margin, limited net margin awareness. 4: Clear understanding of both, monitors regularly. 5: Precise margin awareness, tracked over time, margin improvement actively managed.',
      },
      {
        id: '3',
        label: 'Cash flow health',
        question: 'How does the business manage the gap between money going out and money coming in? Do you ever have periods where cash is tight?',
        listenFor: 'Periods of crisis described as normal. Hand-to-mouth operation. No cash reserve. Frequent use of personal funds to cover business shortfalls.',
        scoringCriteria: '-1: Business is insolvent or trading while unable to meet obligations as they fall due. 0: No cash flow awareness, operating hand to mouth with no understanding. 1: Reactive only, frequent crises, no reserve. 2: Some awareness, occasional problems, no forecast. 3: Managed reactively but consistently, basic reserve. 4: Proactively managed, adequate reserve, regular forecasting. 5: Cash flow forecast maintained and acted on, reserve policy defined.',
      },
      {
        id: '4',
        label: 'Debt position',
        question: 'Does the business carry any external debt — loans, finance agreements, HMRC payment plans, anything like that?',
        listenFor: 'Evasiveness. Mention of multiple creditors. Descriptions of juggling payments. HMRC arrears mentioned casually.',
        scoringCriteria: '-1: In arrears with HMRC, subject to enforcement, or CCJ outstanding. 0: Unmanaged debt with no awareness of total liability. 1: Significant debt, struggling to repay, no strategy. 2: Debt exists, repayments current but consuming significant cash flow. 3: Debt manageable, repayments current, some awareness. 4: Debt actively managed, repayment plan in place. 5: Debt used strategically, fully understood, repayment managed within forecast.',
      },
      {
        id: '5',
        label: 'Break-even clarity',
        question: 'Do you know the minimum amount you need to bring in each month to cover all your costs before you start making a profit?',
        listenFor: 'Blank look at the question. Describing break-even in terms of number of customers without knowing the revenue figure. Significant underestimation of fixed costs.',
        scoringCriteria: '0: No concept of break-even, cannot describe minimum viable revenue. 1: Vague awareness, significantly underestimates fixed costs. 2: Approximate understanding, not calculated formally. 3: Break-even calculated, not regularly reviewed. 4: Break-even known precisely, reviewed when costs change. 5: Break-even monitored continuously, used actively in pricing and capacity decisions.',
      },
      {
        id: '6',
        label: 'Financial monitoring quality',
        question: 'How do you keep track of your finances day to day — do you use accounting software, a spreadsheet, or something else? How often do you look at the numbers?',
        listenFor: 'Shoebox accounting. Annual-only engagement with finances. Owner who hasn\'t opened their accounts software in months. Reliance entirely on accountant with no own understanding.',
        scoringCriteria: '-1: No financial records kept whatsoever, creating tax evasion exposure. 0: Records exist but never looked at or acted on. 1: Annual records only, reactive. 2: Quarterly bookkeeping, basic software, occasional review. 3: Monthly bookkeeping, accounting software, owner reviews periodically. 4: Regular bookkeeping, management accounts produced, owner acts on data. 5: Real-time financial data, management accounts reviewed monthly, data drives decisions.',
      },
      {
        id: '7',
        label: 'Owner drawings and working capital',
        question: 'How do you pay yourself from the business — salary, dividends, or drawings as and when you need? Does that feel sustainable given where the business is?',
        listenFor: 'Ad hoc drawings with no structure. Owner taking more than the business can support. Drawings used to fund personal lifestyle rather than set proportionately to business performance.',
        scoringCriteria: '-1: Director drawings causing insolvency or preference payments ahead of creditors. 0: Drawings taken with no understanding of impact on working capital. 1: Ad hoc drawings, no salary structure, clear cash flow impact. 2: Some structure, drawings occasionally excessive. 3: Defined drawings, broadly proportionate, owner aware of working capital impact. 4: Structured salary and dividends, proportionate, working capital maintained. 5: Optimised remuneration, tax efficient, pension provision, no adverse working capital impact.',
      },
    ]
  },
  {
    id: 2, label: 'Market position and competitive context', shortLabel: 'Market', description: 'Market definition, competitive awareness, differentiation, and intelligence', weight: 1.0,
    subElements: [
      {
        id: '1',
        label: 'Market definition and understanding',
        question: 'Does the business have a documented understanding of the market it operates in — size, boundaries, characteristics, direction of travel? Is this based on evidence or assumption? When was it last updated?',
        scoringCriteria: '-1: Trading in a regulated market without understanding the regulatory requirements — active non-compliance jeopardy. 0: Cannot describe the market at all — no understanding of size, boundaries, or direction. 1: Vague sense of market, no documentation, purely assumption-based. 2: Broad awareness of market, loosely defined, not evidenced. 3: Market broadly understood, some evidence, not recently updated. 4: Clear documented understanding, evidence-based, reviewed periodically. 5: Precise documented market definition, evidence-based, regularly updated, regulatory requirements fully understood.',
      },
      {
        id: '2',
        label: 'Competitive landscape awareness',
        question: 'Can the owner name their direct and indirect competitors? Do they know how competitors price and position? Is this knowledge current or years old?',
        scoringCriteria: '-1: Making false comparative claims about competitors that breach Consumer Protection from Unfair Trading Regulations. 0: Cannot name a single competitor. 1: Knows competitors exist, has not assessed them. 2: Main competitors named, pricing and positioning not known. 3: Landscape understood, competitor positioning roughly known, not systematically monitored. 4: Competitive intelligence active, pricing and positioning known, updated at least annually. 5: Systematic competitive intelligence, pricing and positioning monitored continuously, differentiation tested against what is known.',
      },
      {
        id: '3',
        label: 'Differentiation and positioning',
        question: 'Why would a customer choose this business over an alternative? Is this reason specific and verifiable or vague? Is it consistently communicated? Has it been tested against what customers actually value?',
        scoringCriteria: '-1: False or misleading claims about differentiation — fabricated credentials, invented awards, or demonstrably untrue comparative claims creating jeopardy under consumer protection or advertising standards law. 0: No differentiation — sells to everyone, no positioning. 1: Vague differentiation claimed, not tested or consistently communicated. 2: Differentiation identified, not consistently communicated, not tested. 3: Positioning defined, communicated consistently, not formally tested. 4: Clear and specific differentiation, communicated consistently, informally validated with customers. 5: Precise positioning, consistently communicated, tested against customer data, competitive advantage demonstrably maintained.',
      },
      {
        id: '4',
        label: 'Target customer definition',
        question: 'Who is the ideal customer — described specifically by sector, size, geography, behaviour, or need? Is this validated against actual customer data? Or is the answer "anyone who needs X"?',
        scoringCriteria: '-1: Targeting customers in breach of consumer protection law — predatory practices targeting vulnerable people, or misleading claims designed to exploit a defined customer group. 0: No customer definition — anyone who needs the product or service. 1: Broad description only, not validated, no segmentation. 2: Customer type broadly identified, not validated against data. 3: Defined customer persona, partially validated against actual customer mix. 4: Clear customer definition, validated against customer data, used in marketing decisions. 5: Precisely defined ideal customer, validated and regularly updated against actual data, segmentation active.',
      },
      {
        id: '5',
        label: 'Market intelligence and monitoring',
        question: 'How does the business stay informed about what is happening in its market? Is competitor activity monitored? Are regulatory changes tracked? Is this systematic or reactive?',
        scoringCriteria: '-1: Failing to monitor a regulatory change the business was legally obliged to track, resulting in active non-compliance. 0: No market monitoring of any kind, entirely reactive. 1: Aware that monitoring should happen, no process. 2: Informal scanning, largely reactive, no systematic approach. 3: Competitor activity broadly monitored, regulatory changes tracked reactively. 4: Systematic monitoring of key indicators, competitor activity, and regulatory environment. 5: Comprehensive intelligence system, systematic and regular, proactively adjusts strategy in response.',
      },
    ]
  },
  {
    id: 3, label: 'Revenue model and pricing', shortLabel: 'Revenue', description: 'Revenue streams, pricing strategy, and value capture', weight: 1.0,
    subElements: [
      { id: '1', label: 'Revenue stream diversity', question: 'How many different ways does the business generate income? Is there any recurring revenue — retainers, subscriptions, contracts?', scoringCriteria: '0: Single stream, no awareness of risk. 1: Single stream, aware but no diversification. 2: Primarily single, one minor additional. 3: Two to three streams, primary dominates. 4: Multiple streams, some recurring, actively managed. 5: Diversified, significant recurring revenue, new streams developed.' },
      { id: '2', label: 'Pricing structure and confidence', question: 'How did you arrive at your current prices, and when did you last review them?', scoringCriteria: '0: No pricing structure, prices vary randomly. 1: Instinct only, not reviewed, clear underpricing. 2: Basic cost-plus, rarely reviewed, reluctant to increase. 3: Market rate awareness, occasional review. 4: Value-based elements, regular review, increases taken. 5: Strategic pricing, regularly reviewed and tested.' },
      { id: '3', label: 'Seasonality management', question: 'Does your business have busy and quiet periods through the year? How do you manage the quiet times financially?', scoringCriteria: 'N/A: Genuinely non-seasonal. 0: Highly seasonal, no awareness or management. 1: Seasonality recognised, no strategy. 2: Reactive to peak, quiet period endured. 3: Peak managed, quiet partially addressed. 4: Both periods actively managed, reserve built. 5: Fully incorporated into all planning, reserve policy defined.' },
      { id: '4', label: 'Average transaction value and upsell', question: 'Do you know what an average transaction or sale is worth? Do you have any systematic way of encouraging customers to spend more?', scoringCriteria: '0: No awareness of ATV, no upsell. 1: ATV vaguely known, occasional upsell by instinct. 2: ATV tracked, no systematic upsell. 3: ATV understood, some upsell considered. 4: ATV actively managed, systematic upsell. 5: ATV optimised, upsell and cross-sell systematic and refined.' },
    ]
  },
  {
    id: 4, label: 'Cost structure and financial obligations', shortLabel: 'Costs', description: 'Fixed costs, variable costs, break-even, obligations, and forecasting', weight: 1.0,
    subElements: [
      {
        id: '1',
        label: 'Fixed cost awareness',
        question: 'Can the owner list all fixed costs — rent, subscriptions, insurance, loan repayments, software, utilities? Is the list complete and current? When was it last reviewed?',
        scoringCriteria: '-1: Fixed cost obligations actively misrepresented to a lender, investor, or in statutory accounts — concealing lease commitments or loan obligations from a creditor. 0: Cannot identify fixed costs, no list exists. 1: Aware fixed costs exist, cannot list them completely. 2: Main fixed costs known, list incomplete, not recently reviewed. 3: Fixed costs listed, approximately complete, reviewed within the last year. 4: Complete and current fixed cost list, reviewed regularly, obligations tracked. 5: Comprehensive documented fixed cost list, regularly reviewed, benchmarked, actively managed for efficiency.',
      },
      {
        id: '2',
        label: 'Variable cost understanding',
        question: 'Which costs vary with output and by how much? Is contribution margin known at product or service level? Is pricing set with reference to variable cost structure?',
        scoringCriteria: '-1: Variable costs systematically misrepresented in pricing, contracts, or statutory reporting — quoting fixed prices on contracts while concealing known variable cost exposure that makes those contracts loss-making and potentially fraudulent. 0: Cannot distinguish variable from fixed costs. 1: Aware some costs vary, cannot quantify. 2: Main variable costs identified, contribution margin not calculated. 3: Variable costs understood, contribution margin approximately known. 4: Variable costs tracked, contribution margin calculated at product or service level, pricing reflects this. 5: Variable cost structure precisely understood, contribution margin by product or service line actively managed, pricing strategy built on it.',
      },
      {
        id: '3',
        label: 'Break-even awareness',
        question: 'Does the owner know their break-even point in revenue and unit terms? Has this been calculated precisely or estimated? Is it updated when costs change?',
        scoringCriteria: '-1: Business continuing to trade whilst knowingly insolvent — aware it cannot meet financial obligations as they fall due without taking appropriate legal steps, creating personal liability under the Insolvency Act 1986. 0: No concept of break-even. 1: Aware break-even exists as a concept, not calculated. 2: Break-even approximately estimated, not formally calculated. 3: Break-even calculated, not regularly updated. 4: Break-even known precisely, updated when costs change, used in pricing decisions. 5: Break-even monitored continuously in revenue and unit terms, integrated into all pricing, capacity, and financial decisions.',
      },
      {
        id: '4',
        label: 'Financial obligations tracking',
        question: 'Are all forward financial obligations — loans, leases, tax liabilities, contracted supplier costs — documented and tracked against cash flow? Any surprises in the last 12 months?',
        scoringCriteria: '-1: Failing to meet statutory financial obligations — HMRC tax payments, VAT returns, PAYE — triggering enforcement action. Or concealing financial obligations from a lender or creditor constituting fraud. 0: No tracking of financial obligations, surprises are normal. 1: Main obligations known, not tracked, surprises occur. 2: Obligations broadly known, informal tracking, occasional surprises. 3: Obligations documented, tracked against cash flow, rare surprises. 4: All obligations documented and tracked, cash flow forecast maintained, no surprises. 5: Comprehensive obligations register, all tracked against rolling cash flow forecast, proactively managed.',
      },
      {
        id: '5',
        label: 'Financial planning and forecasting',
        question: 'Is there a forward financial plan covering at least 12 months? What assumptions is it built on? Has any scenario planning been done for a revenue shortfall?',
        scoringCriteria: '-1: Submitting false financial projections to a lender, investor, or grant body — knowingly presenting fabricated forecasts to obtain funding, constituting fraud. 0: No financial plan, entirely reactive. 1: Mental plan only, no written forecast, no horizon beyond current month. 2: Basic forecast exists, assumptions not documented, no scenario planning. 3: 12-month plan exists, assumptions documented, limited scenario planning. 4: Forward plan with documented assumptions, scenario planning done, reviewed regularly. 5: Comprehensive financial plan, rolling 12-month forecast, multiple scenarios modelled, regularly updated and acted on.',
      },
    ]
  },
  {
    id: 5, label: 'Stakeholders, partners, and dependencies', shortLabel: 'Stakeholders', description: 'Ownership, key person risk, partnerships, and external relationships', weight: 1.0,
    subElements: [
      { id: '1', label: 'Ownership and governance structure', question: 'How is the business owned and structured? Is there a board or any external advisors who challenge your thinking?', scoringCriteria: '-1: Partnership trading without a partnership agreement. 0: No understanding of own legal structure. 1: Structure understood, no governance. 2: Structure understood, shareholders exist, no agreement. 3: Structure appropriate, basic governance, alignment maintained. 4: Structure optimised, governance exists, interests aligned. 5: Optimal structure, formal governance, shareholder agreement current.' },
      { id: '2', label: 'Key person dependency', question: 'If you were unavailable for three months — illness, family emergency — what would happen to the business? Which key relationships and knowledge sit with you personally?', scoringCriteria: '-1: Regulated business where key person holds mandatory certification with no succession or locum arrangement. 0: Total dependency, business stops, nothing documented. 1: Total dependency, owner aware, no mitigation. 2: High dependency, some knowledge documented. 3: Moderate dependency, basic contingency. 4: Dependency managed, knowledge documented, contingency tested. 5: Low dependency, business can operate without owner for extended periods.' },
      { id: '3', label: 'Partner and referral relationships', question: 'Are there other businesses or organisations that send work your way, or that you work alongside regularly? How are those relationships structured?', scoringCriteria: 'N/A: Operates entirely independently. 0: Significant dependency with no formal agreement. 1: Partners exist, fully informal. 2: Referral arrangements, mostly informal, occasional review. 3: Partner relationships managed, some formal. 4: Formal partnerships with agreements, actively managed. 5: Strategic partnership portfolio, all formalised, actively developed.' },
      { id: '4', label: 'Lender and investor relationships', question: 'Do you have any external finance — bank loans, investment, anything like that? How do you manage that relationship?', scoringCriteria: 'N/A: No external lenders or investors. -1: Covenant breach not disclosed to lender. 0: Lender relationships completely unmanaged. 1: Lender known, covenants not understood. 2: Covenants broadly understood, management inconsistent. 3: Covenants understood and met, relationship adequate. 4: Actively managed, covenants monitored, communication proactive. 5: Strategic lender relationship, comfortably met, proactive.' },
    ]
  },
  {
    id: 6, label: 'Operations and processes', shortLabel: 'Operations', description: 'Core processes, booking, payments, quality, and resilience', weight: 1.1,
    subElements: [
      { id: '1', label: 'Core process documentation', question: 'Are your main business processes written down anywhere, or does the knowledge of how things work sit mainly in people\'s heads?', scoringCriteria: '-1: Regulated processes legally required to be documented are not. 0: No documentation of any kind. 1: Owner knows processes, nothing written down. 2: Some processes written, inconsistently, not accessible. 3: Key processes documented and accessible, not regularly reviewed. 4: Most documented, accessible, reviewed periodically. 5: All key processes documented, version controlled, accessible, reviewed on schedule.' },
      { id: '2', label: 'Booking and order management', question: 'Walk me through what happens from the moment a customer wants to book or place an order to the point where it\'s confirmed. What does that process look like?', scoringCriteria: '0: No booking or order system for a business that needs one. 1: Paper diary or verbal only, no confirmation. 2: Basic digital calendar or WhatsApp, manual occasional confirmations. 3: Consistent method, manual confirmations, no automation. 4: Dedicated system, automated confirmations and reminders. 5: Integrated, automated full journey, no-show tracking, waiting list.' },
      { id: '3', label: 'Payment processing', question: 'How do customers pay you and how do you make sure payments are received on time?', scoringCriteria: '-1: Accepting payments without issuing any record, creating tax evasion exposure. 0: Cash only, no records. 1: Cash only, basic records. 2: Limited payment options, inconsistent invoicing. 3: Multiple options, consistent invoicing, basic reconciliation. 4: Efficient processing, clear terms, late payment process exists. 5: Fully integrated, automated reconciliation, proactive credit control.' },
      { id: '4', label: 'Stock and inventory management', question: 'How do you track what you have in stock and make sure you reorder before you run out?', scoringCriteria: 'N/A: Business holds no physical stock. 0: Stock held but no management system. 1: Manual counting, irregular, no reorder process. 2: Spreadsheet tracking, periodic counts, reactive reordering. 3: Consistent tracking, regular counts, basic reorder triggers. 4: Dedicated system, automated reorder points, wastage tracked. 5: Fully integrated, real-time visibility, automated reordering and wastage analysis.' },
      { id: '5', label: 'Customer records management', question: 'How do you keep track of your customer information — contact details, what they\'ve bought, that sort of thing?', scoringCriteria: '-1: Customer data held without ICO registration where required, or clear GDPR breach. 0: No customer records kept. 1: Names only, paper based. 2: Basic contact details, spreadsheet, no purchase history. 3: Contact and transaction history, basic CRM. 4: Comprehensive records, CRM in use, GDPR compliant. 5: Full CRM, automated data capture, segmentation, GDPR compliant with documented policy.' },
      { id: '6', label: 'Customer communications', question: 'When a customer contacts you, what happens? How quickly do you respond and how do you make sure nothing falls through the cracks?', scoringCriteria: '0: No defined communication method or process. 1: Phone only, no standard, reactive. 2: Multiple channels, inconsistent response, no outbound. 3: Consistent standard, some outbound, basic complaint handling. 4: Clear standards met consistently, planned outbound, documented complaint process. 5: Omnichannel, automated where appropriate, proactive outbound, complaint process tracked and used for improvement.' },
      { id: '7', label: 'Staff communications and rota management', question: 'How do you manage your team day to day — rotas, updates, changes at short notice?', scoringCriteria: 'N/A: Sole trader with no staff. 0: Staff present but no communication structure. 1: Verbal only, no advance planning. 2: WhatsApp group, rotas with minimal notice. 3: Consistent method, reasonable notice, some structure. 4: Dedicated tools, adequate notice, regular touchpoints. 5: Systematic communications, digital rota, regular structured meetings.' },
      { id: '8', label: 'Quality control', question: 'How do you make sure the work that leaves this business is consistently good? What happens when something doesn\'t meet your standard?', scoringCriteria: '0: No quality standard, no awareness of error rate. 1: Owner-dependent quality, no standard, no measurement. 2: Informal standard understood by owner, not communicated. 3: Quality standard defined, inconsistently applied. 4: Clear standard, consistently applied, complaints tracked. 5: Formal quality management, error rate tracked, systematic improvement, customer feedback loop.' },
      { id: '9', label: 'Operational resilience', question: 'What happens if your main piece of equipment breaks down, or your key supplier can\'t deliver, or you get an unexpected surge of demand?', scoringCriteria: '-1: Regulated business legally required to have continuity provisions that does not. 0: Total key person dependency, no contingency of any kind. 1: High dependency, informal awareness of what to do. 2: Some contingency thinking, not documented, single points known. 3: Key risks identified, basic contingencies in place. 4: Resilience actively managed, documented contingencies, alternatives identified. 5: Comprehensive planning, tested contingencies, documented responses.' },
    ]
  },
  {
    id: 7, label: 'People, capability, and culture', shortLabel: 'People', description: 'Structure, roles, capability, training, culture, and recruitment', weight: 1.0,
    subElements: [
      {
        id: '1',
        label: 'Organisational structure',
        question: 'Is there a defined structure with clear roles, responsibilities, and reporting lines? Does the owner operate within the structure or around it? In a sole trader business — is structure being considered for when the business grows?',
        scoringCriteria: '-1: Deliberately misrepresenting the organisational structure to a regulator or statutory body — falsely declaring directors, misrepresenting management structure to obtain regulated status, or concealing true control structure. 0: No structure of any kind, everyone does everything. 1: Structure implied but not defined, owner operates around it. 2: Basic structure understood but not documented, roles overlap. 3: Structure defined and documented, broadly followed. 4: Clear structure, actively maintained, roles and reporting lines understood by all. 5: Optimised structure, documented and reviewed, appropriate for current size and anticipated growth.',
      },
      {
        id: '2',
        label: 'Role definition and clarity',
        question: 'Do all people in the business — including the owner — have clearly defined, written responsibilities? Is there confusion about who owns what? Does the owner regularly step in to cover gaps?',
        scoringCriteria: '-1: Role definitions deliberately misrepresented to a regulator — falsely classifying someone as self-employed to avoid employer obligations, or misrepresenting a director\'s role to circumvent regulatory requirements. 0: No role definitions exist anywhere. 1: Roles informally understood, owner regularly covers gaps, nothing written. 2: Basic role descriptions exist for some people, inconsistently applied. 3: Roles defined and written for most positions including owner. 4: All roles clearly defined in writing, responsibilities unambiguous, gaps rare. 5: Comprehensive role definitions, regularly reviewed, owner works within defined strategic role. Note: Score N/A for genuine sole traders with no other people involved.',
      },
      {
        id: '3',
        label: 'Capability and skills assessment',
        question: 'Does the business have the right skills for what it is trying to do? Have capability gaps been identified? Is there a plan to address them?',
        scoringCriteria: '-1: Operating in a regulated area requiring specific qualifications or certifications without those qualifications being held — financial advice, legal services, medical practice, structural engineering, food safety. 0: No awareness of what skills the business needs or has. 1: Skills broadly known, gaps unidentified, no training or development. 2: Main skills known, key gaps identified, no plan to address them. 3: Skills inventory exists, gaps identified, some addressed. 4: Skills actively managed, gaps systematically addressed, training planned. 5: Comprehensive capability framework, gaps identified and addressed systematically, skills aligned to business direction.',
      },
      {
        id: '4',
        label: 'Training and development',
        question: 'Is there deliberate investment in developing skills — formal training, mentoring, structured learning? Is there a budget? Are development needs identified for each person including the owner?',
        scoringCriteria: '-1: Operating in a sector where mandatory training or certification is legally required — food safety, health and safety, financial services competency — and that training has not been completed or has lapsed. 0: No training of any kind, no investment in development. 1: Ad hoc training only when a crisis forces it, no budget, no plan. 2: Some training occurs, no structured plan, no budget. 3: Training planned for key roles, some budget, development needs informally identified. 4: Training programme in place, budget defined, development needs identified for each person. 5: Comprehensive development framework, training systematically delivered, budget reviewed, outcomes measured including for the owner.',
      },
      {
        id: '5',
        label: 'Culture and values',
        question: 'Does the business have defined values that are consistently modelled by the owner? Is there a gap between stated values and actual behaviour? In a multi-person business — do staff have a shared understanding of what is expected?',
        scoringCriteria: '-1: Culture actively harmful in a way creating legal jeopardy — systematic bullying, harassment, or discrimination enabled by the owner resulting or likely to result in employment tribunal proceedings or regulatory action. 0: No defined values, no culture of any kind — people do what they want. 1: Values exist informally in owner\'s head, not communicated or modelled consistently. 2: Values stated, inconsistently modelled, gap between stated and actual. 3: Values defined and communicated, owner broadly models them, some staff alignment. 4: Values embedded in how the business operates, consistently modelled, staff aligned. 5: Strong shared culture, values actively modelled by owner, embedded in hiring, development, and decisions.',
      },
      {
        id: '6',
        label: 'Recruitment and retention',
        question: 'Is there a consistent process for hiring? Are roles defined before recruitment begins? Is there any understanding of why people stay or leave? Does the business have an onboarding process?',
        scoringCriteria: '-1: Breaching employment law in recruitment or retention — discriminatory hiring practices, failure to carry out right to work checks, employing people without contracts, withholding pay in breach of National Minimum Wage Act. 0: No recruitment process, people hired informally with no defined role or onboarding. 1: Roles broadly in mind before recruiting, no process, no onboarding. 2: Basic recruitment process, minimal onboarding, no understanding of retention drivers. 3: Defined recruitment process, role defined before search, basic onboarding in place. 4: Consistent recruitment process, structured onboarding, exit interviews conducted. 5: Systematic recruitment and onboarding, retention actively managed, turnover understood and addressed. Note: Score N/A for genuine sole traders with no staff and no intention to hire.',
      },
    ]
  },
  {
    id: 8, label: 'Customer relationships and experience', shortLabel: 'Customers', description: 'Acquisition, retention, data, lifetime value, and advocacy', weight: 1.1,
    subElements: [
      { id: '1', label: 'Customer acquisition', question: 'How do most of your new customers find you at the moment? Do you know which channels are actually working?', scoringCriteria: '0: No awareness of how customers find the business. 1: Knows customers come somehow, no channel awareness. 2: Main channels identified, no cost or conversion awareness. 3: Channels understood, some deliberate acquisition. 4: Managed across multiple channels, cost broadly understood. 5: Systematic strategy, multi-channel, cost and conversion tracked.' },
      { id: '2', label: 'Customer retention', question: 'What proportion of your customers come back? Do you do anything deliberately to keep them coming back?', scoringCriteria: '0: No awareness of whether customers return. 1: Customers do return, no deliberate retention. 2: Retention broadly positive, no measurement, no strategy. 3: Retention monitored, some deliberate activity. 4: Retention actively managed, strategy in place, lapsed customers addressed. 5: Retention optimised, systematically managed, lapsed reactivation programme.' },
      { id: '3', label: 'Customer data and communication capability', question: 'Could you send a message to all your customers right now if you needed to? What contact data do you hold?', scoringCriteria: '-1: Customer data used for marketing without consent or ICO registration. 0: No customer data, cannot communicate with base. 1: Some contact data, no systematic communication. 2: Contact data held, occasional outbound, no segmentation. 3: Good contact data, regular outbound, limited segmentation. 4: Comprehensive data, regular targeted communication, basic segmentation. 5: Full CRM, automated and targeted, advanced segmentation, GDPR compliant.' },
      { id: '4', label: 'Customer lifetime value', question: 'Have you ever worked out what a typical customer is worth to the business over the whole time they stay with you?', scoringCriteria: '0: No concept of customer lifetime value. 1: Aware repeat customers exist, CLV not calculated. 2: CLV approximately understood, not used in decisions. 3: CLV calculated, occasionally referenced. 4: CLV understood and actively used. 5: CLV optimised, used in all relevant decisions, trend monitored.' },
      { id: '5', label: 'Customer experience and journey', question: 'Walk me through a typical customer experience from the moment they first hear about you to after they\'ve been served. Where does it work well and where does it feel rough?', scoringCriteria: '0: No awareness of customer journey, no feedback, no complaint process. 1: Journey broadly understood, significant friction. 2: Main steps known, some friction identified. 3: Journey mapped, key friction addressed, occasional feedback. 4: Journey actively managed, friction reduced, feedback regular. 5: Journey optimised end to end, friction continuously monitored.' },
      { id: '6', label: 'Net promoter and referral', question: 'Do you have a sense of how many of your customers would recommend you? Do you do anything to actively encourage referrals?', scoringCriteria: '0: No measurement of advocacy, no referral activity. 1: Knows some customers refer, no measurement. 2: Referrals acknowledged, no strategy. 3: Referral rate approximately known, some encouragement. 4: Referral strategy active, NPS or equivalent measured. 5: Referral programme systematic, NPS tracked, testimonials collected strategically.' },
    ]
  },
  {
    id: 9, label: 'Digital and technology infrastructure', shortLabel: 'Digital', description: 'Online presence, internal systems, and cyber security', weight: 1.0,
    subElements: [
      { id: '1', label: 'Website', question: 'Tell me about your website — does it do what you need it to do? When did you last update it?', scoringCriteria: '-1: No website where legally required to have one (rare). 0: No website. 1: Exists in name only, little useful content. 2: Basic website, poor mobile, outdated information. 3: Functional website, works on mobile, adequate content. 4: Good website, fast, mobile optimised, clear information, booking integration. 5: Excellent across all dimensions, integrated, actively maintained.' },
      { id: '2', label: 'Google Business Profile', question: 'Have you claimed your Google Business Profile? Do you know what your customers see when they search for you on Google?', scoringCriteria: '-1: N/A. 0: No profile of any kind. 1: Unclaimed profile only. 2: Claimed but significantly incomplete. 3: Claimed, mostly complete, not actively maintained. 4: Complete, hours current, owner responding to reviews, some posts. 5: Exemplary — complete, active posts, consistent review responses, booking link, updated photos.' },
      { id: '3', label: 'Reviews', question: 'How do you feel about your online reviews at the moment — are you aware of what\'s out there and how you\'re responding to it?', scoringCriteria: '0: No reviews anywhere. 1: Reviews exist, no awareness or responses. 2: Reviews exist, no responses, some negative unaddressed. 3: Reviews exist, responding to some, inconsistent. 4: Responding consistently, mostly positive, review strategy exists. 5: Active review strategy, consistent responses, high rating across multiple platforms.' },
      { id: '4', label: 'Social media', question: 'Tell me about your social media — which platforms do you use, how often do you post, and what\'s your sense of whether it\'s working?', scoringCriteria: '0: No social presence. 1: Present but dormant. 2: Active but unfocused, wrong audience. 3: Active, relevant content, moderate engagement. 4: Active, targeted, good engagement, growing. 5: Strategic, high engagement, converting to business outcomes.' },
      { id: '5', label: 'Online booking and transaction capability', question: 'Can customers book or buy from you online? What does that process look like from their side?', scoringCriteria: '0: No booking capability for appointment-based business. 1: Phone only. 2: Third party platform, not promoted. 3: Functional booking, some friction. 4: Integrated booking, low friction, confirmation and reminder automation. 5: Fully integrated, automated journey, waiting list, seamless.' },
      { id: '6', label: 'Internal technology and systems', question: 'What technology does the business run on day to day — devices, software, how things connect to each other?', scoringCriteria: '-1: N/A. 0: No systems of any kind. 1: Basic devices, no software, no integration. 2: Basic setup, some software, no integration. 3: Functional systems, partial integration. 4: Good systems, mostly integrated. 5: Comprehensive, integrated, backed up, current.' },
      { id: '7', label: 'Cyber security posture', question: 'What do you have in place to protect the business if someone tried to access your systems or data without permission?', scoringCriteria: '-1: Handling sensitive data without ICO registration where required, or known breach unreported. 0: No security measures, no awareness. 1: Aware but no action. 2: ICO registered, basic awareness, no formal measures. 3: ICO registered, basic measures, staff informally aware. 4: Cyber insurance, trained staff, systematic approach. 5: Comprehensive security posture, staff trained, breach plan tested.' },
    ]
  },
  {
    id: 10, label: 'Strategic clarity and leadership', shortLabel: 'Strategy', description: 'Vision, planning, decision quality, and owner engagement', weight: 1.0,
    subElements: [
      { id: '1', label: 'Vision and direction', question: 'If I asked you where you want this business to be in three years, what would you say?', scoringCriteria: '0: No vision beyond survival. 1: Vague aspiration, not articulated. 2: Broad direction understood by owner, not documented. 3: Vision defined, occasionally referenced. 4: Clear vision, documented, communicated to staff, used in decisions. 5: Compelling vision, embedded in culture, drives decisions at all levels.' },
      { id: '2', label: 'Strategy and planning', question: 'Do you have a business plan or a clear set of priorities for the next year or two? How do you decide what to focus on?', scoringCriteria: '0: No plan, no strategy, purely reactive. 1: Mental plan only, no horizon. 2: Basic plan, rarely reviewed, tactical. 3: Written plan, annual review, some strategic thinking. 4: Current strategy, regular review, 2-3 year horizon. 5: Comprehensive strategy, regular review cycle, long-term horizon, strategy drives all significant decisions.' },
      { id: '3', label: 'Decision-making quality', question: 'When you have a big decision to make, what does that process look like? Do you rely mainly on data, experience, or gut feeling?', scoringCriteria: '0: Completely instinct-driven, inconsistent, undocumented. 1: Experience-based, no data, no documentation. 2: Some data used, mostly instinct, occasional documentation. 3: Mix of data and experience, key decisions documented. 4: Predominantly data-driven, well documented, appropriate pace. 5: Systematic data-driven decisions, documented, reviewed, learning captured.' },
      { id: '4', label: 'Adaptability', question: 'Think of the last time something significant changed — in the market, in the business, or externally. How did the business respond to that?', scoringCriteria: '0: Active resistance to any change, stuck in damaging patterns. 1: Avoids change, only responds when forced. 2: Manages necessary change reluctantly. 3: Accepts change when evidence is clear, manages adequately. 4: Generally embraces change, adapts reasonably quickly. 5: Change-positive culture, adapts proactively, uses change as competitive advantage.' },
      { id: '5', label: 'Risk awareness and management', question: 'What do you see as the biggest risks to this business right now? Do you have anything in place to manage them?', scoringCriteria: '0: No risk awareness whatsoever. 1: Aware risks exist, cannot identify specifically. 2: Main risks known, limited mitigation. 3: Key risks identified, mitigation in place for most. 4: Risk register maintained, mitigation active, reviewed. 5: Comprehensive risk management, register current, mitigation tested, risk appetite defined.' },
      { id: '6', label: 'Owner motivation and energy', question: 'How are you feeling about the business at the moment — are you still excited by it, or does it feel more like a grind?', scoringCriteria: '0: Observable burnout or complete disengagement presenting existential risk. 1: Low energy, predominantly operational, no development. 2: Adequate energy, mostly operational, occasional development. 3: Good energy, some strategic time, some development. 4: High energy, deliberate balance of in and on, active development. 5: Highly engaged, clear strategic focus, continuous development, succession thinking active.' },
    ]
  },
  {
    id: 11, label: 'Legal, compliance, and insurance', shortLabel: 'Legal', description: 'Legal structure, contracts, IP, data, insurance, employment, statutory filing, and H&S', weight: 1.2,
    subElements: [
      {
        id: '1',
        label: 'Legal structure and governance',
        question: 'Is the legal structure appropriate for current activities and risk profile? Are articles of association, shareholder agreements, and director responsibilities in place and understood? When were governance documents last reviewed?',
        scoringCriteria: '-1: Operating under a legal structure creating active legal jeopardy — directors acting in breach of statutory duties under Companies Act 2006, operating in a regulated sector without the correct legal structure, or continuing to trade whilst knowingly insolvent without taking appropriate steps. 0: No understanding of own legal structure or governance obligations. 1: Structure understood at surface level, governance obligations unknown. 2: Structure clear, governance documents exist but not understood or reviewed. 3: Structure appropriate, governance documents in place, obligations broadly met. 4: Structure optimised for current activities and risk, governance proactively managed. 5: Optimal structure, all governance documents current, director responsibilities fully understood and fulfilled, proactively reviewed.',
      },
      {
        id: '2',
        label: 'Contracts and terms of business',
        question: 'Is there a written contract or terms of business for every client engagement? Are these consistently used? Has a solicitor reviewed them? Do consumer-facing contracts comply with the Consumer Rights Act 2015?',
        scoringCriteria: '-1: Taking on work without any written agreement for engagements carrying significant financial or liability risk. Or using contracts that actively breach statutory requirements — consumer contracts excluding rights the Consumer Rights Act gives customers, or contracts misrepresenting the engagement in a way constituting fraud. 0: No written contracts or terms, all verbal. 1: Some written terms exist, not consistently used, not reviewed. 2: Basic written terms, consistently used for major engagements, not recently reviewed by a solicitor. 3: Written terms for all client engagements, periodically reviewed, consumer compliance broadly met. 4: Comprehensive contracts, regularly reviewed, liability limits defined, solicitor input. 5: All contracts current, professionally drafted, Consumer Rights Act compliant, reviewed on schedule.',
      },
      {
        id: '3',
        label: 'Intellectual property protection',
        question: 'Has the business identified its IP — brand, methodology, products, content? Are trademarks registered where relevant? Are IP assignment clauses in contractor agreements? Is any third party IP being used without a licence?',
        scoringCriteria: '-1: Actively infringing a registered trademark or copyright owned by another party — trading under a name, using imagery, or reproducing content belonging to someone else — creating jeopardy of injunction, damages claim, or criminal prosecution. 0: No awareness of own IP assets or obligations to third party IP. 1: IP assets exist, not identified or protected, third party IP obligations unknown. 2: Main IP identified, limited protection, contractor agreements lack IP clauses. 3: Key IP identified, basic protection in place, main third party IP obligations understood. 4: IP actively managed, trademark registration considered or in place, contractor IP clauses standard. 5: Comprehensive IP strategy, all assets identified and protected, contractor agreements include IP assignment, third party IP audited and licensed.',
      },
      {
        id: '4',
        label: 'Insurance adequacy',
        question: 'Does the business hold PI, PL, cyber, and employer\'s liability insurance where relevant? Has scope of cover been reviewed against current activities? Are any activities excluded from current policies? Has the insurer been notified of all significant changes to the business\'s scope?',
        scoringCriteria: '-1: Operating without employer\'s liability insurance while employing staff — criminal offence under Employers\' Liability (Compulsory Insurance) Act 1969. Or operating in a regulated sector where minimum PI levels are legally mandated and not being met. Or knowingly misrepresenting activities to an insurer rendering the policy void. 0: No business insurance of any kind. 1: Minimal insurance, significant gaps, never reviewed, insurer not notified of changes. 2: Core insurance in place, some gaps, infrequently reviewed. 3: Most relevant insurance in place, reviewed periodically, insurer broadly kept informed. 4: Comprehensive cover appropriate to activities, regularly reviewed, insurer notified of all significant changes. 5: Optimal insurance portfolio, reviewed annually, cover levels tested against actual risk exposure, all activities and changes disclosed.',
      },
      {
        id: '5',
        label: 'Data protection and GDPR compliance',
        question: 'Is the business ICO registered? Is there a privacy policy accessible to those whose data is processed? Is there a documented lawful basis for every category of personal data processed? Are data retention and deletion practices defined? Is there a breach response plan? Have subject access requests been handled correctly?',
        scoringCriteria: '-1: Processing personal data without ICO registration where legally required. Or processing and sharing personal data with no lawful basis — selling data without consent, processing sensitive personal data without qualifying condition. Or a notifiable breach not reported to ICO within 72 hours without reasonable justification. 0: No data protection compliance of any kind. 1: Aware of GDPR obligations, no action taken. 2: ICO registered, privacy policy exists, data handling uncertain, no breach plan. 3: ICO registered, privacy policy current, lawful basis identified for main data categories, basic compliance. 4: Comprehensive compliance, breach plan exists, subject access request process defined, staff awareness. 5: Exemplary data protection, lawful basis documented for all data categories, retention and deletion defined, breach plan tested, staff trained, SARs handled correctly.',
      },
      {
        id: '6',
        label: 'Regulatory and sector compliance',
        question: 'What sector-specific licences, registrations, or authorisations does this business require? Are all current and in date? Are conditions attached to any licence being complied with? Are regulatory changes in this sector being monitored?',
        scoringCriteria: '-1: Operating in a regulated sector without required licence, registration, or authorisation — financial services without FCA authorisation, food business without local authority registration, care services without CQC registration, legal services without SRA authorisation. Or a mandatory licence has lapsed and the business continues to trade as though it remains valid. 0: Operating in a regulated sector with no awareness of licence or registration requirements. 1: Aware of regulatory obligations, compliance uncertain, monitoring absent. 2: Main licences and registrations identified, most current, monitoring reactive. 3: All licences and registrations identified and current, conditions broadly complied with, monitoring reactive. 4: Comprehensive compliance, all licences current, conditions actively complied with, regulatory changes monitored. 5: Exemplary compliance, all licences and registrations current, conditions fully met, regulatory changes proactively tracked and acted on.',
      },
      {
        id: '7',
        label: 'Employment law compliance',
        question: 'Does every person working in the business have a written contract from day one? Have right to work checks been done and documented for everyone? Is PAYE operated correctly? Is auto-enrolment in place for eligible workers? Has IR35 status been considered for any contractor relationships? Are statutory leave obligations — holiday pay, sick pay, maternity and paternity — being met correctly?',
        scoringCriteria: '-1: Employing people below National Minimum Wage — criminal offence. Or failing to operate PAYE when legally required. Or deliberately misclassifying employees as self-employed contractors to avoid employer obligations. Or failing to set up auto-enrolment pension provision when legally required. 0: Employing people with no contracts, no right to work checks, employment law obligations unknown. 1: Some contracts exist, right to work checks inconsistent, PAYE operated, other obligations vague. 2: Contracts for most staff, right to work checks done, PAYE correct, auto-enrolment uncertain, statutory leave obligations partially met. 3: All contracts in place, right to work checks documented, PAYE correct, auto-enrolment in place, statutory leave broadly correct. 4: Full compliance — contracts, right to work, PAYE, auto-enrolment, IR35 considered, statutory leave obligations met. 5: Exemplary employment law compliance, all obligations met, IR35 assessed, regularly reviewed, no outstanding matters. Note: Score N/A for genuine sole traders with no staff.',
      },
      {
        id: '8',
        label: 'Companies House and statutory filing',
        question: 'Is the confirmation statement current — filed within the last 12 months? Are accounts filed on time? Are there any outstanding penalties or enforcement actions? Are registered office, director details, and PSC register accurate and current? Have all significant changes been notified promptly?',
        scoringCriteria: '-1: Accounts or confirmation statement significantly overdue triggering or likely to trigger Companies House strike-off proceedings. Or a director knowingly filing false information at Companies House — criminal offence under Companies Act 2006. Or company already struck off and continuing to trade — invalidates contracts and exposes directors to personal liability. 0: No awareness of statutory filing obligations, likely overdue. 1: Aware of filing obligations, some overdue, registered details possibly incorrect. 2: Filing broadly current, occasional lateness, registered details approximately correct. 3: Filings current, confirmation statement done, registered details correct, changes notified. 4: All filings current and on time, registered details accurate, changes promptly notified, no penalties. 5: Exemplary statutory compliance, all filings ahead of deadline, PSC register accurate, director details current, proactively managed.',
      },
      {
        id: '9',
        label: 'Health and safety',
        question: 'Has a suitable risk assessment been carried out for the workplace and activities? Does the business have five or more employees without a written H&S policy? Are there any outstanding HSE enforcement notices? Are mandatory safety certifications — gas safety, electrical, LOLER, COSHH — current? Are RIDDOR-reportable incidents being reported? Does the business have a substance misuse policy where relevant?',
        scoringCriteria: '-1: Operating in active breach of health and safety law creating real and present risk of serious injury or death — machinery without guards, substances without COSHH assessments, food business with conditions creating risk of serious food-borne illness, continuing to operate after receiving HSE prohibition notice. Or a RIDDOR-reportable incident not reported within required timeframe. Or knowingly allowing an intoxicated person to operate machinery or undertake any activity where impairment creates risk of serious injury or death. Or knowingly allowing a person with substance dependency to continue in a role where their continued use creates legal jeopardy, risk to themselves or others, or threatens relationships with partner organisations or regulated bodies. 0: No health and safety awareness, no risk assessment, no policy where legally required. 1: Aware of H&S obligations, risk assessments not conducted, no policy. 2: Basic risk assessments done, H&S policy exists where required, mandatory certifications uncertain. 3: Risk assessments conducted, H&S policy current, mandatory certifications broadly in place, RIDDOR awareness. 4: Comprehensive risk assessment, H&S policy current, all mandatory certifications current, RIDDOR reportable incidents reported. 5: Exemplary health and safety management, risk assessments current and reviewed, all certifications current, RIDDOR fully compliant, substance misuse policy in place where relevant, safety culture embedded.',
      },
    ]
  }
];

// ── Boot ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
