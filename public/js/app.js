// ==================== CONSTANTS ====================
var APP_KEY = 'eba-incidencias-v2';
var SYNC_KEY = 'eba-sync-config';
var MAX_FILE_MB = 4;
var MAX_IMG_DIM = 1600;
var IMG_QUALITY = 0.82;
var FASES = {
  diseno: 'Diseno', prototipo: 'Prototipo', proveedores: 'Proveedores / compras',
  materiales: 'Recepcion materiales', fabricacion: 'Fabricacion', acabados: 'Acabados',
  calidad: 'Control calidad', embalaje: 'Embalaje', logistica: 'Logistica / envio',
  instalacion: 'Instalacion / montaje', postventa: 'Postventa'
};
var VALID_TIPOS = ['incidencia', 'observacion', 'mejora'];
var VALID_SEVS = ['baja', 'media', 'alta'];
var VALID_ESTADOS = ['abierta', 'progreso', 'resuelta'];
var ALLOWED_EXTENSIONS = ['.png','.jpg','.jpeg','.gif','.webp','.pdf','.doc','.docx','.xls','.xlsx','.txt','.csv','.dwg','.zip'];

// ==================== STATE ====================
var state = { processes: [], entries: [] };
var currentProc = null;
var pendingAttachments = [];
var editingEntryId = null;
var currentSort = 'fecha';
var syncConfig = null;
var userRole = 'admin'; // 'admin' or 'basico'

function isAdmin() { return userRole === 'admin'; }

// ==================== HELPERS ====================
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function sanitize(str, maxLen) {
  if (!str) return '';
  var s = String(str).trim();
  return maxLen ? s.substring(0, maxLen) : s;
}
function showToast(msg) {
  var t = document.getElementById('app-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(t._timer);
  t._timer = setTimeout(function() { t.classList.remove('visible'); }, 2500);
}
function today() { return new Date().toISOString().slice(0, 10); }

// ==================== SYNC PROVIDER (abstraction layer) ====================
// Providers: 'github' (Gist), 'server' (custom REST). Easy to swap.
var SyncProvider = {
  github: {
    push: function(data, config) {
      var body = { files: { 'eba-data.json': { content: JSON.stringify(data) } } };
      var url = config.gistId
        ? 'https://api.github.com/gists/' + config.gistId
        : 'https://api.github.com/gists';
      var method = config.gistId ? 'PATCH' : 'POST';
      if (!config.gistId) body.description = 'EBA Gestor Incidencias - datos';
      if (!config.gistId) body.public = false;
      return fetch(url, {
        method: method,
        headers: { 'Authorization': 'Bearer ' + config.token, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
        body: JSON.stringify(body)
      }).then(function(r) {
        if (!r.ok) throw new Error('GitHub ' + r.status);
        return r.json();
      }).then(function(gist) {
        return { gistId: gist.id };
      });
    },
    pull: function(config) {
      if (!config.gistId) return Promise.reject(new Error('No gist ID'));
      return fetch('https://api.github.com/gists/' + config.gistId, {
        headers: { 'Authorization': 'Bearer ' + config.token, 'Accept': 'application/vnd.github+json' }
      }).then(function(r) {
        if (!r.ok) throw new Error('GitHub ' + r.status);
        return r.json();
      }).then(function(gist) {
        var file = gist.files['eba-data.json'];
        if (!file) throw new Error('Archivo no encontrado en el gist');
        return JSON.parse(file.content);
      });
    }
  },
  server: {
    push: function(data, config) {
      return fetch(config.serverUrl + '/data', {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + config.serverToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).then(function(r) {
        if (!r.ok) throw new Error('Server ' + r.status);
        return r.json();
      });
    },
    pull: function(config) {
      return fetch(config.serverUrl + '/data', {
        headers: { 'Authorization': 'Bearer ' + config.serverToken, 'Accept': 'application/json' }
      }).then(function(r) {
        if (!r.ok) throw new Error('Server ' + r.status);
        return r.json();
      });
    }
  }
};

function getSyncProvider() {
  if (!syncConfig || !syncConfig.backend) return null;
  return SyncProvider[syncConfig.backend] || null;
}

// --- Auto-sync engine ---
var _syncPushTimer = null;
var _syncInterval = null;
var _syncBusy = false;
var _lastPushHash = '';
var _lastPullTime = 0;
var SYNC_DEBOUNCE_MS = 1500;   // Wait 1.5s after last save before pushing
var SYNC_POLL_MS = 30000;      // Poll remote every 30s when tab is visible
var SYNC_PULL_COOLDOWN = 5000; // Min 5s between pulls (prevents spam on tab switch)

function setSyncStatus(cls, text) {
  var el = document.getElementById('sync-indicator');
  if (!el) return;
  el.className = 'header-btn' + (cls ? ' sync-' + cls : '');
  el.title = text || 'Sincronizacion automatica';
  el.style.display = syncConfig && syncConfig.backend ? '' : 'none';
  var st = document.getElementById('sync-status');
  if (st) st.textContent = text || '';
}

function _stateHash() {
  return String(state.processes.length) + ':' + String(state.entries.length) + ':' +
    (state.entries.length ? state.entries[state.entries.length - 1].id : 0) + ':' +
    (state.entries.length ? state.entries.reduce(function(s, e) { return s + e.estado; }, '') : '');
}

function syncPush() {
  var provider = getSyncProvider();
  if (!provider || _syncBusy) return Promise.resolve();
  // Skip push if nothing changed since last push
  var hash = _stateHash();
  if (hash === _lastPushHash) { setSyncStatus('ok', 'Sincronizado'); return Promise.resolve(); }
  _syncBusy = true;
  setSyncStatus('syncing', 'Subiendo...');
  return provider.push(state, syncConfig).then(function(result) {
    _lastPushHash = hash;
    if (result && result.gistId && !syncConfig.gistId) {
      syncConfig.gistId = result.gistId;
      localStorage.setItem(SYNC_KEY, JSON.stringify(syncConfig));
      updateSyncWizardUI();
    }
    setSyncStatus('ok', 'Sincronizado');
  }).catch(function(err) {
    setSyncStatus('error', 'Error: ' + err.message);
    console.error('Sync push error:', err);
  }).then(function() { _syncBusy = false; });
}

// --- Merge engine: combines local + remote by ID, no data loss ---
function mergeState(local, remote) {
  var merged = { processes: [], entries: [] };
  // Merge processes by ID: keep all unique, prefer most recent fields
  var procMap = {};
  (local.processes || []).forEach(function(p) { procMap[p.id] = Object.assign({}, p); });
  (remote.processes || []).forEach(function(p) {
    if (!procMap[p.id]) { procMap[p.id] = Object.assign({}, p); }
    // If both have it, keep local (admin edits locally)
  });
  merged.processes = Object.keys(procMap).map(function(k) { return procMap[k]; });
  merged.processes.sort(function(a, b) { return a.id - b.id; });
  // Merge entries by ID: union of all entries, newest version wins per ID
  var entryMap = {};
  (remote.entries || []).forEach(function(e) { entryMap[e.id] = Object.assign({}, e); });
  (local.entries || []).forEach(function(e) {
    var existing = entryMap[e.id];
    if (!existing) { entryMap[e.id] = Object.assign({}, e); return; }
    // Both have this entry: merge comments (union), keep latest other fields
    var localComments = e.comments || [];
    var remoteComments = existing.comments || [];
    var commentSet = {};
    remoteComments.forEach(function(c) { commentSet[c.date + '|' + c.text] = c; });
    localComments.forEach(function(c) { commentSet[c.date + '|' + c.text] = c; });
    var mergedComments = Object.keys(commentSet).map(function(k) { return commentSet[k]; });
    mergedComments.sort(function(a, b) { return a.date.localeCompare(b.date); });
    // Local wins for field changes (user just edited locally)
    entryMap[e.id] = Object.assign({}, e);
    entryMap[e.id].comments = mergedComments;
  });
  merged.entries = Object.keys(entryMap).map(function(k) { return entryMap[k]; });
  merged.entries.sort(function(a, b) { return a.id - b.id; });
  return merged;
}

function syncPull() {
  var provider = getSyncProvider();
  if (!provider || _syncBusy) return Promise.resolve();
  // Cooldown: skip if pulled recently
  var now = Date.now();
  if (now - _lastPullTime < SYNC_PULL_COOLDOWN) return Promise.resolve();
  _lastPullTime = now;
  _syncBusy = true;
  setSyncStatus('syncing', 'Descargando...');
  return provider.pull(syncConfig).then(function(data) {
    if (data && data.processes && data.entries) {
      var merged = mergeState(state, data);
      var localStr = JSON.stringify(state);
      var mergedStr = JSON.stringify(merged);
      if (localStr !== mergedStr) {
        state = merged;
        localStorage.setItem(APP_KEY, JSON.stringify(state));
        _lastPushHash = _stateHash();
        renderAll();
        setSyncStatus('ok', 'Datos actualizados');
        // Push merged result so all devices converge
        schedulePush();
      } else {
        setSyncStatus('ok', 'Sincronizado');
      }
    }
  }).catch(function(err) {
    setSyncStatus('error', 'Error: ' + err.message);
    console.error('Sync pull error:', err);
  }).then(function() { _syncBusy = false; });
}

// Debounced push: waits SYNC_DEBOUNCE_MS after last call
function schedulePush() {
  if (!getSyncProvider()) return;
  clearTimeout(_syncPushTimer);
  _syncPushTimer = setTimeout(syncPush, SYNC_DEBOUNCE_MS);
}

// Start/stop periodic background pull (only when tab visible)
function startAutoSync() {
  stopAutoSync();
  if (!getSyncProvider()) return;
  _syncInterval = setInterval(function() {
    if (!document.hidden) syncPull();
  }, SYNC_POLL_MS);
}
function stopAutoSync() { clearInterval(_syncInterval); _syncInterval = null; }

// Sync when user returns to the app/tab
document.addEventListener('visibilitychange', function() {
  if (!document.hidden && getSyncProvider()) syncPull();
});
// Sync when window regains focus (covers alt-tab, etc.)
window.addEventListener('focus', function() {
  if (getSyncProvider()) syncPull();
});

function manualSync() { syncPull(); }

function toggleSyncConfig() {
  var sel = document.getElementById('sync-backend').value;
  document.getElementById('sync-github-config').style.display = sel === 'github' ? 'block' : 'none';
  document.getElementById('sync-server-config').style.display = sel === 'server' ? 'block' : 'none';
}

function saveSyncConfig() {
  var backend = document.getElementById('sync-backend').value;
  if (!backend) {
    syncConfig = null; localStorage.removeItem(SYNC_KEY);
    stopAutoSync(); setSyncStatus('', '');
    showToast('Sincronizacion desactivada'); return;
  }
  syncConfig = { backend: backend };
  if (backend === 'github') {
    var token = document.getElementById('sync-token').value.trim();
    if (!token) { alert('Introduce el token de GitHub'); return; }
    syncConfig.token = token;
    var gi = document.getElementById('sync-gist-id');
    syncConfig.gistId = (gi && gi.value.trim()) || null;
  } else if (backend === 'server') {
    var url = document.getElementById('sync-server-url').value.trim();
    if (!url) { alert('Introduce la URL del servidor'); return; }
    syncConfig.serverUrl = url;
    syncConfig.serverToken = document.getElementById('sync-server-token').value.trim();
  }
  localStorage.setItem(SYNC_KEY, JSON.stringify(syncConfig));
  showToast('Sincronizacion activada');
  syncPush().then(function() {
    startAutoSync();
    updateSyncWizardUI();
    updateSyncBanner();
  });
}

function disconnectSync() {
  if (!confirm('Desconectar sincronizacion?')) return;
  syncConfig = null;
  localStorage.removeItem(SYNC_KEY);
  stopAutoSync();
  setSyncStatus('', '');
  document.getElementById('sync-backend').value = '';
  toggleSyncConfig();
  updateSyncWizardUI();
  updateSyncBanner();
  showToast('Sincronizacion desconectada');
}

function updateSyncWizardUI() {
  var step1 = document.getElementById('sync-wizard-step1');
  var done = document.getElementById('sync-wizard-done');
  if (!step1 || !done) return;
  var connected = syncConfig && syncConfig.backend === 'github' && syncConfig.token;
  step1.style.display = connected ? 'none' : 'block';
  done.style.display = connected ? 'block' : 'none';
  if (connected) {
    var gi = document.getElementById('sync-gist-id');
    if (gi) gi.value = syncConfig.gistId || 'Creando...';
    generateShareURL();
  }
}

function generateShareURL() {
  if (!syncConfig || !syncConfig.token) return;
  var base = location.href.split('?')[0].split('#')[0];
  // Admin link
  var cfgAdmin = { b: syncConfig.backend, t: syncConfig.token, g: syncConfig.gistId || '', r: 'admin' };
  var elAdmin = document.getElementById('sync-share-url-admin');
  if (elAdmin) elAdmin.value = base + '?sync=' + btoa(unescape(encodeURIComponent(JSON.stringify(cfgAdmin))));
  // Basic link
  var cfgBasic = { b: syncConfig.backend, t: syncConfig.token, g: syncConfig.gistId || '', r: 'basico' };
  var elBasic = document.getElementById('sync-share-url-basico');
  if (elBasic) elBasic.value = base + '?sync=' + btoa(unescape(encodeURIComponent(JSON.stringify(cfgBasic))));
}

function copyShareLink(role) {
  var el = document.getElementById('sync-share-url-' + role);
  if (!el || !el.value) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(el.value).then(function() { showToast('Enlace ' + role + ' copiado'); });
  } else {
    el.select(); document.execCommand('copy'); showToast('Enlace ' + role + ' copiado');
  }
}

function applyConfigFromURL() {
  var params = new URLSearchParams(location.search);
  var syncParam = params.get('sync');
  if (!syncParam) return false;
  try {
    var cfg = JSON.parse(decodeURIComponent(escape(atob(syncParam))));
    if (!cfg.b || !cfg.t) return false;
    syncConfig = { backend: cfg.b, token: cfg.t, gistId: cfg.g || null };
    userRole = (cfg.r === 'admin') ? 'admin' : 'basico';
    if (cfg.b === 'server') { syncConfig.serverUrl = cfg.u || ''; syncConfig.serverToken = cfg.t; }
    localStorage.setItem(SYNC_KEY, JSON.stringify(syncConfig));
    // Clean URL without reloading
    history.replaceState(null, '', location.pathname);
    return true;
  } catch (e) { console.error('Invalid sync URL param:', e); return false; }
}

function updateSyncBanner() {
  var banner = document.getElementById('sync-auto-banner');
  var admin = document.getElementById('sync-admin-section');
  if (!banner || !admin) return;
  var fromURL = syncConfig && syncConfig._fromURL;
  // Always show admin section so admin can manage; show banner when connected
  banner.style.display = (syncConfig && syncConfig.backend) ? 'block' : 'none';
}

function loadSyncConfig() {
  // First check URL params (shared link)
  var fromURL = applyConfigFromURL();
  if (!fromURL) {
    try {
      var raw = localStorage.getItem(SYNC_KEY);
      if (raw) syncConfig = JSON.parse(raw);
    } catch (e) { syncConfig = null; }
  }
  if (syncConfig) {
    var sel = document.getElementById('sync-backend');
    if (sel) sel.value = syncConfig.backend || '';
    toggleSyncConfig();
    if (syncConfig.backend === 'github') {
      var tk = document.getElementById('sync-token');
      if (tk) tk.value = syncConfig.token || '';
      updateSyncWizardUI();
    } else if (syncConfig.backend === 'server') {
      var su = document.getElementById('sync-server-url');
      var st2 = document.getElementById('sync-server-token');
      if (su) su.value = syncConfig.serverUrl || '';
      if (st2) st2.value = syncConfig.serverToken || '';
    }
    setSyncStatus('ok', 'Auto-sync activo');
    updateSyncBanner();
  }
}

// ==================== STORAGE ====================
function load() {
  try {
    var raw = localStorage.getItem(APP_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) {}
  if (!state.processes) state.processes = [];
  if (!state.entries) state.entries = [];
  document.getElementById('f-fecha').value = today();
  loadSyncConfig();
  renderAll();
  // Auto-pull on load + start periodic sync
  if (getSyncProvider()) {
    syncPull();
    startAutoSync();
  }
}

function save() {
  try { localStorage.setItem(APP_KEY, JSON.stringify(state)); }
  catch (e) { alert('Error guardando: ' + e.message); }
  schedulePush(); // debounced auto-push
}

function renderAll() {
  renderProcList();
  renderDashboard();
  populateProjectFilters();
  updateTabBadges();
  updateFab();
  applyRoleUI();
}

function applyRoleUI() {
  var admin = isAdmin();
  // Hide/show admin-only elements in static HTML
  document.querySelectorAll('.admin-only').forEach(function(el) {
    el.style.display = admin ? '' : 'none';
  });
  // Show role badge in header
  var badge = document.getElementById('role-badge');
  if (badge) {
    badge.textContent = admin ? 'Admin' : 'Basico';
    badge.className = 'role-badge ' + (admin ? 'role-admin' : 'role-basico');
  }
}
// ==================== DARK THEME ====================
function toggleTheme() {
  var d = document.documentElement;
  var current = d.getAttribute('data-theme');
  var next = current === 'dark' ? '' : 'dark';
  if (next) d.setAttribute('data-theme', 'dark');
  else d.removeAttribute('data-theme');
  localStorage.setItem('eba-theme', next);
}
(function() {
  var t = localStorage.getItem('eba-theme');
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
})();

// ==================== PROJECT SELECTION ====================
function selectProcess(id) {
  currentProc = id;
  var bar = document.getElementById('current-proc-bar');
  var regTab = document.querySelector('.tab[data-tab="registro"]');
  if (id) {
    var p = state.processes.find(function(x) { return x.id === id; });
    if (!p) { selectProcess(null); return; }
    document.getElementById('current-proc-name').textContent = (p.code ? p.code + ' \u2014 ' : '') + p.name;
    bar.style.display = 'flex';
    regTab.disabled = false;
    var fp = document.getElementById('filt-proc');
    var rp = document.getElementById('rep-proc');
    if (fp) fp.value = String(id);
    if (rp) rp.value = String(id);
    switchTab('listado');
  } else {
    bar.style.display = 'none';
    regTab.disabled = true;
    switchTab('procesos');
  }
  renderProcList();
  updateFab();
}

function populateProjectFilters() {
  var opts = '<option value="">Todos los proyectos</option>';
  state.processes.forEach(function(p) {
    var label = (p.code ? p.code + ' - ' : '') + p.name;
    opts += '<option value="' + p.id + '">' + esc(label) + '</option>';
  });
  var fp = document.getElementById('filt-proc');
  var rp = document.getElementById('rep-proc');
  var fpVal = fp ? fp.value : '';
  var rpVal = rp ? rp.value : '';
  if (fp) { fp.innerHTML = opts; fp.value = fpVal; }
  if (rp) { rp.innerHTML = opts; rp.value = rpVal; }
}

// ==================== DASHBOARD ====================
function renderDashboard() {
  var el = document.getElementById('dashboard');
  if (!el) return;
  var total = state.entries.length;
  var open = state.entries.filter(function(e) { return e.estado === 'abierta'; }).length;
  var prog = state.entries.filter(function(e) { return e.estado === 'progreso'; }).length;
  var solved = state.entries.filter(function(e) { return e.estado === 'resuelta'; }).length;
  var critical = state.entries.filter(function(e) { return e.sev === 'alta' && e.estado !== 'resuelta'; }).length;
  var projects = state.processes.length;
  if (!total && !projects) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="dashboard-title"><svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>Panel de estado</div>' +
    '<div class="dash-row">' +
      '<div class="dash-stat info"><div class="dash-stat-value">' + projects + '</div><div class="dash-stat-label">Proyectos</div></div>' +
      '<div class="dash-stat"><div class="dash-stat-value">' + total + '</div><div class="dash-stat-label">Total entradas</div></div>' +
      '<div class="dash-stat warning"><div class="dash-stat-value">' + open + '</div><div class="dash-stat-label">Abiertas</div></div>' +
      '<div class="dash-stat info"><div class="dash-stat-value">' + prog + '</div><div class="dash-stat-label">En progreso</div></div>' +
      '<div class="dash-stat success"><div class="dash-stat-value">' + solved + '</div><div class="dash-stat-label">Resueltas</div></div>' +
      '<div class="dash-stat critical"><div class="dash-stat-value">' + critical + '</div><div class="dash-stat-label">Criticas</div></div>' +
    '</div>';
}

// ==================== PROJECT CRUD ====================
function renderProcList() {
  var el = document.getElementById('proc-list-container');
  if (!state.processes.length) {
    el.innerHTML = '<div class="empty">No hay proyectos. Crea uno arriba para empezar.</div>';
    return;
  }
  el.innerHTML = '<div class="proc-list">' + state.processes.map(function(p) {
    var entries = state.entries.filter(function(e) { return e.procId === p.id; });
    var abiertas = entries.filter(function(e) { return e.estado !== 'resuelta'; }).length;
    var resueltas = entries.filter(function(e) { return e.estado === 'resuelta'; }).length;
    var altas = entries.filter(function(e) { return e.sev === 'alta' && e.estado !== 'resuelta'; }).length;
    var pct = entries.length ? Math.round(resueltas / entries.length * 100) : 0;
    var active = p.id === currentProc ? ' active' : '';
    return '<div class="proc-card' + active + '" onclick="selectProcess(' + p.id + ')">' +
      (p.code ? '<div class="proc-code">' + esc(p.code) + '</div>' : '') +
      '<div class="proc-name">' + esc(p.name) + '</div>' +
      (p.client ? '<div class="proc-meta">Cliente: ' + esc(p.client) + '</div>' : '') +
      (p.desc ? '<div class="proc-meta">' + esc(p.desc) + '</div>' : '') +
      '<div class="proc-meta" style="margin-top:6px;">' + entries.length + ' entradas &middot; ' + abiertas + ' sin resolver' + (altas ? ' &middot; <span style="color:var(--eba-dark);font-weight:600;">' + altas + ' critica(s)</span>' : '') + '</div>' +
      '<div class="proc-progress"><div class="proc-progress-bar" style="width:' + pct + '%"></div></div>' +
      '<div class="proc-meta">' + pct + '% resueltas</div>' +
      (isAdmin() ? '<div class="actions">' +
        '<button onclick="event.stopPropagation();editProcess(' + p.id + ')" style="width:auto;flex:0 0 auto;font-size:12px;padding:4px 10px;">Editar</button>' +
        '<button class="danger" onclick="event.stopPropagation();deleteProcess(' + p.id + ')" style="width:auto;flex:0 0 auto;font-size:12px;padding:4px 10px;">Eliminar</button>' +
      '</div>' : '') + '</div>';
  }).join('') + '</div>';
}

function addProcess() {
  var name = sanitize(document.getElementById('new-proc-name').value, 200);
  if (!name) { alert('Introduce un nombre para el proyecto'); return; }
  state.processes.push({
    id: Date.now(), code: sanitize(document.getElementById('new-proc-code').value, 50),
    name: name, client: sanitize(document.getElementById('new-proc-client').value, 200),
    desc: sanitize(document.getElementById('new-proc-desc').value, 500), created: new Date().toISOString()
  });
  ['new-proc-code','new-proc-name','new-proc-client','new-proc-desc'].forEach(function(id) { document.getElementById(id).value = ''; });
  save(); renderAll(); showToast('Proyecto creado');
}

function editProcess(id) {
  if (!isAdmin()) { showToast('Solo administradores pueden editar proyectos'); return; }
  var p = state.processes.find(function(x) { return x.id === id; });
  if (!p) return;
  var name = prompt('Nombre del proyecto:', p.name);
  if (!name || !name.trim()) return;
  p.name = sanitize(name, 200);
  var code = prompt('Codigo / referencia:', p.code || '');
  if (code !== null) p.code = sanitize(code, 50);
  var client = prompt('Cliente:', p.client || '');
  if (client !== null) p.client = sanitize(client, 200);
  var desc = prompt('Descripcion:', p.desc || '');
  if (desc !== null) p.desc = sanitize(desc, 500);
  save(); renderAll();
  if (currentProc === id) document.getElementById('current-proc-name').textContent = (p.code ? p.code + ' \u2014 ' : '') + p.name;
  showToast('Proyecto actualizado');
}

function deleteProcess(id) {
  if (!isAdmin()) { showToast('Solo administradores pueden eliminar proyectos'); return; }
  var p = state.processes.find(function(x) { return x.id === id; });
  if (!p) return;
  var count = state.entries.filter(function(e) { return e.procId === id; }).length;
  if (!confirm('Eliminar "' + p.name + '"?\nSe borraran tambien sus ' + count + ' entrada(s).')) return;
  state.processes = state.processes.filter(function(x) { return x.id !== id; });
  state.entries = state.entries.filter(function(e) { return e.procId !== id; });
  if (currentProc === id) selectProcess(null);
  save(); renderAll(); showToast('Proyecto eliminado');
}
// ==================== FILE HANDLING ====================
function handleFileSelection(ev) {
  Array.from(ev.target.files).forEach(function(file) { processFile(file); });
  ev.target.value = '';
}
function processFile(file) {
  var ext = file.name.lastIndexOf('.') !== -1 ? file.name.substring(file.name.lastIndexOf('.')).toLowerCase() : '';
  if (ALLOWED_EXTENSIONS.indexOf(ext) === -1) { alert('Tipo no permitido: ' + ext); return; }
  if (file.type && file.type.startsWith('image/')) {
    compressImage(file).then(function(p) { pendingAttachments.push(p); renderPendingAttachments(); }).catch(function(e) { alert('Error imagen: ' + e.message); });
  } else {
    if (file.size > MAX_FILE_MB * 1024 * 1024) { alert('"' + file.name + '" supera ' + MAX_FILE_MB + 'MB.'); return; }
    fileToBase64(file).then(function(d) { pendingAttachments.push({ name: file.name, type: file.type, size: file.size, data: d }); renderPendingAttachments(); }).catch(function(e) { alert('Error: ' + e.message); });
  }
}
function compressImage(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var img = new Image();
      img.onload = function() {
        var w = img.width, h = img.height;
        if (w > MAX_IMG_DIM || h > MAX_IMG_DIM) { if (w > h) { h = Math.round(h * MAX_IMG_DIM / w); w = MAX_IMG_DIM; } else { w = Math.round(w * MAX_IMG_DIM / h); h = MAX_IMG_DIM; } }
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        var data = c.toDataURL('image/jpeg', IMG_QUALITY);
        resolve({ name: file.name.replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg', size: Math.round(data.length * 0.75), data: data });
      };
      img.onerror = function() { reject(new Error('No se pudo leer la imagen')); };
      img.src = e.target.result;
    };
    reader.onerror = function() { reject(new Error('No se pudo leer el archivo')); };
    reader.readAsDataURL(file);
  });
}
function fileToBase64(file) {
  return new Promise(function(res, rej) { var r = new FileReader(); r.onload = function() { res(r.result); }; r.onerror = rej; r.readAsDataURL(file); });
}
function renderPendingAttachments() {
  var el = document.getElementById('f-attachments');
  if (!pendingAttachments.length) { el.innerHTML = ''; return; }
  el.innerHTML = pendingAttachments.map(function(a, i) { return renderAttachment(a, i, true); }).join('');
}
function renderAttachment(a, idx, removable) {
  var isImg = a.type && a.type.startsWith('image/');
  var rm = removable ? '<button class="att-remove" onclick="event.stopPropagation();removePending(' + idx + ')">x</button>' : '';
  if (isImg) return '<div class="att"><img src="' + a.data + '" onclick="openLightbox(this.src)" alt="' + esc(a.name) + '">' + rm + '</div>';
  var icon = a.type === 'application/pdf' ? '\uD83D\uDCC4' : '\uD83D\uDCCE';
  var short = a.name.length > 20 ? a.name.slice(0, 18) + '\u2026' : a.name;
  return '<div class="att"><div class="att-file" data-data="' + a.data + '" data-name="' + esc(a.name) + '" onclick="downloadAtt(this)"><div class="att-file-icon">' + icon + '</div>' + esc(short) + '</div>' + rm + '</div>';
}
function removePending(i) { pendingAttachments.splice(i, 1); renderPendingAttachments(); }
function downloadAtt(el) { var a = document.createElement('a'); a.href = el.dataset.data; a.download = el.dataset.name; a.click(); }
function openLightbox(src) { document.getElementById('lightbox-img').src = src; document.getElementById('lightbox').classList.add('active'); }
function closeLightbox() { document.getElementById('lightbox').classList.remove('active'); }

// ==================== ENTRY CRUD ====================
function addEntry() {
  if (!currentProc) { alert('Selecciona un proyecto primero'); return; }
  var desc = sanitize(document.getElementById('f-desc').value, 5000);
  if (!desc) { alert('La descripcion es obligatoria'); return; }
  var fase = document.getElementById('f-fase').value;
  var tipo = document.getElementById('f-tipo').value;
  var sev = document.getElementById('f-sev').value;
  var estado = document.getElementById('f-estado').value;
  if (!FASES[fase]) { alert('Fase no valida'); return; }
  if (VALID_TIPOS.indexOf(tipo) === -1) tipo = 'incidencia';
  if (VALID_SEVS.indexOf(sev) === -1) sev = 'media';
  if (VALID_ESTADOS.indexOf(estado) === -1) estado = 'abierta';
  state.entries.push({
    id: Date.now(), procId: currentProc,
    fecha: document.getElementById('f-fecha').value || today(),
    fase: fase, tipo: tipo, sev: sev, estado: estado,
    resp: sanitize(document.getElementById('f-resp').value, 100),
    prov: sanitize(document.getElementById('f-prov').value, 200),
    ref: sanitize(document.getElementById('f-ref').value, 100),
    desc: desc, accion: sanitize(document.getElementById('f-accion').value, 5000),
    attachments: pendingAttachments.slice(), comments: []
  });
  save(); clearForm(); showToast('Entrada guardada');
  renderAll(); switchTab('listado');
}

function clearForm() {
  ['f-desc','f-resp','f-prov','f-ref','f-accion'].forEach(function(id) { document.getElementById(id).value = ''; });
  document.getElementById('f-fecha').value = today();
  document.getElementById('f-sev').value = 'media';
  document.getElementById('f-estado').value = 'abierta';
  pendingAttachments = []; renderPendingAttachments();
}

function getFilteredEntries(procFilterId) {
  if (procFilterId) { var pid = Number(procFilterId); return state.entries.filter(function(e) { return e.procId === pid; }); }
  return state.entries.slice();
}

// ==================== SORTING ====================
function setSort(field) {
  currentSort = field;
  document.querySelectorAll('.sort-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.sort === field); });
  refreshEntriesList();
}

function sortEntries(list) {
  var sevOrder = { alta: 0, media: 1, baja: 2 };
  var estOrder = { abierta: 0, progreso: 1, resuelta: 2 };
  if (currentSort === 'sev') return list.sort(function(a, b) { return (sevOrder[a.sev] || 1) - (sevOrder[b.sev] || 1) || b.id - a.id; });
  if (currentSort === 'estado') return list.sort(function(a, b) { return (estOrder[a.estado] || 0) - (estOrder[b.estado] || 0) || b.id - a.id; });
  return list.sort(function(a, b) { return b.fecha.localeCompare(a.fecha) || b.id - a.id; });
}

// ==================== ENTRY LIST ====================
function refreshEntriesList() {
  var el = document.getElementById('entries-list');
  var fpVal = document.getElementById('filt-proc').value;
  var ff = document.getElementById('filt-fase').value;
  var fi = document.getElementById('filt-tipo').value;
  var fe = document.getElementById('filt-estado').value;
  var fs = document.getElementById('filt-sev').value;
  var ft = document.getElementById('filt-text').value.toLowerCase();
  var allForProc = getFilteredEntries(fpVal);
  var list = allForProc.slice();
  if (ff) list = list.filter(function(e) { return e.fase === ff; });
  if (fi) list = list.filter(function(e) { return e.tipo === fi; });
  if (fe) list = list.filter(function(e) { return e.estado === fe; });
  if (fs) list = list.filter(function(e) { return e.sev === fs; });
  if (ft) list = list.filter(function(e) { return (e.desc + ' ' + (e.resp||'') + ' ' + (e.prov||'') + ' ' + (e.ref||'') + ' ' + (e.accion||'')).toLowerCase().indexOf(ft) !== -1; });
  list = sortEntries(list);
  var total = allForProc.length;
  var shown = list.length;
  var showProj = !fpVal;
  var header = '<div style="font-size:12px;color:var(--hint);margin-bottom:8px;">' + shown + ' de ' + total + ' entradas</div>';
  if (!list.length) { el.innerHTML = header + '<div class="empty">Sin entradas con estos filtros</div>'; return; }
  el.innerHTML = header + list.map(function(e) { return renderEntry(e, true, showProj); }).join('');
  updateFilterCount();
}

// ==================== RENDER ENTRY (compact card for list) ====================
function renderEntry(e, withActions, showProject) {
  var tipoB = e.tipo === 'incidencia' ? 'b-inc' : (e.tipo === 'mejora' ? 'b-mej' : 'b-obs');
  var sevB = 'b-' + (e.sev === 'alta' ? 'high' : e.sev === 'media' ? 'med' : 'low');
  var estB = 'b-' + (e.estado === 'abierta' ? 'open' : e.estado === 'progreso' ? 'prog' : 'done');
  var estL = e.estado === 'progreso' ? 'en progreso' : e.estado;
  var faseLabel = FASES[e.fase] || e.fase || '';
  var projectLabel = '';
  if (showProject) {
    var proj = state.processes.find(function(p) { return p.id === e.procId; });
    if (proj) projectLabel = esc(proj.code || proj.name);
  }
  var comments = e.comments || [];
  var atts = e.attachments || [];
  var metaParts = [];
  if (projectLabel) metaParts.push(projectLabel);
  if (e.resp) metaParts.push(esc(e.resp));
  if (comments.length) metaParts.push(comments.length + ' nota' + (comments.length !== 1 ? 's' : ''));
  if (atts.length) metaParts.push(atts.length + ' adj.');

  // For reports (withActions=false) keep the old full render
  if (!withActions) {
    return renderEntryFull(e, showProject);
  }

  var desc = e.desc.length > 100 ? e.desc.substring(0, 100) + '...' : e.desc;
  return '<div class="entry-card" data-entry-id="' + e.id + '">' +
    '<div class="entry-sev-indicator sev-' + e.sev + '"></div>' +
    '<div class="entry-card-body">' +
      '<div class="entry-card-top">' +
        '<span class="entry-date">' + esc(e.fecha) + '</span>' +
        '<span class="badge ' + tipoB + '">' + esc(e.tipo) + '</span>' +
        '<span class="badge ' + sevB + '">' + esc(e.sev) + '</span>' +
        '<span class="badge ' + estB + '">' + esc(estL) + '</span>' +
      '</div>' +
      '<div class="entry-card-desc">' + esc(e.desc) + '</div>' +
      (metaParts.length ? '<div class="entry-card-meta">' + metaParts.join(' &middot; ') + '</div>' : '') +
    '</div>' +
    '<div class="entry-card-arrow">&#8250;</div>' +
  '</div>';
}

// Full render for reports (non-interactive)
function renderEntryFull(e, showProject) {
  var tipoB = e.tipo === 'incidencia' ? 'b-inc' : (e.tipo === 'mejora' ? 'b-mej' : 'b-obs');
  var sevB = 'b-' + (e.sev === 'alta' ? 'high' : e.sev === 'media' ? 'med' : 'low');
  var estB = 'b-' + (e.estado === 'abierta' ? 'open' : e.estado === 'progreso' ? 'prog' : 'done');
  var estL = e.estado === 'progreso' ? 'en progreso' : e.estado;
  var faseLabel = FASES[e.fase] || e.fase || '';
  var atts = (e.attachments || []).map(function(a, i) { return renderAttachment(a, i, false); }).join('');
  var projectLabel = '';
  if (showProject) {
    var proj = state.processes.find(function(p) { return p.id === e.procId; });
    if (proj) projectLabel = '<div class="entry-project">' + esc(proj.code || proj.name) + '</div>';
  }
  var metaParts = [];
  if (e.resp) metaParts.push('Responsable: ' + esc(e.resp));
  if (e.prov) metaParts.push('Proveedor: ' + esc(e.prov));
  if (e.ref) metaParts.push('Ref: ' + esc(e.ref));
  return '<div class="entry sev-' + e.sev + '">' +
    projectLabel +
    '<div class="entry-header">' +
      '<span class="entry-date">' + esc(e.fecha) + '</span>' +
      (faseLabel ? '<span class="badge b-fase">' + esc(faseLabel) + '</span>' : '') +
      '<span class="badge ' + tipoB + '">' + esc(e.tipo) + '</span>' +
      '<span class="badge ' + sevB + '">sev: ' + esc(e.sev) + '</span>' +
      '<span class="badge ' + estB + '">' + esc(estL) + '</span>' +
    '</div>' +
    '<div class="entry-desc">' + esc(e.desc) + '</div>' +
    (e.accion ? '<div class="entry-desc" style="font-style:italic;color:var(--muted);"><strong style="font-style:normal;">Accion:</strong> ' + esc(e.accion) + '</div>' : '') +
    (metaParts.length ? '<div class="entry-meta">' + metaParts.join(' \u00B7 ') + '</div>' : '') +
    (atts ? '<div class="attachments">' + atts + '</div>' : '') +
  '</div>';
}

// ==================== ENTRY DETAIL MODAL ====================
var _currentDetailId = null;

function openEntryDetail(id) {
  var e = state.entries.find(function(x) { return x.id === id; });
  if (!e) return;
  _currentDetailId = id;
  var overlay = document.getElementById('entry-detail-overlay');

  // Badges
  var tipoB = e.tipo === 'incidencia' ? 'b-inc' : (e.tipo === 'mejora' ? 'b-mej' : 'b-obs');
  var sevB = 'b-' + (e.sev === 'alta' ? 'high' : e.sev === 'media' ? 'med' : 'low');
  var estB = 'b-' + (e.estado === 'abierta' ? 'open' : e.estado === 'progreso' ? 'prog' : 'done');
  var estL = e.estado === 'progreso' ? 'en progreso' : e.estado;
  var faseLabel = FASES[e.fase] || e.fase || '';
  document.getElementById('detail-badges').innerHTML =
    (faseLabel ? '<span class="badge b-fase">' + esc(faseLabel) + '</span>' : '') +
    '<span class="badge ' + tipoB + '">' + esc(e.tipo) + '</span>' +
    '<span class="badge ' + sevB + '">sev: ' + esc(e.sev) + '</span>' +
    '<span class="badge ' + estB + ((isAdmin() || e.estado === 'abierta') ? ' clickable" onclick="cycleEstado(' + e.id + ');openEntryDetail(' + e.id + ')' : '') + '">' + esc(estL) + '</span>';

  // Project + date
  var proj = state.processes.find(function(p) { return p.id === e.procId; });
  var projName = proj ? (proj.code ? proj.code + ' \u2014 ' : '') + proj.name : '';
  document.getElementById('detail-project-date').innerHTML =
    (projName ? '<span>' + esc(projName) + '</span><span>\u00B7</span>' : '') +
    '<span>' + esc(e.fecha) + '</span>';

  // Body
  var body = '';
  // Description
  body += '<div class="detail-section">';
  body += '<div class="detail-section-label">Descripcion</div>';
  body += '<div class="detail-section-text">' + esc(e.desc) + '</div>';
  body += '</div>';
  // Action
  if (e.accion) {
    body += '<div class="detail-section">';
    body += '<div class="detail-section-label">Accion / solucion</div>';
    body += '<div class="detail-section-text">' + esc(e.accion) + '</div>';
    body += '</div>';
  }
  // Meta grid
  var hasMeta = e.resp || e.prov || e.ref;
  if (hasMeta) {
    body += '<div class="detail-section"><div class="detail-section-label">Detalles</div><div class="detail-meta-grid">';
    if (e.resp) body += '<div class="detail-meta-item"><div class="detail-section-label">Responsable</div><div class="detail-section-text">' + esc(e.resp) + '</div></div>';
    if (e.prov) body += '<div class="detail-meta-item"><div class="detail-section-label">Proveedor</div><div class="detail-section-text">' + esc(e.prov) + '</div></div>';
    if (e.ref) body += '<div class="detail-meta-item"><div class="detail-section-label">Ref / lote</div><div class="detail-section-text">' + esc(e.ref) + '</div></div>';
    body += '</div></div>';
  }
  // Attachments
  var atts = e.attachments || [];
  if (atts.length) {
    body += '<div class="detail-section"><div class="detail-section-label">Adjuntos (' + atts.length + ')</div>';
    body += '<div class="detail-attachments">' + atts.map(function(a, i) { return renderAttachment(a, i, false); }).join('') + '</div></div>';
  }
  // Comments
  var comments = e.comments || [];
  body += '<div class="detail-section"><div class="detail-section-label">Notas (' + comments.length + ')</div>';
  if (comments.length) {
    body += '<div class="detail-comments-list">';
    comments.forEach(function(c) {
      body += '<div class="detail-comment"><div class="detail-comment-date">' + esc(c.date) + '</div><div class="detail-comment-text">' + esc(c.text) + '</div></div>';
    });
    body += '</div>';
  }
  body += '<div class="detail-add-comment">';
  body += '<input type="text" id="detail-comment-input" placeholder="Anadir nota..." maxlength="500" onkeydown="if(event.key===\'Enter\')addCommentFromDetail()">';
  body += '<button onclick="addCommentFromDetail()">+</button>';
  body += '</div></div>';
  document.getElementById('detail-body').innerHTML = body;

  // Footer actions
  var footer = '';
  var nextEst = { abierta: 'progreso', progreso: 'resuelta', resuelta: 'abierta' };
  var nextVal = nextEst[e.estado];
  // Basico can only move abierta->progreso
  var canCycle = isAdmin() || (nextVal === 'progreso');
  if (canCycle) {
    var nextLabel = nextVal === 'progreso' ? 'En progreso' : (nextVal === 'resuelta' ? 'Resuelta' : 'Abierta');
    var nextIcon = nextVal === 'resuelta' ? '&#9989;' : (nextVal === 'progreso' ? '&#9654;' : '&#9711;');
    footer += '<button class="detail-estado-btn" onclick="cycleEstado(' + e.id + ');openEntryDetail(' + e.id + ')">' + nextIcon + ' ' + esc(nextLabel) + '</button>';
  }
  if (isAdmin()) {
    footer += '<button onclick="openEditEntry(' + e.id + ');closeEntryDetail()" style="background:var(--surface-hover);color:var(--ink);">Editar</button>';
    footer += '<button onclick="duplicateEntry(' + e.id + ');closeEntryDetail()" style="background:var(--surface-hover);color:var(--ink);">Duplicar</button>';
    footer += '<button class="danger" onclick="if(confirm(\'Eliminar esta entrada?\')){deleteEntry(' + e.id + ',true);closeEntryDetail();}">Eliminar</button>';
  }
  document.getElementById('detail-footer').innerHTML = footer;

  overlay.classList.add('active');
  // Force synchronous repaint to ensure the overlay is visible immediately
  void overlay.offsetHeight;
  // Focus the comment input after render
  setTimeout(function() {
    var inp = document.getElementById('detail-comment-input');
    if (inp) inp.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 300);
}

function closeEntryDetail() {
  document.getElementById('entry-detail-overlay').classList.remove('active');
  _currentDetailId = null;
}

function addCommentFromDetail() {
  if (!_currentDetailId) return;
  var input = document.getElementById('detail-comment-input');
  if (!input) return;
  var text = sanitize(input.value, 500);
  if (!text) return;
  var e = state.entries.find(function(x) { return x.id === _currentDetailId; });
  if (!e) return;
  if (!e.comments) e.comments = [];
  e.comments.push({ date: new Date().toISOString().slice(0, 16).replace('T', ' '), text: text });
  save(); refreshEntriesList();
  openEntryDetail(_currentDetailId); // Re-render modal
  showToast('Nota agregada');
}

// ==================== COMMENTS ====================
function addComment(entryId) {
  var input = document.getElementById('comment-' + entryId);
  if (!input) return;
  var text = sanitize(input.value, 500);
  if (!text) return;
  var e = state.entries.find(function(x) { return x.id === entryId; });
  if (!e) return;
  if (!e.comments) e.comments = [];
  e.comments.push({ date: new Date().toISOString().slice(0, 16).replace('T', ' '), text: text });
  save(); refreshEntriesList(); showToast('Nota agregada');
}

// ==================== ENTRY ACTIONS ====================
function deleteEntry(id, skipConfirm) {
  if (!isAdmin()) { showToast('Solo administradores pueden eliminar entradas'); return; }
  if (!skipConfirm && !confirm('Eliminar esta entrada?')) return;
  state.entries = state.entries.filter(function(e) { return e.id !== id; });
  save(); refreshEntriesList(); renderAll(); showToast('Entrada eliminada');
}

function cycleEstado(id) {
  var e = state.entries.find(function(x) { return x.id === id; });
  if (!e) return;
  var next = { abierta: 'progreso', progreso: 'resuelta', resuelta: 'abierta' };
  var nextEstado = next[e.estado] || 'abierta';
  // Basico can move to 'progreso' but only admin can close ('resuelta') or reopen
  if (!isAdmin() && (nextEstado === 'resuelta' || nextEstado === 'abierta')) {
    showToast('Solo administradores pueden cerrar o reabrir entradas');
    return;
  }
  e.estado = nextEstado;
  save(); refreshEntriesList(); renderAll();
  showToast('Estado: ' + (e.estado === 'progreso' ? 'en progreso' : e.estado));
}

function duplicateEntry(id) {
  if (!isAdmin()) { showToast('Solo administradores pueden duplicar entradas'); return; }
  var e = state.entries.find(function(x) { return x.id === id; });
  if (!e) return;
  var clone = JSON.parse(JSON.stringify(e));
  clone.id = Date.now();
  clone.fecha = today();
  clone.estado = 'abierta';
  clone.comments = [];
  clone.desc = '[COPIA] ' + clone.desc;
  state.entries.push(clone);
  save(); refreshEntriesList(); renderAll(); showToast('Entrada duplicada');
}
// ==================== ENTRY EDITING ====================
function openEditEntry(id) {
  if (!isAdmin()) { showToast('Solo administradores pueden editar entradas'); return; }
  var e = state.entries.find(function(x) { return x.id === id; });
  if (!e) return;
  editingEntryId = id;
  document.getElementById('edit-fecha').value = e.fecha;
  document.getElementById('edit-fase').value = e.fase;
  document.getElementById('edit-tipo').value = e.tipo;
  document.getElementById('edit-sev').value = e.sev;
  document.getElementById('edit-estado').value = e.estado;
  document.getElementById('edit-resp').value = e.resp || '';
  document.getElementById('edit-prov').value = e.prov || '';
  document.getElementById('edit-ref').value = e.ref || '';
  document.getElementById('edit-desc').value = e.desc;
  document.getElementById('edit-accion').value = e.accion || '';
  var editOv = document.getElementById('edit-overlay');
  editOv.classList.add('active');
  void editOv.offsetHeight;
}
function closeEditEntry() { document.getElementById('edit-overlay').classList.remove('active'); editingEntryId = null; }
function saveEditEntry() {
  var e = state.entries.find(function(x) { return x.id === editingEntryId; });
  if (!e) return;
  var desc = sanitize(document.getElementById('edit-desc').value, 5000);
  if (!desc) { alert('La descripcion es obligatoria'); return; }
  e.fecha = document.getElementById('edit-fecha').value || e.fecha;
  e.fase = document.getElementById('edit-fase').value;
  e.tipo = document.getElementById('edit-tipo').value;
  e.sev = document.getElementById('edit-sev').value;
  e.estado = document.getElementById('edit-estado').value;
  e.resp = sanitize(document.getElementById('edit-resp').value, 100);
  e.prov = sanitize(document.getElementById('edit-prov').value, 200);
  e.ref = sanitize(document.getElementById('edit-ref').value, 100);
  e.desc = desc;
  e.accion = sanitize(document.getElementById('edit-accion').value, 5000);
  if (VALID_TIPOS.indexOf(e.tipo) === -1) e.tipo = 'incidencia';
  if (VALID_SEVS.indexOf(e.sev) === -1) e.sev = 'media';
  if (VALID_ESTADOS.indexOf(e.estado) === -1) e.estado = 'abierta';
  save(); closeEditEntry(); refreshEntriesList(); renderAll(); showToast('Entrada actualizada');
}

// ==================== REPORT GENERATION ====================
function generateReport() {
  var rpVal = document.getElementById('rep-proc').value;
  var procId = rpVal ? Number(rpVal) : currentProc;
  if (!procId && !rpVal) return generateMultiProjectReport();
  var proc = procId ? state.processes.find(function(p) { return p.id === procId; }) : null;
  if (!proc && rpVal) { alert('Proyecto no encontrado'); return; }
  if (!proc) return;
  var desde = document.getElementById('rep-desde').value;
  var hasta = document.getElementById('rep-hasta').value;
  var faseF = document.getElementById('rep-fase').value;
  var incAtt = document.getElementById('rep-att').value === 'si';
  var list = state.entries.filter(function(e) { return e.procId === proc.id; });
  if (desde) list = list.filter(function(e) { return e.fecha >= desde; });
  if (hasta) list = list.filter(function(e) { return e.fecha <= hasta; });
  if (faseF) list = list.filter(function(e) { return e.fase === faseF; });
  list.sort(function(a, b) { return a.fecha.localeCompare(b.fecha) || a.id - b.id; });
  var total = list.length;
  var nInc = list.filter(function(e) { return e.tipo === 'incidencia'; }).length;
  var nObs = list.filter(function(e) { return e.tipo === 'observacion'; }).length;
  var nMej = list.filter(function(e) { return e.tipo === 'mejora'; }).length;
  var nAbi = list.filter(function(e) { return e.estado === 'abierta'; }).length;
  var nProg = list.filter(function(e) { return e.estado === 'progreso'; }).length;
  var nRes = list.filter(function(e) { return e.estado === 'resuelta'; }).length;
  var nAlta = list.filter(function(e) { return e.sev === 'alta'; }).length;
  var nMed = list.filter(function(e) { return e.sev === 'media'; }).length;
  var nBaja = list.filter(function(e) { return e.sev === 'baja'; }).length;
  var porFase = {}; list.forEach(function(e) { porFase[e.fase] = (porFase[e.fase] || 0) + 1; });
  var proveedores = {}; list.filter(function(e) { return e.prov; }).forEach(function(e) { proveedores[e.prov] = (proveedores[e.prov] || 0) + 1; });
  var byDate = {}; list.forEach(function(e) { (byDate[e.fecha] = byDate[e.fecha] || []).push(e); });
  var fechas = Object.keys(byDate).sort();
  var todayStr = new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
  var rango = (desde || hasta) ? ((desde || 'inicio') + ' a ' + (hasta || 'hoy')) : 'Periodo completo';
  var html = '<div class="card"><div class="report-header"><div><div style="font-size:11px;color:var(--muted);letter-spacing:0.5px;text-transform:uppercase;">EBA - Departamento de producto</div><h1 style="margin:2px 0 0;color:var(--eba);font-size:20px;">Informe de incidencias</h1></div></div>' +
    '<h2 style="margin-top:0.5rem;">' + esc(proc.name) + '</h2>' +
    '<p class="subtitle">' + (proc.code ? '<strong>' + esc(proc.code) + '</strong> - ' : '') + (proc.client ? 'Cliente: ' + esc(proc.client) + ' - ' : '') + esc(rango) + ' - Generado ' + todayStr + '</p>';
  html += '<h2>Resumen ejecutivo</h2><div class="stats"><div class="stat"><div class="stat-label">Total</div><div class="stat-value">' + total + '</div></div><div class="stat hl"><div class="stat-label">Incidencias</div><div class="stat-value">' + nInc + '</div></div><div class="stat"><div class="stat-label">Observaciones</div><div class="stat-value">' + nObs + '</div></div><div class="stat"><div class="stat-label">Mejoras</div><div class="stat-value">' + nMej + '</div></div></div>' +
    '<div class="stats"><div class="stat"><div class="stat-label">Abiertas</div><div class="stat-value">' + nAbi + '</div></div><div class="stat"><div class="stat-label">En progreso</div><div class="stat-value">' + nProg + '</div></div><div class="stat"><div class="stat-label">Resueltas</div><div class="stat-value">' + nRes + '</div></div><div class="stat"><div class="stat-label">% Resueltas</div><div class="stat-value">' + (total ? Math.round(nRes / total * 100) : 0) + '%</div></div></div>';
  if (!total) { html += '<div class="empty">No hay entradas</div></div>'; document.getElementById('report-output').innerHTML = html; return; }
  html += '<p><strong>Severidad:</strong> Alta ' + nAlta + ' - Media ' + nMed + ' - Baja ' + nBaja + '</p>';
  var faseKeys = Object.keys(porFase);
  if (faseKeys.length) { html += '<h2>Desglose por fase</h2><div class="fase-breakdown">'; faseKeys.sort(function(a,b){return porFase[b]-porFase[a];}).forEach(function(k){ html += '<div class="fase-item">' + esc(FASES[k]||k) + '<strong>' + porFase[k] + '</strong></div>'; }); html += '</div>'; }
  var provKeys = Object.keys(proveedores);
  if (provKeys.length) { html += '<h2>Proveedores implicados</h2><ul>'; provKeys.sort(function(a,b){return proveedores[b]-proveedores[a];}).forEach(function(p){ html += '<li>' + esc(p) + ' - ' + proveedores[p] + ' entrada(s)</li>'; }); html += '</ul>'; }
  var altasSR = list.filter(function(e) { return e.sev === 'alta' && e.estado !== 'resuelta'; });
  if (altasSR.length) { html += '<h2>Puntos criticos sin resolver</h2><ul>'; altasSR.forEach(function(e){ html += '<li><strong>[' + esc(e.fecha) + ' - ' + esc(FASES[e.fase]||e.fase) + ']</strong> ' + esc(e.desc) + (e.resp ? ' - ' + esc(e.resp) : '') + '</li>'; }); html += '</ul>'; }
  html += '<h2>Cronologia detallada</h2>';
  fechas.forEach(function(f) { html += '<div class="report-section"><h3>' + esc(f) + '</h3>'; byDate[f].forEach(function(e){ var cl = incAtt ? e : Object.assign({}, e, {attachments:[]}); html += renderEntry(cl, false); }); html += '</div>'; });
  var pct = total ? Math.round(nRes / total * 100) : 0;
  html += '<h2>Conclusiones</h2><p>Se han registrado ' + total + ' entradas: ' + nInc + ' incidencias, ' + nObs + ' observaciones y ' + nMej + ' mejoras. El ' + pct + '% resueltas.</p></div>';
  document.getElementById('report-output').innerHTML = html;
}

function generateMultiProjectReport() {
  var desde = document.getElementById('rep-desde').value;
  var hasta = document.getElementById('rep-hasta').value;
  var faseF = document.getElementById('rep-fase').value;
  var incAtt = document.getElementById('rep-att').value === 'si';
  var list = state.entries.slice();
  if (desde) list = list.filter(function(e) { return e.fecha >= desde; });
  if (hasta) list = list.filter(function(e) { return e.fecha <= hasta; });
  if (faseF) list = list.filter(function(e) { return e.fase === faseF; });
  list.sort(function(a,b) { return a.fecha.localeCompare(b.fecha) || a.id - b.id; });
  var total = list.length;
  var nInc = list.filter(function(e){return e.tipo==='incidencia';}).length;
  var nObs = list.filter(function(e){return e.tipo==='observacion';}).length;
  var nMej = list.filter(function(e){return e.tipo==='mejora';}).length;
  var nAbi = list.filter(function(e){return e.estado==='abierta';}).length;
  var nRes = list.filter(function(e){return e.estado==='resuelta';}).length;
  var todayStr = new Date().toLocaleDateString('es-ES',{year:'numeric',month:'long',day:'numeric'});
  var rango = (desde||hasta) ? ((desde||'inicio') + ' a ' + (hasta||'hoy')) : 'Periodo completo';
  var html = '<div class="card"><div class="report-header"><div><div style="font-size:11px;color:var(--muted);letter-spacing:0.5px;text-transform:uppercase;">EBA - Departamento de producto</div><h1 style="margin:2px 0 0;color:var(--eba);font-size:20px;">Informe general</h1></div></div>' +
    '<h2 style="margin-top:0.5rem;">Todos los proyectos</h2><p class="subtitle">' + esc(rango) + ' - Generado ' + todayStr + '</p>';
  html += '<div class="stats"><div class="stat"><div class="stat-label">Total</div><div class="stat-value">' + total + '</div></div><div class="stat hl"><div class="stat-label">Incidencias</div><div class="stat-value">' + nInc + '</div></div><div class="stat"><div class="stat-label">Observaciones</div><div class="stat-value">' + nObs + '</div></div><div class="stat"><div class="stat-label">Mejoras</div><div class="stat-value">' + nMej + '</div></div></div>';
  if (!total) { html += '<div class="empty">No hay entradas</div></div>'; document.getElementById('report-output').innerHTML = html; return; }
  html += '<h2>Desglose por proyecto</h2>';
  state.processes.forEach(function(proc) {
    var pe = list.filter(function(e){return e.procId === proc.id;});
    if (!pe.length) return;
    var pAbi = pe.filter(function(e){return e.estado!=='resuelta';}).length;
    html += '<div class="fase-item">' + (proc.code ? '<strong>' + esc(proc.code) + '</strong> - ':'') + esc(proc.name) + '<br><span style="font-size:11px;color:var(--muted);">' + pe.length + ' entradas, ' + pAbi + ' sin resolver</span></div>';
  });
  var byDate = {}; list.forEach(function(e){(byDate[e.fecha]=byDate[e.fecha]||[]).push(e);});
  var fechas = Object.keys(byDate).sort();
  html += '<h2>Cronologia</h2>';
  fechas.forEach(function(f) { html += '<div class="report-section"><h3>' + esc(f) + '</h3>'; byDate[f].forEach(function(e){ var proc = state.processes.find(function(p){return p.id===e.procId;}); if(proc) html += '<div style="font-size:11px;color:var(--eba);font-weight:600;margin-top:8px;">' + esc(proc.code||proc.name) + '</div>'; var cl = incAtt ? e : Object.assign({},e,{attachments:[]}); html += renderEntry(cl, false); }); html += '</div>'; });
  var pct = total ? Math.round(nRes/total*100) : 0;
  html += '<h2>Conclusiones</h2><p>' + total + ' entradas en ' + state.processes.length + ' proyectos: ' + nInc + ' incidencias, ' + nObs + ' observaciones, ' + nMej + ' mejoras. ' + pct + '% resueltas.</p></div>';
  document.getElementById('report-output').innerHTML = html;
}
// ==================== DATA MANAGEMENT ====================
function exportJSON() {
  var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = 'eba-incidencias-' + today() + '.json'; a.click();
  URL.revokeObjectURL(url); showToast('JSON exportado');
}

function exportCSV() {
  var sep = ';';
  var header = ['Proyecto','Codigo','Fecha','Fase','Tipo','Severidad','Estado','Responsable','Proveedor','Referencia','Descripcion','Accion','Notas'];
  var rows = [header.join(sep)];
  state.entries.forEach(function(e) {
    var proc = state.processes.find(function(p) { return p.id === e.procId; });
    var procName = proc ? proc.name : '';
    var procCode = proc ? (proc.code || '') : '';
    var comments = (e.comments || []).map(function(c) { return c.date + ': ' + c.text; }).join(' | ');
    var row = [procName, procCode, e.fecha, FASES[e.fase]||e.fase, e.tipo, e.sev, e.estado, e.resp||'', e.prov||'', e.ref||'', e.desc, e.accion||'', comments];
    rows.push(row.map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(sep));
  });
  var bom = '\uFEFF';
  var blob = new Blob([bom + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = 'eba-incidencias-' + today() + '.csv'; a.click();
  URL.revokeObjectURL(url); showToast('CSV exportado');
}

function importJSON(ev) {
  var f = ev.target.files[0]; if (!f) return;
  var r = new FileReader();
  r.onload = function(e) {
    try {
      var data = JSON.parse(e.target.result);
      if (!data.processes || !data.entries) { alert('Formato no valido'); return; }
      if (!confirm('Reemplazar datos actuales?')) return;
      state = data; save(); selectProcess(null); renderAll(); showToast('Datos importados');
    } catch (err) { alert('Archivo invalido: ' + err.message); }
  };
  r.readAsText(f); ev.target.value = '';
}

function wipeAll() {
  if (!isAdmin()) { showToast('Solo administradores pueden borrar datos'); return; }
  if (!confirm('Borrar TODOS los datos?')) return;
  if (!confirm('Ultima confirmacion: seguro?')) return;
  state = { processes: [], entries: [] }; currentProc = null;
  save(); selectProcess(null); showToast('Datos eliminados');
}

// ==================== GLOBAL SEARCH ====================
function openGlobalSearch() {
  document.getElementById('global-search-wrap').classList.add('active');
  var input = document.getElementById('global-search-input');
  input.value = ''; input.focus();
  document.getElementById('global-search-results').innerHTML = '';
}
function closeGlobalSearch() { document.getElementById('global-search-wrap').classList.remove('active'); }

function performGlobalSearch(query) {
  var el = document.getElementById('global-search-results');
  var q = query.toLowerCase().trim();
  if (q.length < 2) { el.innerHTML = ''; return; }
  var results = state.entries.filter(function(e) {
    return (e.desc + ' ' + (e.resp||'') + ' ' + (e.prov||'') + ' ' + (e.ref||'') + ' ' + (e.accion||'')).toLowerCase().indexOf(q) !== -1;
  }).slice(0, 20);
  if (!results.length) { el.innerHTML = '<div class="gs-empty">Sin resultados</div>'; return; }
  el.innerHTML = results.map(function(e) {
    var proc = state.processes.find(function(p) { return p.id === e.procId; });
    var projLabel = proc ? (proc.code || proc.name) : '';
    var snippet = e.desc.length > 80 ? e.desc.substring(0, 80) + '...' : e.desc;
    return '<div class="gs-result" onclick="goToEntry(' + e.id + ')">' +
      '<div class="gs-result-title">' + esc(snippet) + '</div>' +
      '<div class="gs-result-meta">' + esc(projLabel) + ' - ' + esc(e.fecha) + ' - ' + esc(e.tipo) + ' - ' + esc(e.estado) + '</div>' +
    '</div>';
  }).join('');
}

function goToEntry(entryId) {
  closeGlobalSearch();
  var e = state.entries.find(function(x) { return x.id === entryId; });
  if (!e) return;
  var fp = document.getElementById('filt-proc');
  if (fp) fp.value = String(e.procId);
  switchTab('listado');
  setTimeout(function() { openEntryDetail(entryId); }, 100);
}

// ==================== UI HELPERS ====================
function toggleCollapsible(id, toggleEl) {
  var body = document.getElementById(id);
  var arrow = toggleEl.querySelector('.collapsible-arrow');
  body.classList.toggle('open');
  if (arrow) arrow.classList.toggle('open');
}

function updateFab() {
  var fab = document.getElementById('fab');
  if (!fab) return;
  var activeTab = document.querySelector('.tab.active');
  var tabName = activeTab ? activeTab.dataset.tab : '';
  if (currentProc && tabName !== 'registro') fab.classList.remove('hidden');
  else fab.classList.add('hidden');
}

function updateTabBadges() {
  var listTab = document.querySelector('.tab[data-tab="listado"]');
  if (!listTab) return;
  var openCount = state.entries.filter(function(e) { return e.estado !== 'resuelta'; }).length;
  var badge = listTab.querySelector('.tab-count');
  if (!badge) { badge = document.createElement('span'); badge.className = 'tab-count'; listTab.appendChild(badge); }
  badge.textContent = openCount;
  badge.className = 'tab-count' + (openCount === 0 ? ' zero' : '');
}

function updateFilterCount() {
  var count = 0;
  var el = document.getElementById('filter-count');
  if (!el) return;
  if (document.getElementById('filt-proc').value) count++;
  if (document.getElementById('filt-fase').value) count++;
  if (document.getElementById('filt-tipo').value) count++;
  if (document.getElementById('filt-sev').value) count++;
  if (document.getElementById('filt-estado').value) count++;
  if (document.getElementById('filt-text').value.trim()) count++;
  if (count > 0) { el.textContent = count + ' activo' + (count > 1 ? 's' : ''); el.style.display = 'inline'; }
  else { el.style.display = 'none'; }
}

// ==================== TABS ====================
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(x) { x.classList.toggle('active', x.dataset.tab === name); });
  ['procesos','registro','listado','informe','datos'].forEach(function(id) { document.getElementById('tab-' + id).style.display = id === name ? 'block' : 'none'; });
  if (name === 'listado') { populateProjectFilters(); refreshEntriesList(); }
  if (name === 'informe') populateProjectFilters();
  if (name === 'procesos') { renderProcList(); renderDashboard(); }
  updateFab();
  if (getSyncProvider()) syncPull();
}

// ==================== INIT ====================
document.querySelectorAll('.tab').forEach(function(t) {
  t.onclick = function() { if (!t.disabled) switchTab(t.dataset.tab); };
});
document.getElementById('f-files').addEventListener('change', handleFileSelection);
document.getElementById('f-camera').addEventListener('change', handleFileSelection);
['filt-proc','filt-fase','filt-tipo','filt-estado','filt-sev'].forEach(function(id) {
  document.getElementById(id).addEventListener('change', refreshEntriesList);
});
var filterTimer = null;
document.getElementById('filt-text').addEventListener('input', function() {
  clearTimeout(filterTimer); filterTimer = setTimeout(refreshEntriesList, 250);
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') { closeLightbox(); closeEditEntry(); closeGlobalSearch(); closeEntryDetail(); }
});
document.getElementById('edit-overlay').addEventListener('click', function(e) { if (e.target === this) closeEditEntry(); });
document.getElementById('entry-detail-overlay').addEventListener('click', function(e) { if (e.target === this) closeEntryDetail(); });

// Event delegation for entry cards (more robust than inline onclick)
document.addEventListener('click', function(e) {
  var card = e.target.closest('.entry-card');
  if (card && card.dataset.entryId) {
    openEntryDetail(Number(card.dataset.entryId));
  }
});

load();
