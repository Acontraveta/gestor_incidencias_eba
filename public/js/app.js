// ==================== CONSTANTS ====================
const APP_KEY = 'eba-incidencias-v2';
const MAX_FILE_MB = 4;
const MAX_IMG_DIM = 1600;
const IMG_QUALITY = 0.82;
const FASES = {
  diseno: 'Diseño', prototipo: 'Prototipo', proveedores: 'Proveedores / compras',
  materiales: 'Recepción materiales', fabricacion: 'Fabricación', acabados: 'Acabados',
  calidad: 'Control calidad', embalaje: 'Embalaje', logistica: 'Logística / envío',
  instalacion: 'Instalación / montaje', postventa: 'Postventa'
};
const VALID_TIPOS = ['incidencia', 'observacion', 'mejora'];
const VALID_SEVS = ['baja', 'media', 'alta'];
const VALID_ESTADOS = ['abierta', 'progreso', 'resuelta'];
const ALLOWED_EXTENSIONS = ['.png','.jpg','.jpeg','.gif','.webp','.pdf','.doc','.docx','.xls','.xlsx','.txt','.csv','.dwg','.zip'];
const LOGO_SELECTOR = '.brand img';

// ==================== STATE ====================
let state = { processes: [], entries: [] };
let currentProc = null;
let pendingAttachments = [];
let editingEntryId = null;

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

// ==================== STORAGE ====================
function load() {
  try {
    var raw = localStorage.getItem(APP_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) { /* corrupted data, start fresh */ }
  if (!state.processes) state.processes = [];
  if (!state.entries) state.entries = [];
  document.getElementById('f-fecha').value = today();
  renderProcList();
  populateProjectFilters();
}

function save() {
  try {
    localStorage.setItem(APP_KEY, JSON.stringify(state));
  } catch (e) {
    alert('Error guardando: ' + e.message + '\nPosible causa: adjuntos demasiado grandes. Intenta reducir fotos o eliminar entradas antiguas.');
  }
}

// ==================== PROJECT SELECTION ====================
function selectProcess(id) {
  currentProc = id;
  var bar = document.getElementById('current-proc-bar');
  var regTab = document.querySelector('.tab[data-tab="registro"]');
  if (id) {
    var p = state.processes.find(function(x) { return x.id === id; });
    if (!p) { selectProcess(null); return; }
    document.getElementById('current-proc-name').textContent = (p.code ? p.code + ' — ' : '') + p.name;
    bar.style.display = 'flex';
    regTab.disabled = false;
    // Pre-select current project in filters
    var fp = document.getElementById('filt-proc');
    var rp = document.getElementById('rep-proc');
    if (fp) fp.value = String(id);
    if (rp) rp.value = String(id);
    switchTab('registro');
  } else {
    bar.style.display = 'none';
    regTab.disabled = true;
    switchTab('procesos');
  }
  renderProcList();
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
    var altas = entries.filter(function(e) { return e.sev === 'alta' && e.estado !== 'resuelta'; }).length;
    var active = p.id === currentProc ? ' active' : '';
    return '<div class="proc-card' + active + '" onclick="selectProcess(' + p.id + ')">' +
      (p.code ? '<div class="proc-code">' + esc(p.code) + '</div>' : '') +
      '<div class="proc-name">' + esc(p.name) + '</div>' +
      (p.client ? '<div class="proc-meta">Cliente: ' + esc(p.client) + '</div>' : '') +
      (p.desc ? '<div class="proc-meta">' + esc(p.desc) + '</div>' : '') +
      '<div class="proc-meta" style="margin-top:6px;">' + entries.length + ' entradas · ' + abiertas + ' sin resolver' + (altas ? ' · <span style="color:var(--eba-dark);font-weight:500;">' + altas + ' crítica(s)</span>' : '') + '</div>' +
      '<div class="actions">' +
        '<button onclick="event.stopPropagation();editProcess(' + p.id + ')" style="width:auto;flex:0 0 auto;font-size:12px;padding:4px 8px;">Editar</button>' +
        '<button class="danger" onclick="event.stopPropagation();deleteProcess(' + p.id + ')" style="width:auto;flex:0 0 auto;font-size:12px;padding:4px 8px;">Eliminar</button>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function addProcess() {
  var name = sanitize(document.getElementById('new-proc-name').value, 200);
  if (!name) { alert('Introduce un nombre para el proyecto'); return; }
  state.processes.push({
    id: Date.now(),
    code: sanitize(document.getElementById('new-proc-code').value, 50),
    name: name,
    client: sanitize(document.getElementById('new-proc-client').value, 200),
    desc: sanitize(document.getElementById('new-proc-desc').value, 500),
    created: new Date().toISOString()
  });
  ['new-proc-code', 'new-proc-name', 'new-proc-client', 'new-proc-desc'].forEach(function(id) {
    document.getElementById(id).value = '';
  });
  save();
  renderProcList();
  populateProjectFilters();
  showToast('Proyecto creado');
}

function editProcess(id) {
  var p = state.processes.find(function(x) { return x.id === id; });
  if (!p) return;
  var name = prompt('Nombre del proyecto:', p.name);
  if (!name || !name.trim()) return;
  p.name = sanitize(name, 200);
  var code = prompt('Código / referencia:', p.code || '');
  if (code !== null) p.code = sanitize(code, 50);
  var client = prompt('Cliente:', p.client || '');
  if (client !== null) p.client = sanitize(client, 200);
  var desc = prompt('Descripción:', p.desc || '');
  if (desc !== null) p.desc = sanitize(desc, 500);
  save();
  renderProcList();
  populateProjectFilters();
  if (currentProc === id) {
    document.getElementById('current-proc-name').textContent = (p.code ? p.code + ' — ' : '') + p.name;
  }
  showToast('Proyecto actualizado');
}

function deleteProcess(id) {
  var p = state.processes.find(function(x) { return x.id === id; });
  if (!p) return;
  var count = state.entries.filter(function(e) { return e.procId === id; }).length;
  if (!confirm('¿Eliminar "' + p.name + '"?\nSe borrarán también sus ' + count + ' entrada(s).')) return;
  state.processes = state.processes.filter(function(x) { return x.id !== id; });
  state.entries = state.entries.filter(function(e) { return e.procId !== id; });
  if (currentProc === id) { selectProcess(null); }
  save();
  renderProcList();
  populateProjectFilters();
  showToast('Proyecto eliminado');
}

// ==================== FILE HANDLING ====================
function handleFileSelection(ev) {
  Array.from(ev.target.files).forEach(function(file) {
    processFile(file);
  });
  ev.target.value = '';
}

function processFile(file) {
  var ext = file.name.lastIndexOf('.') !== -1 ? file.name.substring(file.name.lastIndexOf('.')).toLowerCase() : '';
  if (ALLOWED_EXTENSIONS.indexOf(ext) === -1) {
    alert('Tipo de archivo no permitido: ' + ext);
    return;
  }
  if (file.type && file.type.startsWith('image/')) {
    compressImage(file).then(function(processed) {
      pendingAttachments.push(processed);
      renderPendingAttachments();
    }).catch(function(e) {
      alert('Error procesando imagen: ' + e.message);
    });
  } else {
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      alert('"' + file.name + '" supera ' + MAX_FILE_MB + 'MB.');
      return;
    }
    fileToBase64(file).then(function(data) {
      pendingAttachments.push({ name: file.name, type: file.type, size: file.size, data: data });
      renderPendingAttachments();
    }).catch(function(e) {
      alert('Error leyendo archivo: ' + e.message);
    });
  }
}

function compressImage(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var img = new Image();
      img.onload = function() {
        var w = img.width, h = img.height;
        if (w > MAX_IMG_DIM || h > MAX_IMG_DIM) {
          if (w > h) { h = Math.round(h * MAX_IMG_DIM / w); w = MAX_IMG_DIM; }
          else { w = Math.round(w * MAX_IMG_DIM / h); h = MAX_IMG_DIM; }
        }
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        var data = canvas.toDataURL('image/jpeg', IMG_QUALITY);
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
  return new Promise(function(res, rej) {
    var r = new FileReader();
    r.onload = function() { res(r.result); };
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function renderPendingAttachments() {
  var el = document.getElementById('f-attachments');
  if (!pendingAttachments.length) { el.innerHTML = ''; return; }
  el.innerHTML = pendingAttachments.map(function(a, i) { return renderAttachment(a, i, true); }).join('');
}

function renderAttachment(a, idx, removable) {
  var isImg = a.type && a.type.startsWith('image/');
  var rm = removable ? '<button class="att-remove" onclick="event.stopPropagation();removePending(' + idx + ')">×</button>' : '';
  if (isImg) {
    return '<div class="att"><img src="' + a.data + '" onclick="openLightbox(this.src)" alt="' + esc(a.name) + '">' + rm + '</div>';
  }
  var icon = a.type === 'application/pdf' ? '📄' : '📎';
  var shortName = a.name.length > 20 ? a.name.slice(0, 18) + '…' : a.name;
  return '<div class="att"><div class="att-file" data-data="' + a.data + '" data-name="' + esc(a.name) + '" onclick="downloadAtt(this)"><div class="att-file-icon">' + icon + '</div>' + esc(shortName) + '</div>' + rm + '</div>';
}

function removePending(i) {
  pendingAttachments.splice(i, 1);
  renderPendingAttachments();
}

function downloadAtt(el) {
  var a = document.createElement('a');
  a.href = el.dataset.data;
  a.download = el.dataset.name;
  a.click();
}

function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('active');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('active');
}

// ==================== ENTRY CRUD ====================
function addEntry() {
  if (!currentProc) { alert('Selecciona un proyecto primero'); return; }
  var desc = sanitize(document.getElementById('f-desc').value, 5000);
  if (!desc) { alert('La descripción es obligatoria'); return; }
  var fase = document.getElementById('f-fase').value;
  var tipo = document.getElementById('f-tipo').value;
  var sev = document.getElementById('f-sev').value;
  var estado = document.getElementById('f-estado').value;
  if (!FASES[fase]) { alert('Fase no válida'); return; }
  if (VALID_TIPOS.indexOf(tipo) === -1) tipo = 'incidencia';
  if (VALID_SEVS.indexOf(sev) === -1) sev = 'media';
  if (VALID_ESTADOS.indexOf(estado) === -1) estado = 'abierta';

  state.entries.push({
    id: Date.now(),
    procId: currentProc,
    fecha: document.getElementById('f-fecha').value || today(),
    fase: fase,
    tipo: tipo,
    sev: sev,
    estado: estado,
    resp: sanitize(document.getElementById('f-resp').value, 100),
    prov: sanitize(document.getElementById('f-prov').value, 200),
    ref: sanitize(document.getElementById('f-ref').value, 100),
    desc: desc,
    accion: sanitize(document.getElementById('f-accion').value, 5000),
    attachments: pendingAttachments.slice()
  });
  save();
  clearForm();
  showToast('Entrada añadida');
  renderProcList();
}

function clearForm() {
  ['f-desc', 'f-resp', 'f-prov', 'f-ref', 'f-accion'].forEach(function(id) {
    document.getElementById(id).value = '';
  });
  document.getElementById('f-fecha').value = today();
  document.getElementById('f-sev').value = 'media';
  document.getElementById('f-estado').value = 'abierta';
  pendingAttachments = [];
  renderPendingAttachments();
}

function getCurrentEntries() {
  return state.entries.filter(function(e) { return e.procId === currentProc; });
}

function getFilteredEntries(procFilterId) {
  if (procFilterId) {
    var pid = Number(procFilterId);
    return state.entries.filter(function(e) { return e.procId === pid; });
  }
  return state.entries.slice();
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
  var list = allForProc.sort(function(a, b) { return b.fecha.localeCompare(a.fecha) || b.id - a.id; });
  if (ff) list = list.filter(function(e) { return e.fase === ff; });
  if (fi) list = list.filter(function(e) { return e.tipo === fi; });
  if (fe) list = list.filter(function(e) { return e.estado === fe; });
  if (fs) list = list.filter(function(e) { return e.sev === fs; });
  if (ft) list = list.filter(function(e) {
    return (e.desc + ' ' + (e.resp || '') + ' ' + (e.prov || '') + ' ' + (e.ref || '') + ' ' + (e.accion || '')).toLowerCase().indexOf(ft) !== -1;
  });
  var total = allForProc.length;
  var shown = list.length;
  var header = '<div style="font-size:12px;color:var(--hint);margin-bottom:8px;">' + shown + ' de ' + total + ' entradas</div>';
  if (!list.length) { el.innerHTML = header + '<div class="empty">Sin entradas con estos filtros</div>'; return; }
  el.innerHTML = header + list.map(function(e) { return renderEntry(e, true); }).join('');
}

function renderEntry(e, withActions) {
  var tipoB = e.tipo === 'incidencia' ? 'b-inc' : (e.tipo === 'mejora' ? 'b-mej' : 'b-obs');
  var sevB = 'b-' + (e.sev === 'alta' ? 'high' : e.sev === 'media' ? 'med' : 'low');
  var estB = 'b-' + (e.estado === 'abierta' ? 'open' : e.estado === 'progreso' ? 'prog' : 'done');
  var estL = e.estado === 'progreso' ? 'en progreso' : e.estado;
  var faseLabel = FASES[e.fase] || e.fase || '';
  var atts = (e.attachments || []).map(function(a, i) { return renderAttachment(a, i, false); }).join('');
  var actions = withActions ? '<div class="actions no-print">' +
    '<button onclick="cycleEstado(' + e.id + ')" style="width:auto;flex:0 0 auto;font-size:12px;padding:4px 10px;">Cambiar estado</button>' +
    '<button onclick="openEditEntry(' + e.id + ')" style="width:auto;flex:0 0 auto;font-size:12px;padding:4px 10px;">Editar</button>' +
    '<button class="danger" onclick="deleteEntry(' + e.id + ')" style="width:auto;flex:0 0 auto;font-size:12px;padding:4px 10px;">Eliminar</button>' +
  '</div>' : '';
  var metaParts = [];
  if (e.resp) metaParts.push('Responsable: ' + esc(e.resp));
  if (e.prov) metaParts.push('Proveedor: ' + esc(e.prov));
  if (e.ref) metaParts.push('Ref: ' + esc(e.ref));
  return '<div class="entry">' +
    '<div class="entry-header">' +
      '<span class="entry-date">' + esc(e.fecha) + '</span>' +
      (faseLabel ? '<span class="badge b-fase">' + esc(faseLabel) + '</span>' : '') +
      '<span class="badge ' + tipoB + '">' + esc(e.tipo) + '</span>' +
      '<span class="badge ' + sevB + '">sev: ' + esc(e.sev) + '</span>' +
      '<span class="badge ' + estB + '">' + esc(estL) + '</span>' +
    '</div>' +
    '<div class="entry-desc">' + esc(e.desc) + '</div>' +
    (e.accion ? '<div class="entry-desc" style="font-style:italic;color:var(--muted);"><strong style="font-style:normal;">Acción:</strong> ' + esc(e.accion) + '</div>' : '') +
    (metaParts.length ? '<div class="entry-meta">' + metaParts.join(' · ') + '</div>' : '') +
    (atts ? '<div class="attachments">' + atts + '</div>' : '') +
    actions +
  '</div>';
}

function deleteEntry(id) {
  if (!confirm('¿Eliminar esta entrada?')) return;
  state.entries = state.entries.filter(function(e) { return e.id !== id; });
  save();
  refreshEntriesList();
  renderProcList();
  showToast('Entrada eliminada');
}

function cycleEstado(id) {
  var e = state.entries.find(function(x) { return x.id === id; });
  if (!e) return;
  var next = { abierta: 'progreso', progreso: 'resuelta', resuelta: 'abierta' };
  e.estado = next[e.estado] || 'abierta';
  save();
  refreshEntriesList();
  renderProcList();
  var label = e.estado === 'progreso' ? 'en progreso' : e.estado;
  showToast('Estado → ' + label);
}

// ==================== ENTRY EDITING ====================
function openEditEntry(id) {
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
  document.getElementById('edit-overlay').classList.add('active');
}

function closeEditEntry() {
  document.getElementById('edit-overlay').classList.remove('active');
  editingEntryId = null;
}

function saveEditEntry() {
  var e = state.entries.find(function(x) { return x.id === editingEntryId; });
  if (!e) return;
  var desc = sanitize(document.getElementById('edit-desc').value, 5000);
  if (!desc) { alert('La descripción es obligatoria'); return; }
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
  save();
  closeEditEntry();
  refreshEntriesList();
  renderProcList();
  showToast('Entrada actualizada');
}

// ==================== REPORT GENERATION ====================
function generateReport() {
  var rpVal = document.getElementById('rep-proc').value;
  var procId = rpVal ? Number(rpVal) : currentProc;
  if (!procId && !rpVal) {
    // No project selected at all - generate for all
    return generateMultiProjectReport();
  }
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

  var porFase = {};
  list.forEach(function(e) { porFase[e.fase] = (porFase[e.fase] || 0) + 1; });

  var proveedores = {};
  list.filter(function(e) { return e.prov; }).forEach(function(e) { proveedores[e.prov] = (proveedores[e.prov] || 0) + 1; });

  var byDate = {};
  list.forEach(function(e) { (byDate[e.fecha] = byDate[e.fecha] || []).push(e); });
  var fechas = Object.keys(byDate).sort();

  var todayStr = new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
  var rango = (desde || hasta) ? ((desde || 'inicio') + ' a ' + (hasta || 'hoy')) : 'Periodo completo';

  var logoEl = document.querySelector(LOGO_SELECTOR);
  var logoSrc = logoEl ? logoEl.src : '';

  var html = '<div class="card">' +
    '<div class="report-header">' +
      (logoSrc ? '<img src="' + logoSrc + '" alt="logo">' : '') +
      '<div>' +
        '<div style="font-size:11px;color:var(--muted);letter-spacing:0.5px;text-transform:uppercase;">EBA · Departamento de producto</div>' +
        '<h1 style="margin:2px 0 0;color:var(--eba);font-size:20px;">Informe de incidencias</h1>' +
      '</div>' +
    '</div>' +
    '<h2 style="margin-top:0.5rem;">' + esc(proc.name) + '</h2>' +
    '<p class="subtitle">' +
      (proc.code ? '<strong>' + esc(proc.code) + '</strong> · ' : '') +
      (proc.client ? 'Cliente: ' + esc(proc.client) + ' · ' : '') +
      esc(rango) + ' · Generado ' + todayStr +
    '</p>';

  html += '<h2>Resumen ejecutivo</h2>' +
    '<div class="stats">' +
      '<div class="stat"><div class="stat-label">Total</div><div class="stat-value">' + total + '</div></div>' +
      '<div class="stat hl"><div class="stat-label">Incidencias</div><div class="stat-value">' + nInc + '</div></div>' +
      '<div class="stat"><div class="stat-label">Observaciones</div><div class="stat-value">' + nObs + '</div></div>' +
      '<div class="stat"><div class="stat-label">Mejoras</div><div class="stat-value">' + nMej + '</div></div>' +
    '</div>' +
    '<div class="stats">' +
      '<div class="stat"><div class="stat-label">Abiertas</div><div class="stat-value">' + nAbi + '</div></div>' +
      '<div class="stat"><div class="stat-label">En progreso</div><div class="stat-value">' + nProg + '</div></div>' +
      '<div class="stat"><div class="stat-label">Resueltas</div><div class="stat-value">' + nRes + '</div></div>' +
      '<div class="stat"><div class="stat-label">% Resueltas</div><div class="stat-value">' + (total ? Math.round(nRes / total * 100) : 0) + '%</div></div>' +
    '</div>';

  if (total === 0) {
    html += '<div class="empty">No hay entradas para los filtros seleccionados</div></div>';
    document.getElementById('report-output').innerHTML = html;
    return;
  }

  html += '<p><strong>Severidad:</strong> Alta ' + nAlta + ' · Media ' + nMed + ' · Baja ' + nBaja + '</p>';

  var faseKeys = Object.keys(porFase);
  if (faseKeys.length) {
    html += '<h2>Desglose por fase del proceso</h2><div class="fase-breakdown">';
    faseKeys.sort(function(a, b) { return porFase[b] - porFase[a]; }).forEach(function(k) {
      html += '<div class="fase-item">' + esc(FASES[k] || k) + '<strong>' + porFase[k] + '</strong></div>';
    });
    html += '</div>';
  }

  var provKeys = Object.keys(proveedores);
  if (provKeys.length) {
    html += '<h2>Proveedores implicados</h2><ul>';
    provKeys.sort(function(a, b) { return proveedores[b] - proveedores[a]; }).forEach(function(p) {
      html += '<li>' + esc(p) + ' — ' + proveedores[p] + ' entrada(s)</li>';
    });
    html += '</ul>';
  }

  var altasSR = list.filter(function(e) { return e.sev === 'alta' && e.estado !== 'resuelta'; });
  if (altasSR.length) {
    html += '<h2>⚠ Puntos críticos sin resolver</h2><ul>';
    altasSR.forEach(function(e) {
      html += '<li><strong>[' + esc(e.fecha) + ' · ' + esc(FASES[e.fase] || e.fase) + ']</strong> ' + esc(e.desc) + (e.resp ? ' — ' + esc(e.resp) : '') + '</li>';
    });
    html += '</ul>';
  }

  html += '<h2>Cronología detallada</h2>';
  fechas.forEach(function(f) {
    html += '<div class="report-section"><h3>' + esc(f) + '</h3>';
    byDate[f].forEach(function(e) {
      var clone = incAtt ? e : Object.assign({}, e, { attachments: [] });
      html += renderEntry(clone, false);
    });
    html += '</div>';
  });

  var pct = total ? Math.round(nRes / total * 100) : 0;
  var concl = 'Durante el periodo analizado se han registrado ' + total + ' entradas en el proyecto "' + esc(proc.name) + '"';
  if (proc.client) concl += ' (cliente: ' + esc(proc.client) + ')';
  concl += ': ' + nInc + ' incidencias, ' + nObs + ' observaciones y ' + nMej + ' propuestas de mejora. ';
  if (faseKeys.length > 1) {
    var faseTop = faseKeys.sort(function(a, b) { return porFase[b] - porFase[a]; })[0];
    concl += 'La fase con mayor concentración de entradas es <strong>' + esc(FASES[faseTop] || faseTop) + '</strong> (' + porFase[faseTop] + '). ';
  }
  if (nAlta > 0) concl += 'Se identificaron <strong>' + nAlta + ' entrada(s) de severidad alta</strong>. ';
  concl += 'El ' + pct + '% están resueltas';
  if (nAbi > 0) concl += ', ' + nAbi + ' permanecen abiertas';
  if (nProg > 0) concl += ' y ' + nProg + ' en progreso';
  concl += '.';
  html += '<h2>Conclusiones</h2><p>' + concl + '</p></div>';

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

  var todayStr = new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
  var rango = (desde || hasta) ? ((desde || 'inicio') + ' a ' + (hasta || 'hoy')) : 'Periodo completo';

  var logoEl = document.querySelector(LOGO_SELECTOR);
  var logoSrc = logoEl ? logoEl.src : '';

  var html = '<div class="card">' +
    '<div class="report-header">' +
      (logoSrc ? '<img src="' + logoSrc + '" alt="logo">' : '') +
      '<div>' +
        '<div style="font-size:11px;color:var(--muted);letter-spacing:0.5px;text-transform:uppercase;">EBA - Departamento de producto</div>' +
        '<h1 style="margin:2px 0 0;color:var(--eba);font-size:20px;">Informe general de incidencias</h1>' +
      '</div>' +
    '</div>' +
    '<h2 style="margin-top:0.5rem;">Todos los proyectos</h2>' +
    '<p class="subtitle">' + esc(rango) + ' - Generado ' + todayStr + '</p>';

  html += '<h2>Resumen ejecutivo</h2>' +
    '<div class="stats">' +
      '<div class="stat"><div class="stat-label">Total</div><div class="stat-value">' + total + '</div></div>' +
      '<div class="stat hl"><div class="stat-label">Incidencias</div><div class="stat-value">' + nInc + '</div></div>' +
      '<div class="stat"><div class="stat-label">Observaciones</div><div class="stat-value">' + nObs + '</div></div>' +
      '<div class="stat"><div class="stat-label">Mejoras</div><div class="stat-value">' + nMej + '</div></div>' +
    '</div>' +
    '<div class="stats">' +
      '<div class="stat"><div class="stat-label">Abiertas</div><div class="stat-value">' + nAbi + '</div></div>' +
      '<div class="stat"><div class="stat-label">En progreso</div><div class="stat-value">' + nProg + '</div></div>' +
      '<div class="stat"><div class="stat-label">Resueltas</div><div class="stat-value">' + nRes + '</div></div>' +
      '<div class="stat"><div class="stat-label">% Resueltas</div><div class="stat-value">' + (total ? Math.round(nRes / total * 100) : 0) + '%</div></div>' +
    '</div>';

  if (total === 0) {
    html += '<div class="empty">No hay entradas para los filtros seleccionados</div></div>';
    document.getElementById('report-output').innerHTML = html;
    return;
  }

  html += '<p><strong>Severidad:</strong> Alta ' + nAlta + ' - Media ' + nMed + ' - Baja ' + nBaja + '</p>';

  // Per-project breakdown
  html += '<h2>Desglose por proyecto</h2>';
  state.processes.forEach(function(proc) {
    var pEntries = list.filter(function(e) { return e.procId === proc.id; });
    if (!pEntries.length) return;
    var pAbi = pEntries.filter(function(e) { return e.estado !== 'resuelta'; }).length;
    var pAlta = pEntries.filter(function(e) { return e.sev === 'alta' && e.estado !== 'resuelta'; }).length;
    html += '<div class="fase-item">' +
      (proc.code ? '<strong>' + esc(proc.code) + '</strong> - ' : '') + esc(proc.name) +
      '<br><span style="font-size:11px;color:var(--muted);">' + pEntries.length + ' entradas, ' + pAbi + ' sin resolver' +
      (pAlta ? ', <span style="color:var(--eba-dark);">' + pAlta + ' criticas</span>' : '') + '</span></div>';
  });

  // Chronology
  var byDate = {};
  list.forEach(function(e) { (byDate[e.fecha] = byDate[e.fecha] || []).push(e); });
  var fechas = Object.keys(byDate).sort();
  html += '<h2>Cronologia detallada</h2>';
  fechas.forEach(function(f) {
    html += '<div class="report-section"><h3>' + esc(f) + '</h3>';
    byDate[f].forEach(function(e) {
      var proc = state.processes.find(function(p) { return p.id === e.procId; });
      var projLabel = proc ? (proc.code || proc.name) : '';
      var clone = incAtt ? e : Object.assign({}, e, { attachments: [] });
      html += '<div style="font-size:11px;color:var(--eba);font-weight:500;margin-top:8px;">' + esc(projLabel) + '</div>';
      html += renderEntry(clone, false);
    });
    html += '</div>';
  });

  var pct = total ? Math.round(nRes / total * 100) : 0;
  html += '<h2>Conclusiones</h2><p>Se han registrado ' + total + ' entradas en ' + state.processes.length + ' proyectos: ' +
    nInc + ' incidencias, ' + nObs + ' observaciones y ' + nMej + ' mejoras. El ' + pct + '% estan resueltas.</p></div>';

  document.getElementById('report-output').innerHTML = html;
}

// ==================== DATA MANAGEMENT ==
function exportJSON() {
  var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'eba-incidencias-' + today() + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Copia exportada');
}

function importJSON(ev) {
  var f = ev.target.files[0];
  if (!f) return;
  var r = new FileReader();
  r.onload = function(e) {
    try {
      var data = JSON.parse(e.target.result);
      if (!data.processes || !data.entries) { alert('Formato de archivo no válido: debe contener "processes" y "entries".'); return; }
      if (!confirm('¿Reemplazar todos los datos actuales con esta copia?\nLos datos actuales se perderán.')) return;
      state = data;
      save();
      selectProcess(null);
      renderProcList();
      showToast('Datos importados correctamente');
    } catch (err) { alert('Archivo inválido: ' + err.message); }
  };
  r.readAsText(f);
  ev.target.value = '';
}

function wipeAll() {
  if (!confirm('¿Borrar TODOS los datos?\nEsta acción no se puede deshacer.')) return;
  if (!confirm('Última confirmación: ¿seguro que quieres borrar todo?')) return;
  state = { processes: [], entries: [] };
  currentProc = null;
  save();
  selectProcess(null);
  showToast('Todos los datos eliminados');
}

// ==================== TABS ====================
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(x) {
    x.classList.toggle('active', x.dataset.tab === name);
  });
  ['procesos', 'registro', 'listado', 'informe', 'datos'].forEach(function(id) {
    document.getElementById('tab-' + id).style.display = id === name ? 'block' : 'none';
  });
  if (name === 'listado') { populateProjectFilters(); refreshEntriesList(); }
  if (name === 'informe') populateProjectFilters();
  if (name === 'procesos') renderProcList();
}

// ==================== INIT ====================
document.querySelectorAll('.tab').forEach(function(t) {
  t.onclick = function() { if (!t.disabled) switchTab(t.dataset.tab); };
});

document.getElementById('f-files').addEventListener('change', handleFileSelection);
document.getElementById('f-camera').addEventListener('change', handleFileSelection);

['filt-proc', 'filt-fase', 'filt-tipo', 'filt-estado', 'filt-sev'].forEach(function(id) {
  document.getElementById(id).addEventListener('change', refreshEntriesList);
});
var filterTimer = null;
document.getElementById('filt-text').addEventListener('input', function() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(refreshEntriesList, 250);
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') { closeLightbox(); closeEditEntry(); }
});

document.getElementById('edit-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeEditEntry();
});

load();
