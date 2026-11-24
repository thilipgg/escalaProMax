(function () {
  'use strict';

  // ==========================================
  // 1. CONFIGURAÇÃO DO SUPABASE
  // ==========================================
  var SUPABASE_URL = 'https://ucinnkobjqlhxaobmdbp.supabase.co';
  var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVjaW5ua29ianFsaHhhb2JtZGJwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4MzIzNjQsImV4cCI6MjEwODQwODM2NH0.N0w2ddm7WoUZU6F_dYT46gsIBFCsWC14ZzwTo3eLQmg';

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

  // ==========================================
  // 2. VARIÁVEIS DE ESTADO GLOBAL
  // ==========================================
  let currentUser = null;
  let currentTeam = null;
  let userTeams = [];

  let _syncState = 'idle';
  let _lastSyncTime = null;
  let pendingSave = false;
  let _saving = false;
  let saveTimer = null;
  let realtimeChannel = null;
  let state = {};

  const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const REST_11H = 660;

  // ==========================================
  // 3. LÓGICA DE ESTADO E PERSISTÊNCIA
  // ==========================================
  function getDefaultState() {
    return {
      teamName: currentTeam ? currentTeam.name : 'Nova Equipe',
      employees: ['Filipe', 'Lucas', 'Nathan', 'Valtecir'],
      shifts: {
        '06:00': { type: 'work', label: '06', name: '06:00 – 14:20', start: '06:00', end: '14:20', color: '#f1f5f9', text: '#0f172a' },
        '07:00': { type: 'work', label: '07', name: '07:00 – 15:20', start: '07:00', end: '15:20', color: '#f1f5f9', text: '#0f172a' },
        '09:00': { type: 'work', label: '09', name: '09:00 – 17:20', start: '09:00', end: '17:20', color: '#f1f5f9', text: '#0f172a' },
        '10:00': { type: 'work', label: '10', name: '10:00 – 18:20', start: '10:00', end: '18:20', color: '#f1f5f9', text: '#0f172a' },
        '14:00': { type: 'work', label: '14', name: '14:00 – 22:20', start: '14:00', end: '22:20', color: '#f1f5f9', text: '#0f172a' },
        '16:00': { type: 'work', label: '16', name: '16:00 – 00:04', start: '16:00', end: '00:04', color: '#f1f5f9', text: '#0f172a' },
        '18:00': { type: 'work', label: '18', name: '18:00 – 02:20', start: '18:00', end: '02:20', color: '#f1f5f9', text: '#0f172a' },
        '22:00': { type: 'work', label: '22', name: '22:00 – 05:26', start: '22:00', end: '05:26', color: '#f1f5f9', text: '#0f172a' },
        'D': { type: 'event', label: 'D', name: 'Descanso Semanal', color: '#fef08a', text: '#854d0e' },
        'F6': { type: 'event', label: 'F6', name: 'Folga Compensatória', color: '#4ade80', text: '#166534' },
        'F': { type: 'event', label: 'F', name: 'Férias', color: '#fca5a5', text: '#991b1b' },
        'x': { type: 'event', label: '×', name: 'Afastamento', color: '#fdba74', text: '#7c2d12' },
        'FE': { type: 'event', label: 'FE', name: 'Folga de Feriado', color: '#3b82f6', text: '#ffffff' }
      },
      defaultShift: { 'Filipe': '06:00', 'Lucas': '10:00', 'Nathan': '14:00', 'Valtecir': '06:00' },
      employeeScale: { 'Filipe': '6x1', 'Lucas': '6x1', 'Nathan': '6x1', 'Valtecir': '6x1' },
      schedule: {},
      holidays: {},
      colors: { SUNDAY: { color: '#ef4444', text: '#ffffff' } },
      sundayRule: { maxWorkers: 2, maxConsecutive: 2 },
      limits: { maxConsecutiveDays: 6 },
      notes: {}
    };
  }

  function migrateState(raw) {
    var defaults = getDefaultState();
    var s = Object.assign({}, defaults, raw || {});
    if (!s.employees) s.employees = defaults.employees;
    if (!s.shifts) s.shifts = defaults.shifts;
    if (!s.colors) s.colors = {};
    if (!s.colors.SUNDAY) s.colors.SUNDAY = { color: '#ef4444', text: '#ffffff' };
    if (!s.defaultShift) s.defaultShift = {};
    if (!s.employeeScale) s.employeeScale = {};
    if (!s.sundayRule) s.sundayRule = { maxWorkers: 2, maxConsecutive: 2 };
    if (!s.limits) s.limits = { maxConsecutiveDays: 6 };
    if (!s.notes || typeof s.notes !== 'object') s.notes = {};
    Object.keys(s.shifts).forEach(function (k) {
      var sh = s.shifts[k];
      if (sh && sh.type === 'event' && sh.color) {
        var expected = getContrastColor(sh.color);
        if (!sh.text || getContrastColor(sh.text) === expected) sh.text = expected;
      }
    });
    return s;
  }

  async function loadState() {
    if (!currentTeam) return;
    _syncState = 'saving'; updateStorageStatus();
    try {
      const { data, error } = await sb.from('escala').select('data').eq('team_id', currentTeam.id).maybeSingle();
      if (error) throw error;
      if (data && data.data && Object.keys(data.data).length > 0) {
        state = migrateState(data.data);
      } else {
        state = getDefaultState();
        await doSave();
      }
      if (currentTeam.name && state.teamName !== currentTeam.name) {
        state.teamName = currentTeam.name;
      }
      if (syncAllAutoFENotes()) save();
      _syncState = 'synced';
      _lastSyncTime = new Date();
    } catch (e) {
      console.error(e);
      _syncState = 'error';
      toast('Erro ao carregar escala da nuvem.');
      state = getDefaultState();
    }
    updateStorageStatus();
  }

  function save() {
    if (!currentTeam) return;
    pendingSave = true;
    _syncState = 'pending';
    updateStorageStatus();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 600);
  }

  async function doSave() {
    if (!pendingSave || _saving || !currentTeam) return;
    pendingSave = false;
    _saving = true;
    _syncState = 'saving';
    updateStorageStatus();
    try {
      const { error } = await sb.from('escala').upsert({
        team_id: currentTeam.id,
        data: state,
        updated_at: new Date().toISOString()
      });
      if (error) throw error;
      _lastSyncTime = new Date();
      _syncState = 'synced';
    } catch (e) {
      console.error('Erro ao salvar:', e);
      _syncState = 'error';
      pendingSave = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(doSave, 5000);
    } finally {
      _saving = false;
      updateStorageStatus();
    }
  }

  function updateStorageStatus(mode) {
    if (mode) _syncState = mode;
    var els = document.querySelectorAll('[data-sync-pill]');
    if (!els.length) return;
    var now = _lastSyncTime || new Date();
    var timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    var txt = '—', cls = '';
    if (_syncState === 'pending') { txt = '⟳ Pendente'; cls = 'pending'; }
    else if (_syncState === 'saving') { txt = '⟳ Sincronizando...'; cls = 'saving'; }
    else if (_syncState === 'synced') { txt = '✓ Nuvem · ' + timeStr; cls = 'synced'; }
    else if (_syncState === 'error') { txt = '✗ Erro de sincronização'; cls = 'error'; }
    els.forEach(function (el) {
      el.textContent = txt;
      el.className = 'sync-pill' + (cls ? ' ' + cls : '');
    });
  }

  function initialsOf(str) {
    var parts = String(str || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // ==========================================
  // 4. AUTENTICAÇÃO E TIMES
  // ==========================================
  function updateHeaderUI() {
    const isApp = (currentUser && currentTeam);
    document.querySelector('.period-row').style.display = isApp ? 'flex' : 'none';
    document.querySelector('.tabs').style.display = isApp ? 'flex' : 'none';
    document.getElementById('printBtn').style.display = isApp ? 'grid' : 'none';
    document.getElementById('pngBtn').style.display = isApp ? 'grid' : 'none';
    if (currentTeam) {
      document.getElementById('teamNameDisplay').textContent = currentTeam.name;
      document.title = currentTeam.name + ' · Escala';
    } else {
      document.getElementById('teamNameDisplay').textContent = 'Gerenciador de Escalas';
      document.title = 'Gerenciador de Escalas';
    }
  }

  function renderAuthScreen() {
    activeView = 'week';
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'week'));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-week'));
    document.getElementById('view-week').innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <h2 class="auth-title">Acessar Sistema</h2>
        <div class="auth-field">
          <label for="authEmail">E-mail</label>
          <input type="email" id="authEmail" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false">
        </div>
        <div class="auth-field" id="nameField" style="display:none;">
          <label for="authName">Nome do Líder</label>
          <input type="text" id="authName" autocomplete="name">
        </div>
        <div class="auth-field">
          <label for="authPass">Senha</label>
          <input type="password" id="authPass" autocomplete="current-password">
        </div>
        <button type="button" id="btnLogin" class="btn-auto">Entrar</button>
        <button type="button" id="btnSignUp" class="add-btn">Criar nova conta</button>
        <div id="authError" class="auth-error"></div>
      </div>
    </div>`;

    let isRegistering = false;
    const nameField = document.getElementById('nameField');
    const btnLogin = document.getElementById('btnLogin');
    const btnSignUp = document.getElementById('btnSignUp');
    const errorDiv = document.getElementById('authError');
    const emailInp = document.getElementById('authEmail');
    const passInp = document.getElementById('authPass');
    const nameInp = document.getElementById('authName');

    btnSignUp.addEventListener('click', (e) => {
      e.preventDefault();
      isRegistering = !isRegistering;
      nameField.style.display = isRegistering ? 'block' : 'none';
      btnLogin.textContent = isRegistering ? 'Cadastrar' : 'Entrar';
      btnSignUp.textContent = isRegistering ? 'Já tenho conta' : 'Criar nova conta';
      errorDiv.textContent = '';
      errorDiv.style.color = 'var(--danger)';
      if (isRegistering) nameInp.focus();
    });

    btnLogin.addEventListener('click', async (e) => {
      e.preventDefault();
      const email = emailInp.value.trim();
      const pass = passInp.value;
      const name = nameInp.value.trim();
      if (!email || !pass) { errorDiv.style.color = 'var(--danger)'; errorDiv.textContent = 'Preencha e-mail e senha.'; return; }
      if (isRegistering && !name) { errorDiv.style.color = 'var(--danger)'; errorDiv.textContent = 'Preencha seu nome.'; return; }
      btnLogin.textContent = 'Aguarde...';
      btnLogin.disabled = true;
      errorDiv.textContent = '';
      try {
        if (isRegistering) {
          const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { full_name: name } } });
          if (error) throw error;
          if (data.session === null) {
            errorDiv.style.color = '#16a34a';
            errorDiv.textContent = 'Conta criada! Verifique seu e-mail para confirmar antes de entrar.';
            isRegistering = false;
            nameField.style.display = 'none';
            btnSignUp.textContent = 'Criar nova conta';
            btnLogin.textContent = 'Entrar';
            return;
          }
          toast('Conta criada com sucesso!');
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password: pass });
          if (error) throw error;
        }
      } catch (err) {
        console.error('[Auth] Erro:', err);
        errorDiv.style.color = 'var(--danger)';
        errorDiv.textContent = err.message || 'Erro inesperado. Tente novamente.';
      } finally {
        btnLogin.textContent = isRegistering ? 'Cadastrar' : 'Entrar';
        btnLogin.disabled = false;
      }
    });
  }

  async function fetchUserTeams() {
    const { data, error } = await sb.from('team_members').select('team_id, teams(id, name)').eq('user_id', currentUser.id);
    if (error) { console.error(error); return []; }
    return data.map(d => d.teams);
  }

  function renderTeamSelection() {
    activeView = 'week';
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'week'));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-week'));

    let html = `<div style="max-width:600px;margin:40px auto;padding:20px;">
      <h2 style="text-align:center;margin-bottom:20px;">Selecione seu Time</h2>
      <div style="display:grid;gap:10px;margin-bottom:30px;">`;
    if (userTeams.length === 0) {
      html += `<p style="text-align:center;color:#64748b;">Você ainda não participa de nenhum time.</p>`;
    } else {
      userTeams.forEach(t => {
        html += `<button class="add-btn team-btn" data-id="${t.id}" data-name="${t.name}" style="justify-content:space-between;padding:15px;">
          <span style="font-size:16px;font-weight:600;">${t.name}</span>
          <span style="color:var(--primary);">Entrar →</span>
        </button>`;
      });
    }
    html += `</div>
      <div style="border-top:1px solid var(--border);padding-top:20px;text-align:center;">
        <h3>Criar novo time</h3>
        <div style="display:flex;gap:10px;margin-top:10px;">
          <input type="text" id="newTeamName" placeholder="Nome do setor" style="flex:1;padding:10px;border:1px solid #cbd5e1;border-radius:8px;">
          <button id="btnCreateTeam" class="btn-auto" style="width:auto;padding:0 20px;height:auto;">Criar</button>
        </div>
      </div>
      <div style="text-align:center;margin-top:30px;">
        <button id="btnLogout" style="color:var(--danger);font-size:12px;">Sair da conta</button>
      </div>
    </div>`;
    document.getElementById('view-week').innerHTML = html;

    document.querySelectorAll('.team-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        currentTeam = { id: e.currentTarget.dataset.id, name: e.currentTarget.dataset.name };
        await startApp();
      });
    });

    document.getElementById('btnCreateTeam').addEventListener('click', async () => {
      const name = document.getElementById('newTeamName').value.trim();
      if (!name) return;
      const btn = document.getElementById('btnCreateTeam');
      const originalText = btn.textContent;
      btn.textContent = 'Criando...';
      btn.disabled = true;
      try {
        const { data: team, error: err1 } = await sb.from('teams').insert({ name, created_by: currentUser.id }).select().single();
        if (err1) throw err1;
        const { error: err2 } = await sb.from('team_members').insert({ team_id: team.id, user_id: currentUser.id, role: 'admin' });
        if (err2) throw err2;
        await sb.from('escala').insert({ team_id: team.id, data: getDefaultState() });
        currentTeam = team;
        await startApp();
      } catch (e) {
        console.error('[Team Creation] Erro:', e);
        alert('Erro ao criar time: ' + e.message);
        btn.textContent = originalText;
        btn.disabled = false;
      }
    });

    document.getElementById('btnLogout').addEventListener('click', () => sb.auth.signOut());
  }

  function setupRealtime() {
    if (realtimeChannel) sb.removeChannel(realtimeChannel);
    if (!currentTeam) return;
    realtimeChannel = sb.channel('escala-' + currentTeam.id)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'escala', filter: 'team_id=eq.' + currentTeam.id },
        payload => {
          if (!pendingSave && !_saving && payload.new.data) {
            state = migrateState(payload.new.data);
            renderActive();
            _syncState = 'synced';
            _lastSyncTime = new Date();
            updateStorageStatus();
            toast('✓ Sincronizado de outro dispositivo');
          }
        }
      ).subscribe();
  }

  async function startApp() {
    updateHeaderUI();
    await loadState();
    switchToView('week');
    setupRealtime();
  }

  async function initApp() {
    sb.auth.onAuthStateChange(async (event, session) => {
      if (session) {
        currentUser = session.user;
        userTeams = await fetchUserTeams();
        if (userTeams.length === 1 && !currentTeam) {
          currentTeam = userTeams[0];
          await startApp();
        } else if (!currentTeam) {
          updateHeaderUI();
          renderTeamSelection();
        }
      } else {
        currentUser = null;
        currentTeam = null;
        updateHeaderUI();
        renderAuthScreen();
      }
    });
  }

  // ==========================================
  // 6. LÓGICA DO APP
  // ==========================================
  var currentDate = new Date();
  var activeView = 'week';

  var $ = function (id) { return document.getElementById(id); };
  var periodTitle = $('periodTitle'), tabsEl = $('tabs');
  var viewWeek = $('view-week'), viewMonth = $('view-month'), viewSummary = $('view-summary'), viewSettings = $('view-settings'), viewNotes = $('view-notes');
  var sheet = $('sheet'), sheetBackdrop = $('sheetBackdrop'), sheetTitle = $('sheetTitle'), sheetSub = $('sheetSub');
  var workShiftGrid = $('workShiftGrid'), eventShiftGrid = $('eventShiftGrid'), sheetClear = $('sheetClear');
  var workSectionTitle = $('workSectionTitle'), eventSectionTitle = $('eventSectionTitle');
  var toastEl = $('toast');
  var toastTimer;

  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]);
    });
  }

  var dialogCallback = null, dialogCancelCb = null, dialogExtraCb = null;
  function showDialog(opt) {
    $('dialogTitle').textContent = opt.title;
    $('dialogBody').innerHTML = opt.body;
    var btn = $('dialogConfirm');
    btn.textContent = opt.confirmText || 'Confirmar';
    btn.className = 'dialog-confirm' + (opt.isDanger === false ? ' primary' : '');
    $('dialogCancel').textContent = opt.cancelText || 'Cancelar';
    var extraBtn = $('dialogExtra');
    if (extraBtn) {
      if (opt.extraText) {
        extraBtn.textContent = opt.extraText;
        extraBtn.classList.remove('hidden');
      } else {
        extraBtn.textContent = '';
        extraBtn.classList.add('hidden');
      }
    }
    dialogCallback = opt.onConfirm || null;
    dialogCancelCb = opt.onCancel || null;
    dialogExtraCb = opt.onExtra || null;
    $('dialogBackdrop').classList.add('open');
    if (typeof opt.onOpen === 'function') opt.onOpen();
  }
  $('dialogConfirm').addEventListener('click', function () {
    var cb = dialogCallback;
    var result = cb ? cb() : undefined;
    if (result === false) return;
    $('dialogBackdrop').classList.remove('open');
    dialogCallback = null; dialogCancelCb = null; dialogExtraCb = null;
  });
  $('dialogExtra').addEventListener('click', function () {
    var cb = dialogExtraCb;
    var result = cb ? cb() : undefined;
    if (result === false) return;
    $('dialogBackdrop').classList.remove('open');
    dialogCallback = null; dialogCancelCb = null; dialogExtraCb = null;
  });
  $('dialogCancel').addEventListener('click', function () {
    $('dialogBackdrop').classList.remove('open');
    var cb = dialogCancelCb; dialogCallback = null; dialogCancelCb = null; dialogExtraCb = null;
    if (cb) cb();
  });

  // Clicar fora do diálogo (ou Esc) = Cancelar. O clique só conta se começou e terminou no fundo,
  // para não fechar ao arrastar uma seleção de texto de dentro do diálogo para fora.
  var _dlgDownOnBackdrop = false;
  $('dialogBackdrop').addEventListener('pointerdown', function (e) { _dlgDownOnBackdrop = (e.target === this); });
  $('dialogBackdrop').addEventListener('click', function (e) {
    if (e.target === this && _dlgDownOnBackdrop) $('dialogCancel').click();
    _dlgDownOnBackdrop = false;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if ($('dialogBackdrop').classList.contains('open')) { $('dialogCancel').click(); return; }
    if (sheet.classList.contains('open')) { closeSheet(); return; }
    if ($('notesDrawer') && $('notesDrawer').classList.contains('open')) closeNotesDrawer();
  });

  function pad(n) { return String(n).padStart(2, '0'); }
  function dateKey(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }
  function keyOf(d) { return dateKey(d.getFullYear(), d.getMonth(), d.getDate()); }
  function daysInMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }
  function isHoliday(k) { return !!state.holidays[k]; }

  function getWeekStart(d) {
    var c = new Date(d);
    var day = c.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    c.setDate(c.getDate() + diff);
    c.setHours(0, 0, 0, 0);
    return c;
  }

  function fmtLong(d) { return DOW[d.getDay()] + ', ' + d.getDate() + ' de ' + MONTHS[d.getMonth()]; }
  function fmtMin(m) { return pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60); }
  function parseTime(t) { if (!t) return 0; var p = String(t).split(':'); return parseInt(p[0], 10) * 60 + (parseInt(p[1], 10) || 0); }
  function getContrastColor(hex) {
    if (!hex || hex.length < 6) return '#0f172a';
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    var r = parseInt(hex.substr(0, 2), 16), g = parseInt(hex.substr(2, 2), 16), b = parseInt(hex.substr(4, 2), 16);
    var yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 140 ? '#0f172a' : '#ffffff';
  }
  function getShift(id) { return state.shifts[id] || null; }
  function isWorkShift(id) { var s = getShift(id); return s && s.type === 'work'; }
  function shiftStartMin(id) { var s = getShift(id); return s && s.type === 'work' ? parseTime(s.start) : null; }
  function shiftEndMin(id) { var s = getShift(id); if (!s || s.type !== 'work') return null; var st = parseTime(s.start), en = parseTime(s.end); if (en < st) en += 1440; return en; }
  function shiftNextMin(id) { var en = shiftEndMin(id); if (en === null) return null; return Math.max(0, en + REST_11H - 1440); }
  function isValidTransition(prev, next) { if (!isWorkShift(prev) || !isWorkShift(next)) return true; return (1440 + shiftStartMin(next)) - shiftEndMin(prev) >= REST_11H; }

  function getEmployeeScale(emp) {
    return state.employeeScale && state.employeeScale[emp] ? state.employeeScale[emp] : '6x1';
  }
  function requiredFolgas(scale) {
    if (scale === '6x1') return 1;
    if (scale === '5x2') return 2;
    return 0;
  }
  function getWeekFolgas(emp, weekStart) {
    var folgas = 0, work = 0, planned = false, empty = 0;
    for (var i = 0; i < 7; i++) {
      var d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      var code = (state.schedule[keyOf(d)] || {})[emp];
      if (!code) { empty++; continue; }
      planned = true;
      if (isWorkShift(code)) work++;
      else folgas++;
    }
    return { folgas: folgas, work: work, planned: planned, empty: empty };
  }

  function getConsecutiveSundays(emp, date) {
    var count = 0;
    var d = new Date(date + 'T00:00:00');
    if (d.getDay() !== 0) return 0;
    var checkDate = new Date(d);
    while (true) {
      var prev = new Date(checkDate); prev.setDate(prev.getDate() - 7);
      if (isWorkShift((state.schedule[keyOf(prev)] || {})[emp])) checkDate = prev;
      else break;
    }
    while (true) {
      if (isWorkShift((state.schedule[keyOf(checkDate)] || {})[emp])) {
        count++;
        checkDate.setDate(checkDate.getDate() + 7);
      } else break;
    }
    return count;
  }

  var HOLIDAY_MAX_DAYS = 60, HOLIDAY_WARN_DAYS = 15;
  function parseKeyUTC(k) { var p = k.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function addDaysKey(k, days) {
    var dt = new Date(parseKeyUTC(k) + days * 86400000);
    return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
  }
  function diffDays(kFrom, kTo) {
    return Math.round((parseKeyUTC(kTo) - parseKeyUTC(kFrom)) / 86400000);
  }
  function fmtFullDate(k) { var p = k.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }

  function isClosedStoreEvent(code) {
    var s = getShift(code);
    if (!s || s.type !== 'event') return false;
    return !!s.closedStore || /loja\s*fechad|fechad|sem\s*expediente/i.test(s.name || '');
  }
  function dayIsStoreClosed(key) {
    var d = state.schedule[key];
    if (!d) return false;
    return state.employees.some(function (emp) { return isClosedStoreEvent(d[emp]); });
  }

  function computeEmpHolidayCredits(emp, opts) {
    opts = opts || {};
    var todayKey = opts.todayKey || keyOf(new Date());
    var credits = [];
    Object.keys(state.holidays || {}).sort().forEach(function (hDate) {
      if (opts.excludeDate === hDate) return;
      var code = (state.schedule[hDate] || {})[emp];
      if (isWorkShift(code)) {
        credits.push({
          emp: emp,
          holDate: hDate,
          holName: state.holidays[hDate] || 'Feriado',
          limitDate: addDaysKey(hDate, HOLIDAY_MAX_DAYS),
          usedBy: '',
          lateUsed: false,
          daysLeft: 0,
          status: 'ok'
        });
      }
    });

    var usages = [];
    Object.keys(state.schedule || {}).sort().forEach(function (uDate) {
      if (opts.excludeDate === uDate || isHoliday(uDate)) return;
      if ((state.schedule[uDate] || {})[emp] === 'FE') usages.push(uDate);
    });

    var pairMap = {}, orphanMap = {};
    usages.forEach(function (uDate) {
      var match = null;
      for (var i = 0; i < credits.length; i++) {
        if (!credits[i].usedBy && credits[i].holDate <= uDate) { match = credits[i]; break; }
      }
      if (match) {
        match.usedBy = uDate;
        match.lateUsed = (uDate > match.limitDate);
        match.status = match.lateUsed ? 'used_late' : 'used';
        pairMap[uDate] = match;
      } else {
        orphanMap[uDate] = true;
      }
    });

    credits.forEach(function (c) {
      if (c.usedBy) return;
      c.daysLeft = diffDays(todayKey, c.limitDate);
      c.status = c.daysLeft < 0 ? 'expired' : (c.daysLeft <= HOLIDAY_WARN_DAYS ? 'soon' : 'ok');
    });

    return {
      credits: credits,
      pairMap: pairMap,
      orphanMap: orphanMap,
      pending: credits.filter(function (c) { return !c.usedBy; })
    };
  }

  function purgeAutoFENotes() {
    if (!state.notes) return false;
    var changed = false;
    Object.keys(state.notes).forEach(function (date) {
      var arr = state.notes[date] || [];
      var kept = arr.filter(function (n) { return !n.autoFE; });
      if (kept.length !== arr.length) {
        changed = true;
        if (kept.length) state.notes[date] = kept;
        else delete state.notes[date];
      }
    });
    return changed;
  }

  function syncAutoFENotes() { return purgeAutoFENotes(); }
  function syncAllAutoFENotes() { return purgeAutoFENotes(); }

  function getFERefInfo(emp, dateStr) {
    if (!emp || !dateStr || isHoliday(dateStr)) return null;
    if (((state.schedule || {})[dateStr] || {})[emp] !== 'FE') return null;
    var info = computeEmpHolidayCredits(emp);
    var c = info.pairMap[dateStr];
    if (c) {
      return {
        status: c.lateUsed ? 'late' : 'ok',
        holDate: c.holDate,
        holName: c.holName,
        limitDate: c.limitDate,
        holLabel: c.holName + ' (' + fmtShort(c.holDate) + ')',
        badge: c.lateUsed ? 'Passou de 60d' : 'Dentro dos 60d ✓',
        sub: c.lateUsed ? ('Limite era ' + fmtShort(c.limitDate) + ' · fora do prazo') : ('Prazo máximo até ' + fmtShort(c.limitDate))
      };
    }
    return {
      status: 'empty',
      holDate: '',
      holName: '',
      limitDate: '',
      holLabel: 'Sem feriado pendente',
      badge: 'Sem crédito',
      sub: 'Nenhum feriado trabalhado disponível'
    };
  }

  function getHolidayBalances(limitDate, excludeDate, excludeEmp) {
    var b = {};
    state.employees.forEach(function (e) { b[e] = 0; });
    for (var date in state.schedule) {
      if (!state.schedule.hasOwnProperty(date)) continue;
      if (limitDate && date > limitDate) continue;
      var daySch = state.schedule[date];
      var hol = isHoliday(date);
      state.employees.forEach(function (emp) {
        if (date === excludeDate && emp === excludeEmp) return;
        var code = daySch[emp];
        if (!code) return;
        if (hol) { if (isWorkShift(code)) b[emp] += 1; }
        else { if (code === 'FE') b[emp] -= 1; }
      });
    }
    return b;
  }

  function isShiftInUse(id) {
    for (var date in state.schedule) {
      for (var emp in state.schedule[date]) {
        if (state.schedule[date][emp] === id) return true;
      }
    }
    return false;
  }

  // ==========================================
  // MOTOR DE ALERTAS (erro / aviso / info)
  // ==========================================
  var TYPE_LABEL = {
    rest: 'Descanso 11h', run: 'Dias seguidos', sunday: 'Domingo', sundayc: 'Domingos seguidos',
    essential: 'Turno essencial', week: 'Folgas', balance: 'Saldo feriado',
    fe_exp: 'Prazo FE 60d', fe_soon: 'Prazo FE', empty: 'Vazio'
  };
  var SEV_ORDER = { error: 0, warn: 1, info: 2 };

  function dayPlanned(key) {
    var d = state.schedule[key];
    return !!d && Object.keys(d).length > 0;
  }
  function fmtShort(key) { var p = key.split('-'); return p[2] + '/' + p[1]; }
  function getMaxRun() {
    var v = state.limits && state.limits.maxConsecutiveDays;
    return v === 0 ? 0 : (v || 6);
  }

  // Sequência de dias de trabalho seguidos que contém "date": posição do dia na sequência e tamanho total
  function workRun(emp, date) {
    var d = new Date(date + 'T00:00:00'), back = 0, fwd = 0, c = new Date(d);
    while (back < 60) {
      c.setDate(c.getDate() - 1);
      if (isWorkShift((state.schedule[keyOf(c)] || {})[emp])) back++; else break;
    }
    c = new Date(d);
    while (fwd < 60) {
      c.setDate(c.getDate() + 1);
      if (isWorkShift((state.schedule[keyOf(c)] || {})[emp])) fwd++; else break;
    }
    return { pos: back + 1, total: back + fwd + 1 };
  }
  function sundayRunPos(emp, date) {
    var n = 0, d = new Date(date + 'T00:00:00');
    while (n < 60 && isWorkShift((state.schedule[keyOf(d)] || {})[emp])) { n++; d.setDate(d.getDate() - 7); }
    return n;
  }

  function restIssue(emp, k1, c1, k2, c2) {
    return {
      sev: 'error', type: 'rest', id: 'rest|' + emp + '|' + k1, date: k2,
      msg: 'Descanso de 11h não respeitado: ' + c1 + ' (' + fmtShort(k1) + ', termina ' + getShift(c1).end + ') → ' +
        c2 + ' (' + fmtShort(k2) + '). O próximo turno só pode começar a partir de ' + fmtMin(shiftNextMin(c1)) + '.'
    };
  }

  // Problemas de UMA célula (colaborador + dia + turno)
  function getCellIssues(emp, date, code) {
    var out = [];
    if (!code) return out;
    if (code === 'FE' && !isHoliday(date)) {
      var saved = (state.schedule[date] || {})[emp] === 'FE';
      if (saved) {
        var info = computeEmpHolidayCredits(emp);
        if (info.orphanMap[date]) {
          out.push({ sev: 'warn', type: 'balance', msg: 'Sem feriado trabalhado pendente até esta data. Folga lançada sem saldo.' });
        } else if (info.pairMap[date] && info.pairMap[date].lateUsed) {
          var c = info.pairMap[date];
          out.push({ sev: 'error', type: 'fe_exp', msg: 'Fora do prazo de 60 dias: o feriado ' + fmtShort(c.holDate) + ' (' + c.holName + ') venceu em ' + fmtShort(c.limitDate) + '.' });
        }
      } else {
        var sim = computeEmpHolidayCredits(emp, { excludeDate: date });
        var elig = sim.pending.filter(function (c) { return c.holDate <= date; });
        if (!elig.length) {
          out.push({ sev: 'warn', type: 'balance', msg: 'Saldo de folgas de feriado até esta data é 0. A folga está sendo usada sem saldo.' });
        } else if (date > elig[0].limitDate) {
          var c0 = elig[0];
          out.push({ sev: 'error', type: 'fe_exp', msg: 'Fora do prazo de 60 dias: o feriado pendente mais antigo (' + fmtShort(c0.holDate) + ' — ' + c0.holName + ') venceu em ' + fmtShort(c0.limitDate) + '.' });
        }
      }
      return out;
    }
    if (!isWorkShift(code)) return out;
    var d = new Date(date + 'T00:00:00');
    var prev = new Date(d); prev.setDate(prev.getDate() - 1);
    var next = new Date(d); next.setDate(next.getDate() + 1);
    var prevKey = keyOf(prev), nextKey = keyOf(next);
    var prevCode = (state.schedule[prevKey] || {})[emp];
    var nextCode = (state.schedule[nextKey] || {})[emp];
    if (isWorkShift(prevCode) && !isValidTransition(prevCode, code)) out.push(restIssue(emp, prevKey, prevCode, date, code));
    if (isWorkShift(nextCode) && !isValidTransition(code, nextCode)) out.push(restIssue(emp, date, code, nextKey, nextCode));
    if (d.getDay() === 0) {
      var maxW = state.sundayRule.maxWorkers || 2;
      var others = state.employees.filter(function (e) { return e !== emp && isWorkShift((state.schedule[date] || {})[e]); });
      if (others.length >= maxW) out.push({ sev: 'error', type: 'sunday', msg: 'Domingo já tem ' + maxW + ' colaboradores trabalhando. O limite é ' + maxW + '.' });
      var cons = getConsecutiveSundays(emp, date);
      var maxC = state.sundayRule.maxConsecutive || 2;
      if (cons > maxC) out.push({ sev: 'warn', type: 'sundayc', msg: emp + ' trabalha ' + cons + ' domingos consecutivos. O limite configurado é ' + maxC + '.' });
    }
    var maxRun = getMaxRun();
    if (maxRun > 0) {
      var r = workRun(emp, date);
      if (r.total > maxRun) out.push({ sev: 'error', type: 'run', msg: emp + ' tem ' + r.total + ' dias seguidos de trabalho (limite ' + maxRun + '). É preciso uma folga.' });
    }
    return out;
  }

  function getWarningsForCell(emp, date, code) {
    return getCellIssues(emp, date, code).map(function (i) { return i.msg; });
  }

  // Classe visual + dica de uma célula
  function cellFlag(emp, key, code) {
    if (!code) {
      if (dayPlanned(key) && new Date(key + 'T00:00:00').getDay() !== 0) return { cls: 'has-info', title: 'Sem lançamento neste dia' };
      return { cls: '', title: '' };
    }
    var items = getCellIssues(emp, key, code);
    if (!items.length) return { cls: '', title: '' };
    var hasErr = items.some(function (i) { return i.sev === 'error'; });
    var hasWarn = items.some(function (i) { return i.sev === 'warn'; });
    return {
      cls: hasErr ? 'has-error' : (hasWarn ? 'has-warning' : 'has-info'),
      title: items.map(function (i) { return i.msg; }).join(' • ')
    };
  }
  function cellTitle(emp, key, flagTitle) {
    var t = [];
    if (flagTitle) t.push('⚠ ' + flagTitle);
    cellNotes(emp, key).forEach(function (n) { t.push('📝 ' + n.text); });
    return escapeHtml(t.join('\n'));
  }

  // Todos os problemas de um intervalo de datas
  function computeIssues(startStr, endStr) {
    var issues = [], seen = {};
    var d1 = new Date(startStr + 'T00:00:00'), d2 = new Date(endStr + 'T00:00:00');
    var maxC = state.sundayRule.maxConsecutive || 2;
    var maxW = state.sundayRule.maxWorkers || 2;
    var maxRun = getMaxRun();

    function add(i) {
      var k = i.id || [i.type, i.emp || '', i.date || '', i.msg].join('|');
      if (seen[k]) return;
      seen[k] = 1; issues.push(i);
    }
    function dayBefore(key, n) { var x = new Date(key + 'T00:00:00'); x.setDate(x.getDate() - n); return keyOf(x); }
    // emite uma vez por sequência (no 1º dia que passa do limite); se a sequência começou antes do período, emite no 1º dia do período
    function emitOnce(pos, limit, prevKey) { return pos === limit + 1 || (pos > limit + 1 && prevKey < startStr); }

    for (var cur = new Date(d1); cur <= d2; cur.setDate(cur.getDate() + 1)) {
      var key = keyOf(cur), dow = cur.getDay();
      var planned = dayPlanned(key);
      if (planned) {
        var miss = checkEssentialShifts(key);
        if (miss.missing06) add({ sev: 'error', type: 'essential', date: key, msg: 'Ninguém escalado no turno essencial das 06:00.' });
        if (miss.missing14) add({ sev: 'error', type: 'essential', date: key, msg: 'Ninguém escalado no turno essencial das 14:00.' });
        if (dow === 0) {
          var cw = countSundayWorkers(key);
          if (cw > maxW) add({ sev: 'error', type: 'sunday', date: key, msg: 'Domingo com ' + cw + ' colaboradores trabalhando (limite ' + maxW + ').' });
        }
      }
      state.employees.forEach(function (emp) {
        var code = (state.schedule[key] || {})[emp];
        if (!code) {
          if (planned && dow !== 0 && !dayIsStoreClosed(key)) add({ sev: 'info', type: 'empty', emp: emp, date: key, msg: 'Sem lançamento neste dia.' });
          return;
        }
        getCellIssues(emp, key, code).forEach(function (i) {
          if (i.type === 'sunday') return; // tratado no nível do dia
          if (i.type === 'sundayc' && !emitOnce(sundayRunPos(emp, key), maxC, dayBefore(key, 7))) return;
          if (i.type === 'run' && !emitOnce(workRun(emp, key).pos, maxRun, dayBefore(key, 1))) return;
          add(Object.assign({ emp: emp, date: key }, i));
        });
      });
    }

    var todayKeyFE = keyOf(new Date());
    state.employees.forEach(function (emp) {
      var feInfo = computeEmpHolidayCredits(emp, { todayKey: todayKeyFE });
      feInfo.pending.forEach(function (c) {
        var anchor = (c.limitDate >= startStr && c.limitDate <= endStr) ? c.limitDate : startStr;
        if (c.status === 'expired') {
          add({
            sev: 'error', type: 'fe_exp', id: 'feexp|' + emp + '|' + c.holDate, emp: emp, date: anchor,
            msg: 'Prazo de 60 dias vencido em ' + fmtShort(c.limitDate) + ' — feriado ' + fmtShort(c.holDate) + ' (' + c.holName + ') sem FE agendado.'
          });
        } else if (c.status === 'soon' || (c.limitDate >= startStr && c.limitDate <= endStr)) {
          add({
            sev: 'warn', type: 'fe_soon', id: 'fesoon|' + emp + '|' + c.holDate, emp: emp, date: anchor,
            msg: 'Feriado ' + fmtShort(c.holDate) + ' (' + c.holName + ') vence em ' + fmtShort(c.limitDate) + (c.daysLeft >= 0 ? ' (faltam ' + c.daysLeft + 'd).' : '.')
          });
        }
      });
    });

    function weekCheck(ws) {
      var we = new Date(ws); we.setDate(ws.getDate() + 6);
      state.employees.forEach(function (emp) {
        var scale = getEmployeeScale(emp), req = requiredFolgas(scale);
        if (req === 0) return;
        var info = getWeekFolgas(emp, ws);
        if (!info.planned) return;
        if (info.folgas + info.empty < req) {
          add({
            sev: 'error', type: 'week', emp: emp, date: keyOf(ws),
            msg: 'Semana ' + pad(ws.getDate()) + '/' + pad(ws.getMonth() + 1) + '–' + pad(we.getDate()) + '/' + pad(we.getMonth() + 1) +
              ': ' + info.folgas + ' folga(s), precisa de ' + req + ' (escala ' + scale + ').'
          });
        }
      });
    }
    for (var w = getWeekStart(d1); w <= d2; w.setDate(w.getDate() + 7)) weekCheck(new Date(w));

    issues.sort(function (a, b) {
      return (SEV_ORDER[a.sev] - SEV_ORDER[b.sev]) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.emp || '').localeCompare(b.emp || '');
    });
    return issues;
  }

  function issueItemHTML(i) {
    var act = (i.emp && i.type !== 'week' && i.type !== 'fe_exp' && i.type !== 'fe_soon') ? 'sheet' : 'goto';
    var who = '<strong>' + (i.emp ? escapeHtml(i.emp) : 'Time') + '</strong>';
    var when = i.type === 'week' ? '' : '<span class="issue-when">' + fmtShort(i.date) + ' · ' + DOW[new Date(i.date + 'T00:00:00').getDay()] + '</span>';
    return '<button type="button" class="issue-item ' + i.sev + '" data-act="' + act + '" data-emp="' + escapeHtml(i.emp || '') + '" data-date="' + i.date + '">' +
      '<span class="issue-tag">' + (TYPE_LABEL[i.type] || i.type) + '</span>' +
      '<span class="issue-main"><span class="issue-who">' + who + when + '</span><span class="issue-msg">' + escapeHtml(i.msg) + '</span></span>' +
      '<span class="issue-go">›</span></button>';
  }

  function issuesCardHTML(issues, opts) {
    opts = opts || {};
    var errs = issues.filter(function (i) { return i.sev === 'error'; });
    var warns = issues.filter(function (i) { return i.sev === 'warn'; });
    var infos = issues.filter(function (i) { return i.sev === 'info'; });
    var h = '';
    if (!errs.length && !warns.length) {
      if (opts.planned) {
        h += '<div class="warn-card ok"><h3>✓ ' + (opts.okTitle || 'Tudo em dia') + '</h3><div style="font-size:12.5px;color:#166534;line-height:1.7">' +
          (opts.okText || 'Nenhum problema encontrado nas regras configuradas.') + '</div></div>';
      }
    } else {
      h += '<div class="issues-card"><div class="issues-head"><h3>' + (opts.title || 'Alertas') + '</h3>' +
        (errs.length ? '<span class="sev-pill error">' + errs.length + (errs.length > 1 ? ' erros' : ' erro') + '</span>' : '') +
        (warns.length ? '<span class="sev-pill warn">' + warns.length + (warns.length > 1 ? ' avisos' : ' aviso') + '</span>' : '') + '</div>';
      if (errs.length) h += '<div class="issue-group-title">Precisa corrigir</div><div class="issue-list">' + errs.map(issueItemHTML).join('') + '</div>';
      if (warns.length) h += '<div class="issue-group-title">Atenção</div><div class="issue-list">' + warns.map(issueItemHTML).join('') + '</div>';
      h += '</div>';
    }
    if (infos.length) {
      h += '<details class="issue-info"><summary>Células sem lançamento (' + infos.length + ')</summary><div class="issue-list">' + infos.map(issueItemHTML).join('') + '</div></details>';
    }
    return h;
  }

  function updateBadges() {
    var y = currentDate.getFullYear(), m = currentDate.getMonth();
    var n = daysInMonth(currentDate);
    var issues = computeIssues(dateKey(y, m, 1), dateKey(y, m, n));
    var errs = issues.filter(function (i) { return i.sev === 'error'; }).length;
    var warns = issues.filter(function (i) { return i.sev === 'warn'; }).length;
    var b = $('summaryBadge');
    if (b) {
      if (errs) { b.textContent = errs; b.className = 'tab-badge error'; }
      else if (warns) { b.textContent = warns; b.className = 'tab-badge warn'; }
      else { b.textContent = ''; b.className = 'tab-badge hidden'; }
    }
    var nb = $('notesBadge');
    if (nb) {
      var prefix = y + '-' + pad(m + 1) + '-', cnt = 0;
      Object.keys(state.notes || {}).forEach(function (k) { if (k.indexOf(prefix) === 0) cnt += state.notes[k].length; });
      if (cnt) { nb.textContent = cnt; nb.className = 'tab-badge neutral'; }
      else { nb.textContent = ''; nb.className = 'tab-badge hidden'; }
    }
  }

  // ==========================================
  // ANOTAÇÕES
  // ==========================================
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function authorName() {
    if (!currentUser) return '';
    var meta = currentUser.user_metadata || {};
    return meta.full_name || (currentUser.email || '').split('@')[0];
  }
  function getNotes(date) { return (state.notes && state.notes[date]) || []; }
  function cellNotes(emp, date) { return getNotes(date).filter(function (n) { return n.emp === emp; }); }
  function dayNotes(date) { return getNotes(date).filter(function (n) { return !n.emp; }); }

  function addNote(date, emp, text, important) {
    text = (text || '').trim();
    if (!text || !date) return false;
    if (!state.notes) state.notes = {};
    if (!state.notes[date]) state.notes[date] = [];
    state.notes[date].push({ id: uid(), emp: emp || '', text: text.slice(0, 600), important: !!important, by: authorName(), ts: new Date().toISOString() });
    save();
    return true;
  }
  function updateNote(date, id, patch) {
    var n = getNotes(date).filter(function (x) { return x.id === id; })[0];
    if (!n) return false;
    Object.assign(n, patch);
    save();
    return true;
  }
  function deleteNote(date, id) {
    var arr = getNotes(date).filter(function (x) { return x.id !== id; });
    if (arr.length) state.notes[date] = arr; else if (state.notes) delete state.notes[date];
    save();
  }
  function noteCls(emp, key) {
    var l = cellNotes(emp, key);
    if (!l.length) return '';
    return l.some(function (n) { return n.important; }) ? 'has-note has-note-imp' : 'has-note';
  }
  function dayNoteInfo(key) {
    var l = getNotes(key);
    return {
      total: l.length,
      imp: l.some(function (n) { return n.important; })
    };
  }
  function dayWideNoteInfo(key) {
    var l = getNotes(key).filter(function (n) { return !n.emp; });
    return {
      total: l.length,
      imp: l.some(function (n) { return n.important; })
    };
  }
  function dayHeadNoteCls(key) {
    var info = dayWideNoteInfo(key);
    if (!info.total) return '';
    return info.imp ? 'col-has-note col-has-note-imp' : 'col-has-note';
  }
  function colNoteCls(key) {
    var info = dayWideNoteInfo(key);
    if (!info.total) return '';
    return info.imp ? 'col-note col-note-imp' : 'col-note';
  }
  function dayNoteDotHTML() {
    return '';
  }
  function noteScopeLabel(n) { return n.emp ? '👤 ' + escapeHtml(n.emp) : '👥 Dia inteiro'; }
  function noteTime(n) {
    if (!n.ts) return '';
    try { return new Date(n.ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }

  function periodNotes(startStr, endStr) {
    var rows = [];
    var cur = new Date(startStr + 'T00:00:00');
    var end = new Date(endStr + 'T00:00:00');
    while (cur <= end) {
      var k = keyOf(cur);
      getNotes(k).forEach(function (n) { rows.push({ date: k, n: n }); });
      cur.setDate(cur.getDate() + 1);
    }
    rows.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.n.ts || '') < (b.n.ts || '') ? -1 : 1;
    });
    return rows;
  }

  function gridTopbarHTML(startStr, endStr, opts) {
    opts = opts || {};
    var issues = computeIssues(startStr, endStr);
    var errs = issues.filter(function (i) { return i.sev === 'error'; }).length;
    var warns = issues.filter(function (i) { return i.sev === 'warn'; }).length;
    var infos = issues.filter(function (i) { return i.sev === 'info'; }).length;
    var notes = periodNotes(startStr, endStr);
    var impCount = notes.filter(function (r) { return r.n.important; }).length;

    var statusHtml = '';
    if (errs || warns) {
      var parts = [];
      if (errs) parts.push(errs + (errs > 1 ? ' erros' : ' erro'));
      if (warns) parts.push(warns + (warns > 1 ? ' avisos' : ' aviso'));
      statusHtml = '<button type="button" class="topbar-status ' + (errs ? 'error' : 'warn') + '" data-open-drawer="alerts">⚠ ' + parts.join(' · ') + ' · Ver ›</button>';
    } else if (opts.planned) {
      var okTxt = '✓ ' + (opts.okTitle || 'Em dia') + (infos ? ' · ' + infos + ' vazia' + (infos > 1 ? 's' : '') : '');
      statusHtml = infos
        ? '<button type="button" class="topbar-status ok" data-open-drawer="alerts">' + okTxt + ' ›</button>'
        : '<span class="topbar-status ok">' + okTxt + '</span>';
    } else {
      statusHtml = '<span class="topbar-status idle">Sem lançamentos</span>';
    }

    var notesLabel = notes.length ? (notes.length + (notes.length === 1 ? ' nota' : ' notas')) : 'Anotações';
    var notesBtn = '<button type="button" class="topbar-notes-btn' + (notes.length ? ' has-notes' : '') + '" data-open-drawer="notes">' +
      (impCount ? '<span class="drawer-imp-dot" title="' + impCount + ' prioritária(s)"></span>' : '') +
      '<span>📝 ' + notesLabel + '</span></button>';

    return '<div class="grid-topbar">' + statusHtml + notesBtn + '</div>';
  }

  var drawerState = { open: false, filter: 'all', day: '', editing: null, composing: false };

  function getDrawerRange() {
    if (activeView === 'month') {
      var y = currentDate.getFullYear(), m = currentDate.getMonth(), n = daysInMonth(currentDate);
      return { start: dateKey(y, m, 1), end: dateKey(y, m, n), title: 'Anotações do mês', sub: MONTHS[m] + ' ' + y };
    }
    var ws = getWeekStart(currentDate), we = new Date(ws);
    we.setDate(ws.getDate() + 6);
    var start = keyOf(ws), end = keyOf(we);
    return { start: start, end: end, title: 'Anotações da semana', sub: formatRangeLabel(start, end) };
  }

  function defaultDateInRange(range) {
    var today = keyOf(new Date());
    if (today >= range.start && today <= range.end) return today;
    return range.start;
  }

  function openNotesDrawer(opts) {
    opts = opts || {};
    drawerState.open = true;
    drawerState.filter = opts.filter || 'all';
    if ('day' in opts) drawerState.day = opts.day || '';
    drawerState.editing = null;
    renderNotesDrawer();
    $('notesDrawer').classList.add('open');
    $('notesDrawerBackdrop').classList.add('open');
  }

  function closeNotesDrawer() {
    drawerState.open = false;
    drawerState.editing = null;
    drawerState.composing = false;
    if ($('notesDrawer')) $('notesDrawer').classList.remove('open');
    if ($('notesDrawerBackdrop')) $('notesDrawerBackdrop').classList.remove('open');
  }

  function n2CardHTML(date, n, isPriority) {
    var d = new Date(date + 'T00:00:00');
    var datePill = DOW[d.getDay()] + ' ' + fmtShort(date);
    var scopeHtml = '';
    if (n.emp) {
      var code = (state.schedule[date] || {})[n.emp] || '';
      var s = getShift(code);
      var shiftTag = s
        ? '<span class="n2-shift-tag">· ' + escapeHtml(s.label) + '</span>'
        : '<span class="n2-shift-tag" style="color:var(--muted)">· Sem turno</span>';
      scopeHtml = '<span class="n2-scope-pill">👤 ' + escapeHtml(n.emp) + ' ' + shiftTag + '</span>';
    } else {
      scopeHtml = '<span class="n2-scope-pill">👥 Dia inteiro</span>';
    }
    var editing = drawerState.editing && drawerState.editing.id === n.id && drawerState.editing.date === date;
    var body = editing
      ? '<textarea id="drwEditText" class="note-textarea" rows="3" maxlength="600">' + escapeHtml(n.text) + '</textarea>' +
        '<div class="n2-acts"><button type="button" data-drw-act="save" class="na-primary">Salvar</button><button type="button" data-drw-act="cancel">Cancelar</button></div>'
      : '<div class="n2-text">' + escapeHtml(n.text) + '</div>' +
        '<div class="n2-foot"><span class="n2-meta">' + (n.by ? escapeHtml(n.by) + ' · ' : '') + noteTime(n) + (n.edited ? ' · editada' : '') + '</span>' +
        '<div class="n2-acts">' +
          (n.emp ? '<button type="button" data-drw-act="cell">Abrir célula ›</button>' : '') +
          '<button type="button" data-drw-act="edit">Editar</button>' +
          '<button type="button" data-drw-act="del" class="na-danger">Excluir</button>' +
        '</div></div>';

    return '<div class="n2-card' + (isPriority ? ' priority' : '') + '" data-date="' + date + '" data-id="' + n.id + '">' +
      '<div class="n2-top"><span class="n2-date-pill">' + datePill + '</span>' + scopeHtml +
      '<button type="button" class="n2-star-btn' + (n.important ? ' on' : '') + '" data-drw-act="imp" title="' + (n.important ? 'Remover prioridade' : 'Marcar como prioridade') + '">' + (n.important ? '★' : '☆') + '</button></div>' +
      body + '</div>';
  }

  function renderNotesDrawer() {
    var bodyEl = $('drawerBody'), chipsEl = $('drawerChips');
    if (!bodyEl || !chipsEl) return;
    var range = getDrawerRange();
    $('drawerTitle').textContent = drawerState.filter === 'alerts' ? 'Alertas do período' : range.title;
    $('drawerSub').textContent = range.sub;

    var allNotes = periodNotes(range.start, range.end);
    var issues = computeIssues(range.start, range.end);
    var impAll = allNotes.filter(function (r) { return r.n.important; }).length;
    var errs = issues.filter(function (i) { return i.sev === 'error'; }).length;
    var warns = issues.filter(function (i) { return i.sev === 'warn'; }).length;

    var chips = '<button type="button" class="drawer-chip' + (drawerState.filter === 'all' ? ' active' : '') + '" data-drw-filter="all">Todas (' + allNotes.length + ')</button>' +
      '<button type="button" class="drawer-chip imp-chip' + (drawerState.filter === 'imp' ? ' active' : '') + '" data-drw-filter="imp">★ ' + impAll + '</button>';
    if (drawerState.day) {
      chips += '<button type="button" class="drawer-chip day-chip" data-drw-clear-day="1">📅 ' + fmtShort(drawerState.day) + ' ×</button>';
    }
    if (issues.length) {
      chips += '<button type="button" class="drawer-chip' + (drawerState.filter === 'alerts' ? ' active' : '') + '" data-drw-filter="alerts">⚠ ' + issues.length + '</button>';
    }
    var fePendTotal = 0;
    state.employees.forEach(function (e) { fePendTotal += computeEmpHolidayCredits(e).pending.length; });
    chips += '<button type="button" class="drawer-chip' + (drawerState.filter === 'fe' ? ' active' : '') + '" data-drw-filter="fe">🏖 FE' + (fePendTotal ? ' (' + fePendTotal + ')' : '') + '</button>';
    chips += '<button type="button" class="drawer-chip tab-link" data-drw-goto-notes="1">Aba Notas ›</button>';
    chipsEl.innerHTML = chips;

    var h = '';
    if (drawerState.filter === 'alerts') {
      var planned = false;
      var cur = new Date(range.start + 'T00:00:00'), endD = new Date(range.end + 'T00:00:00');
      while (cur <= endD) { if (dayPlanned(keyOf(cur))) { planned = true; break; } cur.setDate(cur.getDate() + 1); }
      h = issuesCardHTML(issues, { title: 'Verificações do período', planned: planned, okTitle: 'Tudo em dia' });
      if (!h) h = '<div class="notes-empty">Nenhum alerta ou célula vazia neste período.</div>';
    } else if (drawerState.filter === 'fe') {
      h = renderP3HolidayWidget({ compact: true });
    } else {
      if ((errs || warns) && !drawerState.day) {
        var bParts = [];
        if (errs) bParts.push(errs + (errs > 1 ? ' erros' : ' erro'));
        if (warns) bParts.push(warns + (warns > 1 ? ' avisos' : ' aviso'));
        h += '<button type="button" class="drawer-alert-banner' + (errs ? '' : ' warn') + '" data-drw-filter="alerts"><span>⚠ ' + bParts.join(' · ') + ' no período</span><span>Ver ›</span></button>';
      }
      var list = allNotes.filter(function (r) {
        if (drawerState.day && r.date !== drawerState.day) return false;
        if (drawerState.filter === 'imp' && !r.n.important) return false;
        return true;
      });
      var imps = list.filter(function (r) { return r.n.important; });
      var gens = list.filter(function (r) { return !r.n.important; });
      if (imps.length) {
        h += '<div class="n2-section-title priority"><span>★ Prioridade</span><span>' + imps.length + '</span></div>' +
          imps.map(function (r) { return n2CardHTML(r.date, r.n, true); }).join('');
      }
      if (gens.length) {
        h += '<div class="n2-section-title"><span>Gerais</span><span>' + gens.length + '</span></div>' +
          gens.map(function (r) { return n2CardHTML(r.date, r.n, false); }).join('');
      }
      if (!list.length) {
        h += '<div class="notes-empty">' + (drawerState.day ? 'Nenhuma anotação para ' + fmtShort(drawerState.day) + '.' : (drawerState.filter === 'imp' ? 'Nenhuma anotação prioritária neste período.' : 'Nenhuma anotação neste período. Use "+ Nova anotação" abaixo ou toque em uma célula.')) + '</div>';
      }
    }
    bodyEl.innerHTML = h;

    var toggleBtn = $('drawerNewToggle'), compEl = $('drawerComposer');
    if (toggleBtn && compEl) {
      toggleBtn.classList.toggle('hidden', !!drawerState.composing);
      compEl.classList.toggle('hidden', !drawerState.composing);
      if (drawerState.composing) {
        var scopeSel = $('drwScope');
        if (scopeSel) {
          var prevVal = scopeSel.value;
          scopeSel.innerHTML = '<option value="day">Dia inteiro (time)</option>' +
            state.employees.map(function (e) { return '<option value="emp:' + escapeHtml(e) + '">' + escapeHtml(e) + '</option>'; }).join('');
          if (prevVal) scopeSel.value = prevVal;
        }
      }
    }

    if (drawerState.editing) {
      var ta = $('drwEditText');
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }
  }

  var notesFilter = { q: '', mode: 'all' };
  var editingNote = null;

  function renderNotes() {
    var y = currentDate.getFullYear(), m = currentDate.getMonth();
    var now = new Date();
    var defDate = (now.getFullYear() === y && now.getMonth() === m) ? keyOf(now) : dateKey(y, m, 1);
    var scopeOpts = '<option value="day">Dia inteiro (time)</option>' +
      state.employees.map(function (e) { return '<option value="emp:' + escapeHtml(e) + '">' + escapeHtml(e) + '</option>'; }).join('');
    var chips = [['all', 'Todas'], ['imp', '★ Importantes'], ['day', 'Do time']].concat(state.employees.map(function (e) { return ['emp:' + e, e]; }));
    var chipsHtml = chips.map(function (c) {
      return '<button type="button" class="note-chip' + (notesFilter.mode === c[0] ? ' active' : '') + '" data-nf="' + escapeHtml(c[0]) + '">' + escapeHtml(c[1]) + '</button>';
    }).join('');
    var h = '<div class="notes-view">' +
      '<div class="notes-card"><div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></div><h3 class="section-title">Nova anotação</h3></div>' +
      '<div class="note-form-grid">' +
        '<div><label class="png-label" for="nvDate">Data</label><input type="date" id="nvDate" class="png-date-input" value="' + defDate + '"></div>' +
        '<div><label class="png-label" for="nvScope">Sobre</label><select id="nvScope" class="note-select">' + scopeOpts + '</select></div>' +
      '</div>' +
      '<textarea id="nvText" class="note-textarea" rows="3" maxlength="600" placeholder="Ex.: Lucas pediu troca de turno na sexta; confirmar com o gerente."></textarea>' +
      '<div class="note-composer-row"><label class="note-imp"><input type="checkbox" id="nvImp"> Importante</label><button type="button" class="note-add" id="nvAdd">Adicionar</button></div></div>' +
      '<div class="notes-card"><div class="notes-toolbar"><div class="note-chips">' + chipsHtml + '</div>' +
      '<input type="search" id="nvSearch" class="note-search" placeholder="Buscar nas anotações…" value="' + escapeHtml(notesFilter.q) + '"></div>' +
      '<div id="notesList"></div></div></div>';
    viewNotes.innerHTML = h;
    renderNotesList();
  }

  function renderNotesList() {
    var el = $('notesList');
    if (!el) return;
    var y = currentDate.getFullYear(), m = currentDate.getMonth();
    var prefix = y + '-' + pad(m + 1) + '-';
    var q = (notesFilter.q || '').trim().toLowerCase();
    var mode = notesFilter.mode;
    var rows = [];
    Object.keys(state.notes || {}).forEach(function (date) {
      if (date.indexOf(prefix) !== 0) return;
      state.notes[date].forEach(function (n) {
        if (mode === 'imp' && !n.important) return;
        if (mode === 'day' && n.emp) return;
        if (mode.indexOf('emp:') === 0 && n.emp !== mode.slice(4)) return;
        if (q && (n.text + ' ' + (n.emp || '') + ' ' + (n.by || '')).toLowerCase().indexOf(q) === -1) return;
        rows.push({ date: date, n: n });
      });
    });
    rows.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.n.ts || '') < (b.n.ts || '') ? -1 : 1;
    });
    if (!rows.length) {
      el.innerHTML = '<div class="notes-empty">' + (q || mode !== 'all' ? 'Nenhuma anotação encontrada com esse filtro.' : 'Nenhuma anotação neste mês. Use o formulário acima ou toque em uma célula da escala.') + '</div>';
      return;
    }
    var h = '', lastDate = '';
    rows.forEach(function (r) {
      if (r.date !== lastDate) {
        lastDate = r.date;
        h += '<button type="button" class="note-date" data-goto-date="' + r.date + '">' + fmtLong(new Date(r.date + 'T00:00:00')) + '<span>ver na escala ›</span></button>';
      }
      var n = r.n;
      var editing = editingNote && editingNote.id === n.id && editingNote.date === r.date;
      h += '<div class="note-item' + (n.important ? ' imp' : '') + '" data-date="' + r.date + '" data-id="' + n.id + '">' +
        '<div class="note-top"><span class="note-scope">' + noteScopeLabel(n) + '</span><span class="note-meta">' + (n.by ? escapeHtml(n.by) + ' · ' : '') + noteTime(n) + (n.edited ? ' · editada' : '') + '</span></div>';
      if (editing) {
        h += '<textarea id="editNoteText" class="note-textarea" rows="3" maxlength="600">' + escapeHtml(n.text) + '</textarea>' +
          '<div class="note-actions"><button type="button" data-na="save" class="na-primary">Salvar</button><button type="button" data-na="cancel">Cancelar</button></div>';
      } else {
        h += '<div class="note-text">' + escapeHtml(n.text) + '</div>' +
          '<div class="note-actions"><button type="button" data-na="imp" class="' + (n.important ? 'na-on' : '') + '">' + (n.important ? '★ Importante' : '☆ Marcar importante') + '</button>' +
          '<button type="button" data-na="edit">Editar</button><button type="button" data-na="del" class="na-danger">Excluir</button></div>';
      }
      h += '</div>';
    });
    el.innerHTML = h;
    if (editingNote) { var ta = $('editNoteText'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
  }

  var sheetNoteState = { composing: false, editingId: null };

  function renderSheetNotes() {
    var list = $('sheetNotesList'), titleEl = $('notesSectionTitle');
    var comp = $('sheetNoteComposer'), toggle = $('sheetNoteToggle');
    if (!list || !sheetCtx) return;
    var emp = sheetCtx.emp, date = sheetCtx.date;
    var items = getNotes(date).filter(function (n) { return n.emp === emp || !n.emp; });
    items.sort(function (a, b) {
      if (!!a.important !== !!b.important) return a.important ? -1 : 1;
      return (a.ts || '') < (b.ts || '') ? -1 : 1;
    });
    if (titleEl) titleEl.textContent = 'Anotações' + (items.length ? ' (' + items.length + ')' : '');

    list.innerHTML = items.length ? items.map(function (n) {
      var editing = sheetNoteState.editingId === n.id;
      var scopeBadge = n.emp
        ? '<span class="n2-scope-pill">👤 ' + escapeHtml(n.emp) + '</span>'
        : '<span class="n2-scope-pill">👥 Dia inteiro</span>';
      var bodyHtml = editing
        ? '<textarea id="sheetEditNoteText" class="note-textarea" rows="2" maxlength="600">' + escapeHtml(n.text) + '</textarea>' +
          '<div class="n2-acts"><button type="button" data-sheet-note-act="save" class="na-primary">Salvar</button><button type="button" data-sheet-note-act="cancel">Cancelar</button></div>'
        : '<div class="n2-text">' + escapeHtml(n.text) + '</div>' +
          '<div class="n2-foot"><span class="n2-meta">' + (n.by ? escapeHtml(n.by) + ' · ' : '') + noteTime(n) + (n.edited ? ' · editada' : '') + '</span>' +
          '<div class="n2-acts"><button type="button" data-sheet-note-act="edit">Editar</button><button type="button" data-sheet-note-act="del" class="na-danger">Excluir</button></div></div>';
      return '<div class="n2-card' + (n.important ? ' priority' : '') + '" data-id="' + n.id + '">' +
        '<div class="n2-top">' + scopeBadge +
        '<button type="button" class="n2-star-btn' + (n.important ? ' on' : '') + '" data-sheet-note-act="imp" title="' + (n.important ? 'Remover prioridade' : 'Marcar como prioridade') + '">' + (n.important ? '★' : '☆') + '</button></div>' +
        bodyHtml + '</div>';
    }).join('') : '<div class="notes-empty small">Nenhuma anotação para este dia.</div>';

    if (comp) comp.classList.toggle('hidden', !sheetNoteState.composing);
    if (toggle) toggle.textContent = sheetNoteState.composing ? 'Fechar' : '+ Nova nota';

    if (sheetNoteState.editingId) {
      var ta = $('sheetEditNoteText');
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }
  }

  function countSundayWorkers(date) {
    return state.employees.filter(function (e) { return isWorkShift((state.schedule[date] || {})[e]); }).length;
  }

  function checkEssentialShifts(key) {
    var d = new Date(key + 'T00:00:00');
    if (d.getDay() === 0 || !dayPlanned(key) || dayIsStoreClosed(key)) return { missing06: false, missing14: false };
    var has06 = false, has14 = false;
    state.employees.forEach(function (emp) {
      var code = (state.schedule[key] || {})[emp];
      if (code === '06:00') has06 = true;
      if (code === '14:00') has14 = true;
    });
    return { missing06: !!state.shifts['06:00'] && !has06, missing14: !!state.shifts['14:00'] && !has14 };
  }

  function dayMissingChipsHTML(miss, compact) {
    if (!miss || (!miss.missing06 && !miss.missing14)) return '';
    var codes = [];
    if (miss.missing06) codes.push('06');
    if (miss.missing14) codes.push('14');
    var tip = (codes.length === 2 ? 'Faltam turnos 06h e 14h' : ('Falta turno ' + codes[0] + 'h')) + ' — clique para ver alertas';
    var chips = (compact && codes.length === 2)
      ? '<span class="day-miss-chip">06·14</span>'
      : codes.map(function (c) {
          return '<span class="day-miss-chip">' + (compact ? c : '× ' + c) + '</span>';
        }).join('');
    return '<button type="button" class="day-miss-chips' + (compact ? ' compact' : '') + '" data-open-drawer="alerts" title="' + escapeHtml(tip) + '" aria-label="' + escapeHtml(tip) + '">' + chips + '</button>';
  }

  function renderHeader() {
    if (activeView === 'week') {
      var s = getWeekStart(currentDate);
      var e = new Date(s); e.setDate(s.getDate() + 6);
      periodTitle.textContent = s.getDate() + ' ' + MONTHS[s.getMonth()].slice(0, 3) + ' – ' + e.getDate() + ' ' + MONTHS[e.getMonth()].slice(0, 3) + ' ' + e.getFullYear();
    } else {
      periodTitle.textContent = MONTHS[currentDate.getMonth()] + ' ' + currentDate.getFullYear();
    }
  }

  function emptyStateHTML(msg) {
    return '<div class="empty-state"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg><div>' + msg + '</div></div>';
  }

  function computePrintText(code, dow) {
    if (code === 'D' || code === 'F6') return code;
    if (dow === 0 && isWorkShift(code)) return 'T';
    return '';
  }

  var _exporting = false;

  function renderWeek() {
    if (!state.employees || state.employees.length === 0) {
      viewWeek.innerHTML = emptyStateHTML('Nenhum colaborador cadastrado. Adicione em <strong>Ajustes</strong>.');
      return;
    }
    var start = getWeekStart(currentDate);
    var days = [];
    var wPlanned = false;
    for (var i = 0; i < 7; i++) {
      var d0 = new Date(start); d0.setDate(start.getDate() + i);
      days.push(d0);
      if (dayPlanned(keyOf(d0))) wPlanned = true;
    }
    var weekEndD = days[6];
    var todayStr = new Date().toDateString();
    var h = gridTopbarHTML(keyOf(start), keyOf(weekEndD), { planned: wPlanned, okTitle: 'Semana em dia' });
    h += '<div class="week-grid"><div class="wk-corner"></div>';
    for (var j = 0; j < days.length; j++) {
      var dH = days[j], keyH = keyOf(dH), dowH = dH.getDay();
      var miss = checkEssentialShifts(keyH);
      var missClass = (miss.missing06 || miss.missing14) ? 'missing-essential' : '';
      var dNoteCls = dayHeadNoteCls(keyH);
      var clsH = [dowH === 0 || dowH === 6 ? 'weekend' : '', isHoliday(keyH) ? 'holiday' : '', dH.toDateString() === todayStr ? 'today' : '', missClass, dNoteCls].filter(Boolean).join(' ');
      var headStyle = '';
      if (dowH === 0) {
        var sun = state.colors.SUNDAY || { color: '#ef4444', text: '#ffffff' };
        headStyle = 'background:' + sun.color + '; color:' + sun.text + ';';
      }
      var badge = '';
      if (dowH === 0) {
        var nW = countSundayWorkers(keyH);
        var maxW = state.sundayRule.maxWorkers || 2;
        badge = '<span class="sun-count ' + (nW <= maxW ? 'ok' : 'bad') + '">' + nW + '/' + maxW + '</span>';
      }
      var alertIcon = dayMissingChipsHTML(miss, false);
      var nInfo = dayWideNoteInfo(keyH);
      var missTipW = (miss.missing06 || miss.missing14)
        ? ((miss.missing06 && miss.missing14 ? 'Faltam turnos 06h e 14h' : ('Falta turno ' + (miss.missing06 ? '06h' : '14h'))) + ' — clique para ver alertas')
        : '';
      var headTitle = nInfo.total
        ? ' title="' + escapeHtml(nInfo.total + (nInfo.total > 1 ? ' anotações do dia — clique para abrir' : ' anotação do dia — clique para abrir')) + '"'
        : (missTipW ? ' title="' + escapeHtml(missTipW) + '"' : '');
      h += '<div class="wk-day-head ' + clsH + '" data-day-key="' + keyH + '"' + headTitle + ' style="' + headStyle + '"><span class="wk-dow" style="' + (dowH === 0 ? 'color:inherit;opacity:.9' : '') + '">' + DOW[dowH] + '</span><span class="day-num-row"><span class="wk-num">' + dH.getDate() + '</span>' + dayNoteDotHTML(keyH) + '</span>' + badge + alertIcon + '</div>';
    }
    for (var k = 0; k < state.employees.length; k++) {
      var emp = state.employees[k];
      h += '<div class="wk-emp">' + emp + '</div>';
      for (var l = 0; l < days.length; l++) {
        var d = days[l], key = keyOf(d), dow = d.getDay();
        var code = (state.schedule[key] || {})[emp] || '';
        var s = getShift(code);
        var style = '';
        if (s) {
          if (s.type === 'work') {
            style = 'color:' + (isHoliday(key) ? '#fff' : s.text) + ';';
          } else if (dow === 0) {
            var sunColor = (state.colors.SUNDAY || { color: '#ef4444' }).color;
            style = 'background:' + sunColor + ';color:#facc15;font-weight:900;--note-mark:' + getContrastColor(sunColor) + ';';
          } else {
            style = 'background:' + s.color + ';color:' + s.text + ';--note-mark:' + getContrastColor(s.color) + ';';
          }
        }
        var printTxt = computePrintText(code, dow);
        var inner = '';
        if (s) inner += '<span class="cell-txt">' + s.label + '</span>';
        if (printTxt) inner += '<span class="cell-print">' + printTxt + '</span>';
        var fl = cellFlag(emp, key, code);
        var holidayClass = isHoliday(key) ? 'holiday' : '';
        var isFERef = (code === 'FE' && !isHoliday(key));
        var cTitle = cellTitle(emp, key, fl.title);
        h += '<button class="wk-cell ' + holidayClass + ' ' + fl.cls + ' ' + colNoteCls(key) + ' ' + noteCls(emp, key) + '" data-emp="' + escapeHtml(emp) + '" data-date="' + key + '" data-print="' + printTxt + '"' + (isFERef ? ' data-fe-ref="1"' : '') + (cTitle ? ' title="' + cTitle + '"' : '') + ' style="' + style + '">' + inner + '</button>';
      }
    }
    h += '</div>';
    viewWeek.innerHTML = h;
  }

  function renderMonth() {
    if (!state.employees || state.employees.length === 0) {
      viewMonth.innerHTML = emptyStateHTML('Nenhum colaborador cadastrado. Adicione em <strong>Ajustes</strong>.');
      return;
    }
    var y = currentDate.getFullYear(), m = currentDate.getMonth();
    var n = daysInMonth(currentDate);
    var mPlanned = false;
    for (var dd = 1; dd <= n; dd++) { if (dayPlanned(dateKey(y, m, dd))) { mPlanned = true; break; } }
    var todayStr = new Date().toDateString();
    var h = gridTopbarHTML(dateKey(y, m, 1), dateKey(y, m, n), { planned: mPlanned, okTitle: 'Mês em dia' });
    h += '<div class="grid-scroll" id="gridScrollInner"><table class="grid-table"><thead><tr><th class="sticky-col">Equipe</th>';
    for (var d = 1; d <= n; d++) {
      var dtH = new Date(y, m, d), dowH = dtH.getDay(), keyH = dateKey(y, m, d);
      var miss = checkEssentialShifts(keyH);
      var missClass = (miss.missing06 || miss.missing14) ? 'missing-essential' : '';
      var clsH = [dowH === 0 || dowH === 6 ? 'weekend' : '', isHoliday(keyH) ? 'holiday' : '', dtH.toDateString() === todayStr ? 'today' : '', missClass, dayHeadNoteCls(keyH)].filter(Boolean).join(' ');
      var headStyle = '';
      if (dowH === 0) {
        var sun = state.colors.SUNDAY || { color: '#ef4444', text: '#ffffff' };
        headStyle = 'background:' + sun.color + '; color:' + sun.text + ';';
      }
      var alertIcon = dayMissingChipsHTML(miss, true);
      var nInfoM = dayWideNoteInfo(keyH);
      var missTipM = (miss.missing06 || miss.missing14)
        ? ((miss.missing06 && miss.missing14 ? 'Faltam turnos 06h e 14h' : ('Falta turno ' + (miss.missing06 ? '06h' : '14h'))) + ' — clique para ver alertas')
        : '';
      var headTitleM = nInfoM.total
        ? ' title="' + escapeHtml(nInfoM.total + (nInfoM.total > 1 ? ' anotações do dia — clique para abrir' : ' anotação do dia — clique para abrir')) + '"'
        : (missTipM ? ' title="' + escapeHtml(missTipM) + '"' : '');
      h += '<th class="' + clsH + '" data-day-key="' + keyH + '"' + headTitleM + ' style="' + headStyle + '"><span class="day-num-row"><span class="dnum">' + d + '</span>' + dayNoteDotHTML(keyH) + '</span><span class="dow" style="' + (dowH === 0 ? 'color:inherit;opacity:.9' : '') + '">' + DOW[dowH] + '</span>' + alertIcon + '</th>';
    }
    h += '</tr></thead><tbody>';
    for (var i = 0; i < state.employees.length; i++) {
      var emp = state.employees[i];
      h += '<tr><th class="sticky-col">' + emp + '</th>';
      for (var j = 1; j <= n; j++) {
        var dt = new Date(y, m, j), key = dateKey(y, m, j), dow = dt.getDay();
        var code = (state.schedule[key] || {})[emp] || '';
        var s = getShift(code);
        var cls = ['cell', dow === 0 || dow === 6 ? 'weekend' : '', isHoliday(key) ? 'holiday' : ''].filter(Boolean).join(' ');
        var style = '';
        if (s) {
          if (s.type === 'work') {
            style = 'color:' + (isHoliday(key) ? '#fff' : s.text) + ';';
          } else if (dow === 0) {
            var sunColor = (state.colors.SUNDAY || { color: '#ef4444' }).color;
            style = 'background:' + sunColor + ';color:#facc15;font-weight:900;--note-mark:' + getContrastColor(sunColor) + ';';
          } else {
            style = 'background:' + s.color + ';color:' + s.text + ';--note-mark:' + getContrastColor(s.color) + ';';
          }
        }
        var printTxt = computePrintText(code, dow);
        var inner = '';
        if (s) inner += '<span class="cell-txt">' + s.label + '</span>';
        if (printTxt) inner += '<span class="cell-print">' + printTxt + '</span>';
        var fl = cellFlag(emp, key, code);
        var isFERefM = (code === 'FE' && !isHoliday(key));
        var cTitleM = cellTitle(emp, key, fl.title);
        h += '<td class="' + cls + ' ' + fl.cls + ' ' + colNoteCls(key) + ' ' + noteCls(emp, key) + '" data-emp="' + escapeHtml(emp) + '" data-date="' + key + '" data-print="' + printTxt + '"' + (isFERefM ? ' data-fe-ref="1"' : '') + (cTitleM ? ' title="' + cTitleM + '"' : '') + ' style="' + style + '">' + inner + '</td>';
      }
      h += '</tr>';
    }
    h += '</tbody></table></div><div class="legend">';
    Object.keys(state.shifts).forEach(function (id) {
      var s = state.shifts[id];
      if (s.type === 'event') h += '<div class="legend-item"><span class="legend-dot" style="background:' + s.color + ';color:' + s.text + '">' + s.label + '</span>' + s.name + '</div>';
    });
    h += '</div>';

    viewMonth.innerHTML = h;
    requestAnimationFrame(function () {
      if (_exporting) return;
      var th = document.querySelector('#gridScrollInner th.today');
      var sc = document.getElementById('gridScrollInner');
      if (th && sc) sc.scrollLeft = Math.max(0, th.offsetLeft - 80);
    });
  }

  // ==========================================
  // RENDER DE INTERVALO (usado na exportação e impressão)
  // ==========================================
  function renderRange(startStr, endStr, opts) {
    var container = viewMonth;
    if (!state.employees || state.employees.length === 0) {
      container.innerHTML = emptyStateHTML('Nenhum colaborador cadastrado.');
      return;
    }

    var d1 = new Date(startStr + 'T00:00:00');
    var d2 = new Date(endStr + 'T00:00:00');
    if (isNaN(d1.getTime()) || isNaN(d2.getTime()) || d1 > d2) {
      container.innerHTML = emptyStateHTML('Intervalo inválido.');
      return;
    }

    var days = [];
    var cur = new Date(d1);
    while (cur <= d2) { days.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
    if (days.length === 0) { container.innerHTML = emptyStateHTML('Intervalo vazio.'); return; }

    var todayStr = new Date().toDateString();
    var h = '<div class="grid-scroll" id="gridScrollInner"><table class="grid-table"><thead><tr><th class="sticky-col">Equipe</th>';
    for (var di = 0; di < days.length; di++) {
      var dtH = days[di], dowH = dtH.getDay(), keyH = keyOf(dtH);
      var miss = checkEssentialShifts(keyH);
      var missClass = (miss.missing06 || miss.missing14) ? 'missing-essential' : '';
      var clsH = [dowH === 0 || dowH === 6 ? 'weekend' : '', isHoliday(keyH) ? 'holiday' : '', dtH.toDateString() === todayStr ? 'today' : '', missClass].filter(Boolean).join(' ');
      var headStyle = '';
      if (dowH === 0) {
        var sun = state.colors.SUNDAY || { color: '#ef4444', text: '#ffffff' };
        headStyle = 'background:' + sun.color + '; color:' + sun.text + ';';
      }
      var monthLabel = '';
      if (di === 0 || dtH.getDate() === 1) {
        monthLabel = '<span class="dmonth">' + MONTHS[dtH.getMonth()].slice(0, 3) + '</span>';
      }
      var alertIcon = dayMissingChipsHTML(miss, true);
      h += '<th class="' + clsH + '" style="' + headStyle + '"><span class="dnum">' + dtH.getDate() + '</span><span class="dow" style="' + (dowH === 0 ? 'color:inherit;opacity:.9' : '') + '">' + DOW[dowH] + '</span>' + monthLabel + alertIcon + '</th>';
    }
    h += '</tr></thead><tbody>';
    for (var i = 0; i < state.employees.length; i++) {
      var emp = state.employees[i];
      h += '<tr><th class="sticky-col">' + emp + '</th>';
      for (var j = 0; j < days.length; j++) {
        var dt = days[j], key = keyOf(dt), dow = dt.getDay();
        var code = (state.schedule[key] || {})[emp] || '';
        var s = getShift(code);
        var cls = ['cell', dow === 0 || dow === 6 ? 'weekend' : '', isHoliday(key) ? 'holiday' : ''].filter(Boolean).join(' ');
        var style = '';
        if (s) {
          if (s.type === 'work') {
            style = 'color:' + (isHoliday(key) ? '#fff' : s.text) + ';';
          } else if (dow === 0) {
            var sunColor = (state.colors.SUNDAY || { color: '#ef4444' }).color;
            style = 'background:' + sunColor + ';color:#facc15;font-weight:900;--note-mark:' + getContrastColor(sunColor) + ';';
          } else {
            style = 'background:' + s.color + ';color:' + s.text + ';--note-mark:' + getContrastColor(s.color) + ';';
          }
        }
        var printTxt = computePrintText(code, dow);
        var inner = '';
        if (s) inner += '<span class="cell-txt">' + s.label + '</span>';
        if (printTxt) inner += '<span class="cell-print">' + printTxt + '</span>';
        h += '<td class="' + cls + '" data-emp="' + emp + '" data-date="' + key + '" data-print="' + printTxt + '" style="' + style + '">' + inner + '</td>';
      }
      h += '</tr>';
    }
    h += '</tbody></table></div><div class="legend">';
    Object.keys(state.shifts).forEach(function (id) {
      var s = state.shifts[id];
      if (s.type === 'event') h += '<div class="legend-item"><span class="legend-dot" style="background:' + s.color + ';color:' + s.text + '">' + s.label + '</span>' + s.name + '</div>';
    });
    h += '</div>';

    if (opts && opts.notes) {
      var nrows = [];
      days.forEach(function (dd) { var k = keyOf(dd); getNotes(k).forEach(function (n) { nrows.push({ k: k, n: n }); }); });
      if (nrows.length) {
        h += '<div class="range-notes"><div class="range-notes-title">Anotações</div><ul>' +
          nrows.map(function (r) {
            return '<li><strong>' + fmtShort(r.k) + '</strong> · ' + (r.n.emp ? escapeHtml(r.n.emp) : 'Time') + ': ' + (r.n.important ? '★ ' : '') + escapeHtml(r.n.text) + '</li>';
          }).join('') + '</ul></div>';
      }
    }
    container.innerHTML = h;
  }

  var summaryP3Emp = '';

  function renderP3HolidayWidget(opts) {
    opts = opts || {};
    var todayKey = keyOf(new Date());
    var byEmp = {};
    state.employees.forEach(function (emp) {
      byEmp[emp] = computeEmpHolidayCredits(emp, { todayKey: todayKey });
    });

    function empRank(emp) {
      var info = byEmp[emp], pend = info.pending;
      if (pend.some(function (c) { return c.status === 'expired'; })) return 0;
      if (pend.some(function (c) { return c.status === 'soon'; })) return 1;
      if (pend.length) return 2;
      if (info.credits.length) return 3;
      return 4;
    }

    if (!summaryP3Emp || state.employees.indexOf(summaryP3Emp) === -1) {
      var sorted = state.employees.slice().sort(function (a, b) { return empRank(a) - empRank(b); });
      summaryP3Emp = sorted[0] || '';
    }

    var chipsHtml = '<div class="p3-chips">' + state.employees.map(function (emp) {
      var info = byEmp[emp], pend = info.pending;
      var hasExp = pend.some(function (c) { return c.status === 'expired'; });
      var hasSoon = pend.some(function (c) { return c.status === 'soon'; });
      var cls = hasExp ? 'expired' : (hasSoon ? 'soon' : (pend.length ? 'ok' : ''));
      var minDays = pend.length ? Math.min.apply(null, pend.map(function (c) { return c.daysLeft; })) : null;
      var label = pend.length
        ? (hasExp ? pend.length + ' · Vencido' : (pend.length + ' · ' + minDays + 'd'))
        : (info.credits.length ? '0 (' + info.credits.length + ' agend.)' : '0');
      return '<button type="button" class="p3-chip ' + cls + (summaryP3Emp === emp ? ' active' : '') + '" data-p3-emp="' + escapeHtml(emp) + '">' +
        '<span class="p3-dot"></span><span>' + escapeHtml(emp) + ': ' + label + '</span></button>';
    }).join('') + '</div>';

    var selInfo = summaryP3Emp ? byEmp[summaryP3Emp] : null;
    var detailHtml = '';
    if (selInfo) {
      var rows = selInfo.credits.slice().sort(function (a, b) { return a.holDate < b.holDate ? -1 : 1; });
      if (!rows.length) {
        detailHtml = '<div class="p3-detail"><div class="notes-empty small">Nenhum feriado trabalhado registrado para ' + escapeHtml(summaryP3Emp) + '.</div></div>';
      } else {
        detailHtml = '<div class="p3-detail"><div class="p3-detail-head"><span>Extrato de ' + escapeHtml(summaryP3Emp) + ' (' + rows.length + ')</span><span>Prazo máx: 60 dias</span></div>' +
          rows.map(function (c) {
            var pCls = 'ok', pTxt = 'Restam ' + c.daysLeft + 'd';
            if (c.status === 'expired') { pCls = 'expired'; pTxt = 'Vencido há ' + Math.abs(c.daysLeft) + 'd'; }
            else if (c.status === 'soon') { pCls = 'soon'; pTxt = c.daysLeft === 0 ? 'Vence hoje' : 'Vence em ' + c.daysLeft + 'd'; }
            else if (c.status === 'used') { pCls = 'used'; pTxt = '✓ FE em ' + fmtShort(c.usedBy); }
            else if (c.status === 'used_late') { pCls = 'expired'; pTxt = '⚠ FE em ' + fmtShort(c.usedBy) + ' (>60d)'; }
            var gotoDate = c.usedBy || todayKey;
            var gotoLabel = c.usedBy ? 'Ver FE ›' : 'Agendar ›';
            return '<div class="p3-row">' +
              '<div class="p3-row-main"><div class="p3-row-title">' + fmtShort(c.holDate) + ' · ' + escapeHtml(c.holName) + '</div>' +
              '<div class="p3-row-sub">Prazo máximo (60d): ' + fmtFullDate(c.limitDate) + '</div></div>' +
              '<div class="p3-row-right"><span class="p3-pill ' + pCls + '">' + pTxt + '</span>' +
              '<button type="button" class="p3-jump" data-p3-goto="' + gotoDate + '">' + gotoLabel + '</button></div>' +
            '</div>';
          }).join('') + '</div>';
      }
    }
    return chipsHtml + detailHtml;
  }

  function renderSummary() {
    if (!state.employees || state.employees.length === 0) {
      viewSummary.innerHTML = emptyStateHTML('Nenhum colaborador cadastrado.');
      return;
    }
    var y = currentDate.getFullYear(), m = currentDate.getMonth();
    var n = daysInMonth(currentDate);
    var h = '<div class="summary"><div class="summary-card">' +
      '<div class="section-head" style="margin-bottom:10px"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>' +
      '<div><h3 class="section-title" style="margin:0">Controle de Folgas de Feriado (Prazo 60 dias)</h3><div style="font-size:12px;color:var(--muted);margin-top:2px">FIFO do mais antigo · Alerta amarelo com ≤15 dias · Clique no colaborador</div></div></div>' +
      renderP3HolidayWidget() + '</div>';

    for (var i = 0; i < state.employees.length; i++) {
      var emp = state.employees[i];
      var work = 0, folga = 0, ferias = 0, counts = {};
      for (var j = 1; j <= n; j++) {
        var code = (state.schedule[dateKey(y, m, j)] || {})[emp];
        if (!code) continue;
        if (code === 'D' || code === 'F6') folga++;
        else if (!isWorkShift(code)) ferias++;
        else if (isWorkShift(code)) { work++; counts[code] = (counts[code] || 0) + 1; }
      }
      var chipsHtml = Object.keys(counts).sort().map(function (c) {
        var s = getShift(c);
        var bg = (s.color === '#f1f5f9' || s.color === '#f8fafc') ? '#e2e8f0' : s.color;
        return '<span class="bd-chip" style="background:' + bg + ';color:' + s.text + '">' + s.label + ' · ' + counts[c] + '</span>';
      }).join('');
      h += '<div class="summary-card"><h3>' + emp + '</h3>' +
        '<div class="stats">' +
        '<div class="stat"><span class="stat-num">' + work + '</span><span class="stat-lab">Trabalho</span></div>' +
        '<div class="stat"><span class="stat-num">' + folga + '</span><span class="stat-lab">Folgas</span></div>' +
        '<div class="stat"><span class="stat-num">' + ferias + '</span><span class="stat-lab">Férias/Outros</span></div>' +
        '</div>' + (chipsHtml ? '<div class="bd">' + chipsHtml + '</div>' : '') + '</div>';
    }

    var sPlanned = false;
    for (var sd = 1; sd <= n; sd++) { if (dayPlanned(dateKey(y, m, sd))) { sPlanned = true; break; } }
    var sCard = issuesCardHTML(computeIssues(dateKey(y, m, 1), dateKey(y, m, n)), {
      title: 'Verificações do mês', planned: sPlanned, okTitle: 'Tudo certo!',
      okText: 'Descanso de 11h, domingos, turnos essenciais, dias seguidos e folgas semanais estão dentro das regras.'
    });
    if (sCard) h += sCard;
    h += '</div>';
    viewSummary.innerHTML = h;
  }

  var settingsCat = 'team';

  function renderSettings() {
    var y = currentDate.getFullYear(), m = currentDate.getMonth();
    var monthLabel = MONTHS[m] + ' ' + y;
    var teamDisplay = (currentTeam && currentTeam.name) ? currentTeam.name : (state.teamName || 'Equipe');
    var workIds = Object.keys(state.shifts).filter(function (k) { return state.shifts[k].type === 'work'; });
    workIds.sort(function (a, b) { return parseTime(state.shifts[a].start) - parseTime(state.shifts[b].start); });
    var eventIds = Object.keys(state.shifts).filter(function (k) { return state.shifts[k].type === 'event'; });
    var holKeys = Object.keys(state.holidays || {}).sort();

    var navItems = [
      { id: 'team', label: 'Equipe & Turnos', badge: state.employees.length, icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' },
      { id: 'rules', label: 'Regras & Feriados', badge: holKeys.length || '', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>' },
      { id: 'general', label: 'Conta & Geral', badge: '', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
      { id: 'backup', label: 'Backup & Perigo', badge: '', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/></svg>' }
    ];

    var navHtml = '<aside class="settings-nav"><div class="settings-nav-list">' +
      navItems.map(function (it) {
        return '<button type="button" class="settings-nav-btn' + (settingsCat === it.id ? ' active' : '') + '" data-scat="' + it.id + '">' +
          it.icon + '<span>' + it.label + '</span>' +
          (it.badge !== '' ? '<span class="snav-badge">' + it.badge + '</span>' : '') +
        '</button>';
      }).join('') +
      '</div><div class="settings-nav-foot"><span class="sync-pill" data-sync-pill="1">—</span></div></aside>';

    var panel = '';
    if (settingsCat === 'team') {
      panel += '<div class="settings-section">' +
        '<div class="settings-sec-head-split">' +
          '<div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>' +
          '<div><h3 class="section-title">Colaboradores & Automação</h3><div style="font-size:12px;color:var(--muted)">Nome, turno padrão (Seg–Sáb) e escala semanal em um só lugar.</div></div></div>' +
          '<button type="button" class="btn-auto settings-btn-auto-sm" id="btnAuto"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Gerar ' + MONTHS[m] + '</button>' +
        '</div>' +
        (state.employees.length ? '<div class="emp-head-labels"><span>Colaborador</span><span>Turno padrão</span><span>Escala semanal</span><span></span></div>' : '') +
        '<div class="edit-list" id="employeeList">';

      state.employees.forEach(function (emp) {
        var curDef = state.defaultShift[emp] || '';
        var defOpts = workIds.map(function (id) { return '<option value="' + escapeHtml(id) + '" ' + (id === curDef ? 'selected' : '') + '>' + escapeHtml(state.shifts[id].name) + '</option>'; }).join('');
        var curScale = getEmployeeScale(emp);
        panel += '<div class="edit-row emp-unified-row" data-emp="' + escapeHtml(emp) + '">' +
          '<div class="emp-main"><span class="emp-avatar">' + escapeHtml(initialsOf(emp)) + '</span>' +
          '<input type="text" class="name-input emp-name" value="' + escapeHtml(emp) + '" placeholder="Nome"></div>' +
          '<select class="def-shift" data-emp="' + escapeHtml(emp) + '" title="Turno padrão">' + defOpts + '</select>' +
          '<select class="emp-scale" data-emp="' + escapeHtml(emp) + '" title="Escala semanal">' +
            '<option value="6x1" ' + (curScale === '6x1' ? 'selected' : '') + '>6x1 (1 folga)</option>' +
            '<option value="5x2" ' + (curScale === '5x2' ? 'selected' : '') + '>5x2 (2 folgas)</option>' +
            '<option value="off" ' + (curScale === 'off' ? 'selected' : '') + '>Não verificar</option>' +
          '</select>' +
          '<button type="button" class="row-delete" data-del-emp="' + escapeHtml(emp) + '" title="Remover"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>' +
        '</div>';
      });
      panel += '</div><button type="button" class="add-btn" id="addEmployeeBtn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5v14"/></svg> Adicionar colaborador</button></div>';

      panel += '<div class="settings-two-col">';
      panel += '<div class="settings-section"><div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><h3 class="section-title">Turnos de Trabalho</h3></div><div class="edit-list" id="workShiftList">';
      workIds.forEach(function (id) {
        var s = state.shifts[id];
        panel += '<div class="edit-row" data-shift="' + escapeHtml(id) + '" data-type="work"><input type="color" class="color-picker shift-color" value="' + s.color + '" title="Cor"><input type="text" class="label-input shift-label" value="' + escapeHtml(s.label) + '" maxlength="4" title="Rótulo"><input type="time" class="time-input shift-start" value="' + s.start + '" title="Início"><span class="arrow">→</span><input type="time" class="time-input shift-end" value="' + s.end + '" title="Fim"><button type="button" class="row-delete" data-del-shift="' + escapeHtml(id) + '" title="Remover"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div>';
      });
      panel += '</div><button type="button" class="add-btn" id="addWorkShiftBtn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5v14"/></svg> Adicionar turno</button></div>';

      panel += '<div class="settings-section"><div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z"/><line x1="7" x2="7.01" y1="7" y2="7"/></svg></div><h3 class="section-title">Eventos e Folgas</h3></div><div class="edit-list" id="eventShiftList">';
      eventIds.forEach(function (id) {
        var s = state.shifts[id];
        panel += '<div class="edit-row" data-shift="' + escapeHtml(id) + '" data-type="event"><input type="color" class="color-picker shift-color" value="' + s.color + '" title="Cor"><input type="text" class="label-input shift-label" value="' + escapeHtml(s.label) + '" maxlength="4" title="Rótulo"><input type="text" class="name-input shift-name-input" value="' + escapeHtml(s.name) + '" placeholder="Nome do evento" title="Nome"><button type="button" class="row-delete" data-del-shift="' + escapeHtml(id) + '" title="Remover"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div>';
      });
      panel += '</div><button type="button" class="add-btn" id="addEventBtn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5v14"/></svg> Adicionar evento</button></div>';
      panel += '</div>';
    } else if (settingsCat === 'rules') {
      var rule = state.sundayRule;
      panel += '<div class="settings-section"><div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg></div><h3 class="section-title">Regras de Escala</h3></div>' +
        '<div class="settings-row"><label>Máximo de colaboradores no domingo</label><select class="sun-rule-config" data-key="maxWorkers">' + [1, 2, 3, 4, 5].map(function (v) { return '<option value="' + v + '" ' + (rule.maxWorkers == v ? 'selected' : '') + '>' + v + '</option>'; }).join('') + '</select></div>' +
        '<div class="settings-row"><label>Máximo de domingos consecutivos</label><select class="sun-rule-config" data-key="maxConsecutive">' + [1, 2, 3, 4].map(function (v) { return '<option value="' + v + '" ' + (rule.maxConsecutive == v ? 'selected' : '') + '>' + v + ' Domingo(s)</option>'; }).join('') + '</select></div>' +
        '<div class="settings-row"><label>Máximo de dias seguidos de trabalho</label><select class="limit-config" data-key="maxConsecutiveDays">' + [0, 5, 6, 7].map(function (v) { return '<option value="' + v + '" ' + (getMaxRun() === v ? 'selected' : '') + '>' + (v === 0 ? 'Não verificar' : v + ' dias') + '</option>'; }).join('') + '</select></div>' +
        '<div class="settings-row"><label>Cor do cabeçalho de Domingo</label><input type="color" class="color-picker sunday-color" value="' + (state.colors.SUNDAY ? state.colors.SUNDAY.color : '#ef4444') + '"></div>' +
        '<p class="settings-hint">💡 Intervalo mínimo de 11h entre turnos e cobertura dos turnos essenciais (06:00 e 14:00) são verificados automaticamente. A escala individual (6x1/5x2) fica em <strong>Equipe & Turnos</strong>.</p>' +
        '</div>';

      panel += '<div class="settings-section"><div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg></div><h3 class="section-title">Feriados</h3></div>';
      if (holKeys.length === 0) panel += '<p style="font-size:12.5px;color:var(--muted);padding:6px 0">Nenhum feriado cadastrado.</p>';
      panel += '<div class="holiday-list">';
      holKeys.forEach(function (k) {
        var p = k.split('-');
        panel += '<div class="holiday-item"><span>' + p[2] + '/' + p[1] + '/' + p[0] + ' — ' + escapeHtml(state.holidays[k]) + '</span><button type="button" data-del-hol="' + k + '">remover</button></div>';
      });
      panel += '</div><div class="add-holiday"><input type="date" id="newHolDate"><input type="text" id="newHolName" placeholder="Nome do feriado"><button type="button" id="addHolBtn">Adicionar</button></div></div>';
    } else if (settingsCat === 'general') {
      var emailStr = currentUser ? currentUser.email : '';
      var curTheme = getThemePref();
      panel += '<div class="settings-section">' +
        '<div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div><h3 class="section-title">Conta e Equipe</h3></div>' +
        '<div class="account-banner">' +
          '<div class="account-user">' +
            '<span class="account-avatar">' + escapeHtml(initialsOf(emailStr.split('@')[0])) + '</span>' +
            '<div class="account-meta"><div class="account-email">' + escapeHtml(emailStr) + '</div><span class="account-team-pill" id="settingsTeamBadge">' + escapeHtml(teamDisplay) + '</span></div>' +
          '</div>' +
          '<div class="account-actions">' +
            '<button type="button" class="danger-btn neutral" data-settings-act="change-team">Trocar de Time</button>' +
            '<button type="button" class="danger-btn" data-settings-act="logout">Sair da Conta</button>' +
          '</div>' +
        '</div></div>';

      panel += '<div class="settings-section">' +
        '<div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg></div><h3 class="section-title">Preferências e Nuvem</h3></div>' +
        '<div class="settings-row"><label for="teamNameInput">Nome do time</label><input type="text" class="team-name-input" id="teamNameInput" value="' + escapeHtml(teamDisplay) + '"></div>' +
        '<div class="settings-row"><label>Tema (neste dispositivo)</label><div class="theme-seg">' +
          [['auto', 'Auto'], ['light', 'Claro'], ['dark', 'Escuro']].map(function (o) {
            return '<button type="button" class="theme-seg-btn' + (curTheme === o[0] ? ' active' : '') + '" data-theme-btn="' + o[0] + '">' + o[1] + '</button>';
          }).join('') +
        '</div></div>' +
        '<div class="settings-row"><label>Sincronização na nuvem</label><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="sync-pill" id="storageStatus" data-sync-pill="1">—</span><button type="button" class="danger-btn neutral" id="forceSyncBtn">Sincronizar</button></div></div>' +
        '</div>';
    } else {
      panel += '<div class="settings-section">' +
        '<div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/></svg></div><h3 class="section-title">Backup e Restauração (CSV)</h3></div>' +
        '<div class="settings-row"><label>Exportar escala de ' + monthLabel + ' e configurações</label><button type="button" class="danger-btn neutral" id="downloadCsvBtn">Baixar CSV</button></div>' +
        '<div class="settings-row"><label>Importar arquivo CSV de backup</label><button type="button" class="danger-btn success" id="importBtn">Importar CSV</button><input type="file" id="importFile" accept=".csv,text/csv" style="display:none"></div>' +
        '</div>';

      panel += '<div class="settings-section danger-zone-card">' +
        '<div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg></div><h3 class="section-title">Zona de Perigo</h3></div>' +
        '<div class="settings-row"><label>Limpar escala de <strong>' + monthLabel + '</strong></label><button type="button" class="danger-btn" id="clearMonthBtn">Limpar ' + MONTHS[m].slice(0, 3) + '</button></div>' +
        '<div class="settings-row"><label>Apagar todos os dados deste time</label><button type="button" class="danger-btn" id="resetBtn">Apagar tudo</button></div>' +
        '</div>';
    }

    viewSettings.innerHTML = '<div class="settings-shell">' + navHtml + '<div class="settings-panel">' + panel + '</div></div>';
    updateStorageStatus();
  }

  function renderActive() {
    renderHeader();
    switch (activeView) {
      case 'week': renderWeek(); break;
      case 'month': renderMonth(); break;
      case 'summary': renderSummary(); break;
      case 'settings': renderSettings(); break;
      case 'notes': renderNotes(); break;
    }
    updateBadges();
    if (drawerState.open) renderNotesDrawer();
  }

  function switchToView(view) {
    hideFEHoverTip();
    if (view !== 'week' && view !== 'month') closeNotesDrawer();
    activeView = view;
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === view); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + view); });
    renderActive();
  }

  var sheetCtx = null;
  function shortCellIssue(issue, targetDate) {
    if (!issue) return '';
    if (issue.type === 'rest') {
      var d = new Date(targetDate + 'T00:00:00');
      var other = new Date(d);
      if (issue.date === targetDate) other.setDate(d.getDate() - 1);
      else other.setDate(d.getDate() + 1);
      return '⚠ <11h c/ ' + DOW[other.getDay()];
    }
    if (issue.type === 'sunday') return '⚠ Dom. lotado';
    if (issue.type === 'sundayc') return '⚠ Dom. seguidos';
    if (issue.type === 'run') return '⚠ Dias seguidos';
    if (issue.type === 'balance') return '⚠ Sem saldo FE';
    if (issue.type === 'fe_exp') return '⚠ Prazo >60d';
    if (issue.type === 'fe_soon') return '⚠ Vence ≤15d';
    return '⚠ Regra';
  }

  function buildWorkShiftBtn(code, cur, emp, dateStr) {
    var s = getShift(code); if (!s) return '';
    var active = code === cur;
    var invalid = false, shortReason = '', fullReason = '';
    if (!active) {
      var issues = getCellIssues(emp, dateStr, code);
      if (issues.length) {
        invalid = true;
        shortReason = shortCellIssue(issues[0], dateStr);
        fullReason = issues.map(function (i) { return i.msg; }).join(' • ');
      }
    }
    var subHtml = invalid
      ? '<span class="shift-reason">' + escapeHtml(shortReason) + '</span>'
      : '<span class="shift-name">' + escapeHtml(s.name) + '</span>';
    return '<button type="button" class="shift-btn ' + (active ? 'active ' : '') + (invalid ? 'invalid' : '') + '" data-code="' + escapeHtml(code) + '" style="--c:' + s.color + ';--t:' + s.text + '" title="' + escapeHtml(fullReason) + '">' +
      '<span class="shift-code">' + (active ? '✓ ' : '') + escapeHtml(s.label) + '</span>' +
      subHtml + '</button>';
  }

  function buildEventPillBtn(code, cur, emp, dateStr) {
    var s = getShift(code); if (!s) return '';
    var active = code === cur;
    var nameDisplay = s.name;
    var subText = '', warnShort = '', fullReason = '';
    if (code === 'FE') {
      var sim = computeEmpHolidayCredits(emp, active ? {} : { excludeDate: dateStr });
      if (active && sim.pairMap[dateStr]) {
        var cp = sim.pairMap[dateStr];
        nameDisplay = 'Saldo: ' + sim.pending.length;
        if (cp.lateUsed) warnShort = '⚠ Fora 60d (' + fmtShort(cp.holDate) + ')';
        else subText = 'Ref. ' + fmtShort(cp.holDate) + ' · até ' + fmtShort(cp.limitDate);
      } else {
        var elig = sim.pending.filter(function (c) { return c.holDate <= dateStr; });
        if (elig.length) {
          var c0 = elig[0];
          nameDisplay = 'Saldo: ' + elig.length + ' · até ' + fmtShort(c0.limitDate);
          if (dateStr > c0.limitDate) warnShort = '⚠ Passa 60d (' + fmtShort(c0.holDate) + ')';
          else subText = 'Abate ' + fmtShort(c0.holDate) + ' (' + c0.holName + ')';
        } else {
          nameDisplay = 'Saldo: 0';
          if (!active) {
            var issues0 = getCellIssues(emp, dateStr, code);
            if (issues0.length) { warnShort = shortCellIssue(issues0[0], dateStr); fullReason = issues0[0].msg; }
          }
        }
      }
      if (!fullReason && !active) {
        var allIss = getCellIssues(emp, dateStr, code);
        if (allIss.length) fullReason = allIss.map(function (i) { return i.msg; }).join(' • ');
      }
    }
    return '<button type="button" class="event-pill-btn' + (active ? ' active' : '') + '" data-code="' + escapeHtml(code) + '" title="' + escapeHtml(fullReason) + '">' +
      '<span class="ev-badge" style="background:' + s.color + ';color:' + s.text + '">' + escapeHtml(s.label) + '</span>' +
      '<span class="ev-info"><span class="ev-name">' + (active ? '✓ ' : '') + escapeHtml(nameDisplay) + '</span>' +
      (warnShort ? '<span class="ev-warn">' + escapeHtml(warnShort) + '</span>' : (subText ? '<span class="ev-sub">' + escapeHtml(subText) + '</span>' : '')) +
      '</span></button>';
  }

  function renderSheetNeighbors(emp, dateStr) {
    var el = $('sheetNeighbors');
    if (!el) return;
    var d = new Date(dateStr + 'T00:00:00');
    var prev = new Date(d); prev.setDate(d.getDate() - 1);
    var next = new Date(d); next.setDate(d.getDate() + 1);
    function lblOf(dt) {
      var k = keyOf(dt);
      var code = (state.schedule[k] || {})[emp] || '';
      var s = getShift(code);
      return DOW[dt.getDay()] + ' ' + (s ? s.label : '—');
    }
    el.innerHTML =
      '<button type="button" class="sn-day" data-jump-date="' + keyOf(prev) + '" title="Ir para o dia anterior">' + escapeHtml(lblOf(prev)) + '</button>' +
      '<span class="sn-arr">→</span>' +
      '<span class="sn-day current">' + escapeHtml(lblOf(d)) + '</span>' +
      '<span class="sn-arr">→</span>' +
      '<button type="button" class="sn-day" data-jump-date="' + keyOf(next) + '" title="Ir para o próximo dia">' + escapeHtml(lblOf(next)) + '</button>';
  }

  function renderSheetRuleHint(emp, dateStr, cur, workIds) {
    var box = $('sheetRuleHint');
    if (!box) return;
    var feRef = (cur === 'FE') ? getFERefInfo(emp, dateStr) : null;
    if (cur) {
      var curIssues = getCellIssues(emp, dateStr, cur);
      if (curIssues.length) {
        var hasErr = curIssues.some(function (i) { return i.sev === 'error'; });
        box.className = 'sheet-rule-box ' + (hasErr ? 'error' : 'warn');
        var prefix = (feRef && feRef.holDate)
          ? '<strong>🏖 Ref. ' + escapeHtml(feRef.holLabel) + '</strong> — '
          : '';
        box.innerHTML = prefix + '<strong>⚠ Conflito atual:</strong> ' + escapeHtml(curIssues.map(function (i) { return i.msg; }).join(' • '));
        return;
      }
    }
    if (feRef) {
      box.className = 'sheet-rule-box fe-ref';
      box.innerHTML = '<strong>🏖 Folga de Feriado:</strong> Ref. <strong>' + escapeHtml(feRef.holLabel) + '</strong> · ' + escapeHtml(feRef.sub);
      return;
    }
    var restLabels = [], otherMsg = '';
    workIds.forEach(function (id) {
      if (id === cur) return;
      var issues = getCellIssues(emp, dateStr, id);
      if (!issues.length) return;
      var rest = issues.filter(function (i) { return i.type === 'rest'; })[0];
      if (rest) {
        var s = getShift(id);
        if (s) restLabels.push(s.label);
      } else if (!otherMsg) {
        otherMsg = issues[0].msg;
      }
    });
    if (restLabels.length) {
      box.className = 'sheet-rule-box info';
      box.innerHTML = '<strong>💡 Descanso de 11h:</strong> turnos <strong>' + escapeHtml(restLabels.join(', ')) + '</strong> conflitam com dia vizinho.';
    } else if (otherMsg) {
      box.className = 'sheet-rule-box info';
      box.innerHTML = '<strong>💡 Regra:</strong> ' + escapeHtml(otherMsg);
    } else {
      box.className = 'sheet-rule-box hidden';
      box.innerHTML = '';
    }
  }

  function openSheet(emp, dateStr) {
    hideFEHoverTip();
    sheetCtx = { emp: emp, date: dateStr };
    var d = new Date(dateStr + 'T00:00:00');
    sheetTitle.textContent = emp;
    sheetSub.textContent = fmtLong(d);
    var cur = (state.schedule[dateStr] || {})[emp] || '';
    var workIds = Object.keys(state.shifts).filter(function (k) { return state.shifts[k].type === 'work'; });
    workIds.sort(function (a, b) { return parseTime(state.shifts[a].start) - parseTime(state.shifts[b].start); });
    var eventIds = Object.keys(state.shifts).filter(function (k) { return state.shifts[k].type === 'event'; });

    if (workIds.length) {
      workShiftGrid.style.display = 'grid'; workSectionTitle.style.display = 'block';
      workShiftGrid.innerHTML = workIds.map(function (id) { return buildWorkShiftBtn(id, cur, emp, dateStr); }).join('');
    } else { workShiftGrid.style.display = 'none'; workSectionTitle.style.display = 'none'; }

    if (eventIds.length) {
      eventShiftGrid.style.display = 'grid'; eventSectionTitle.style.display = 'block';
      eventShiftGrid.innerHTML = eventIds.map(function (id) { return buildEventPillBtn(id, cur, emp, dateStr); }).join('');
    } else { eventShiftGrid.style.display = 'none'; eventSectionTitle.style.display = 'none'; }

    if (sheetClear) sheetClear.style.display = cur ? 'inline-flex' : 'none';
    renderSheetNeighbors(emp, dateStr);
    renderSheetRuleHint(emp, dateStr, cur, workIds);

    var dayNoteItems = getNotes(dateStr).filter(function (n) { return n.emp === emp || !n.emp; });
    sheetNoteState.editingId = null;
    sheetNoteState.composing = (window.innerWidth >= 768 && dayNoteItems.length === 0);

    $('noteScope').innerHTML = '<option value="emp">Só ' + escapeHtml(emp) + '</option><option value="day">Dia inteiro (time)</option>';
    $('noteInput').value = ''; $('noteImportant').checked = false;
    renderSheetNotes();
    sheet.classList.add('open'); sheetBackdrop.classList.add('open');
  }

  function closeSheet() {
    sheet.classList.remove('open');
    sheetBackdrop.classList.remove('open');
    sheetCtx = null;
    sheetNoteState.editingId = null;
    sheetNoteState.composing = false;
  }

  function commitShift(emp, date, code) {
    if (!state.schedule[date]) state.schedule[date] = {};
    if (code) state.schedule[date][emp] = code;
    else delete state.schedule[date][emp];
    if (Object.keys(state.schedule[date]).length === 0) delete state.schedule[date];
    if (isHoliday(date)) syncAllAutoFENotes();
    else syncAutoFENotes(emp);
    save(); closeSheet(); renderActive();
    toast(code ? 'Turno aplicado' : 'Célula limpa');
  }

  function commitShiftAllTeam(date, code) {
    if (!state.schedule[date]) state.schedule[date] = {};
    state.employees.forEach(function (emp) {
      state.schedule[date][emp] = code;
    });
    syncAllAutoFENotes();
    save(); closeSheet(); renderActive();
    toast('Aplicado para toda a equipe');
  }

  function applyShift(code) {
    if (!sheetCtx) return;
    var emp = sheetCtx.emp, date = sheetCtx.date;
    if (isClosedStoreEvent(code)) {
      var othersDiff = state.employees.some(function (e) {
        return e !== emp && ((state.schedule[date] || {})[e] || '') !== code;
      });
      if (othersDiff) {
        var evName = getShift(code).name;
        showDialog({
          title: '🏬 ' + evName,
          body: '<strong>' + escapeHtml(fmtLong(new Date(date + 'T00:00:00'))) + '</strong><br><br>Deseja aplicar <strong>' + escapeHtml(evName) + '</strong> para toda a equipe neste dia?',
          confirmText: 'Toda a equipe',
          isDanger: false,
          extraText: 'Só ' + emp,
          onConfirm: function () { commitShiftAllTeam(date, code); },
          onExtra: function () { commitShift(emp, date, code); }
        });
        return;
      }
    }
    if (code === 'FE' || isWorkShift(code)) {
      var ws = getWarningsForCell(emp, date, code);
      if (ws.length) {
        var list = ws.map(function (w) { return '• ' + w; }).join('<br>');
        showDialog({
          title: '⚠ Conflito com as regras',
          body: '<strong>' + emp + ' · ' + fmtLong(new Date(date + 'T00:00:00')) + '</strong><br><br>' + list,
          confirmText: 'Aplicar mesmo assim', isDanger: true,
          onConfirm: function () { commitShift(emp, date, code); }
        });
        return;
      }
    }
    commitShift(emp, date, code);
  }

  function autoFill() {
    var y = currentDate.getFullYear(), m = currentDate.getMonth();
    var n = daysInMonth(currentDate);
    showDialog({
      title: '⚡ Gerar Escala Automática',
      body: '<p style="margin-top:0">Preencher a escala de <strong>' + MONTHS[m] + ' ' + y + '</strong>?</p><ul style="padding-left:18px;font-size:12.5px;color:#475569;margin:8px 0 14px"><li>Horários padrão (Seg a Sáb) serão preenchidos.</li><li>Domingos e folgas ficam em branco.</li></ul><div style="background:#fef2f2;padding:10px 12px;border-radius:8px;border:1px solid #fecaca;color:#991b1b;font-size:12px;font-weight:600">⚠ Células existentes serão substituídas.</div>',
      confirmText: 'Confirmar', isDanger: false,
      onConfirm: function () {
        for (var d = 1; d <= n; d++) delete state.schedule[dateKey(y, m, d)];
        for (var d2 = 1; d2 <= n; d2++) {
          var dow = new Date(y, m, d2).getDay();
          if (dow === 0) continue;
          var key = dateKey(y, m, d2); state.schedule[key] = {};
          state.employees.forEach(function (emp) {
            var def = state.defaultShift[emp];
            if (def && isWorkShift(def)) state.schedule[key][emp] = def;
          });
          if (Object.keys(state.schedule[key]).length === 0) delete state.schedule[key];
        }
        syncAllAutoFENotes();
        save(); renderActive(); toast('Escala gerada.');
      }
    });
  }

  function buildCSV() {
    var y = currentDate.getFullYear(), m = currentDate.getMonth();
    var n = daysInMonth(currentDate);
    var lines = [], head = ['Colaborador'];
    for (var d = 1; d <= n; d++) head.push(d);
    lines.push(head.join(','));
    state.employees.forEach(function (emp) {
      var r = [emp];
      for (var d = 1; d <= n; d++) r.push((state.schedule[dateKey(y, m, d)] || {})[emp] || '');
      lines.push(r.join(','));
    });
    lines.push('', '#CONFIG_BEGIN');
    lines.push(JSON.stringify({ teamName: state.teamName, employees: state.employees, shifts: state.shifts, defaultShift: state.defaultShift, employeeScale: state.employeeScale, holidays: state.holidays, colors: state.colors, sundayRule: state.sundayRule, limits: state.limits, notes: state.notes }));
    lines.push('#CONFIG_END');
    return lines.join('\n');
  }

  function downloadCSV() {
    var text = buildCSV();
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'escala-' + state.teamName.replace(/\s+/g, '-').toLowerCase() + '-' + currentDate.getFullYear() + '-' + pad(currentDate.getMonth() + 1) + '.csv';
    a.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function importBackup(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var text = e.target.result;
      var cs = text.indexOf('#CONFIG_BEGIN'), ce = text.indexOf('#CONFIG_END');
      if (cs !== -1 && ce !== -1) {
        try {
          var parsed = JSON.parse(text.substring(cs + 13, ce).trim());
          if (parsed.teamName) state.teamName = parsed.teamName;
          if (parsed.employees) state.employees = parsed.employees;
          if (parsed.shifts) state.shifts = parsed.shifts;
          if (parsed.defaultShift) state.defaultShift = parsed.defaultShift;
          if (parsed.employeeScale) state.employeeScale = parsed.employeeScale;
          if (parsed.holidays) state.holidays = parsed.holidays;
          if (parsed.colors) state.colors = parsed.colors;
          if (parsed.sundayRule) state.sundayRule = parsed.sundayRule;
          if (parsed.limits) state.limits = parsed.limits;
          if (parsed.notes) state.notes = parsed.notes;
        } catch (err) { console.warn(err); }
        text = text.substring(0, cs);
      }
      var lines = text.trim().split(/\r?\n/);
      if (lines.length < 2) return toast('Arquivo inválido.');
      var sep = lines[0].indexOf(';') !== -1 ? ';' : (lines[0].indexOf('\t') !== -1 ? '\t' : ',');
      var y = currentDate.getFullYear(), m = currentDate.getMonth(), n = daysInMonth(currentDate);
      for (var d = 1; d <= n; d++) delete state.schedule[dateKey(y, m, d)];
      var imported = false;
      for (var i = 1; i < lines.length; i++) {
        var row = lines[i].split(sep).map(function (s) { return s.replace(/"/g, '').trim(); });
        if (!row.length) continue;
        var emp = row[0];
        if (state.employees.indexOf(emp) === -1) continue;
        imported = true;
        for (var d2 = 1; d2 <= n; d2++) {
          var code = row[d2];
          if (code) {
            var key = dateKey(y, m, d2);
            if (!state.schedule[key]) state.schedule[key] = {};
            state.schedule[key][emp] = code;
          }
        }
      }
      if (!imported) return toast('Nenhum colaborador reconhecido.');
      syncAllAutoFENotes();
      save(); renderActive(); toast('Backup restaurado!');
    };
    reader.readAsText(file);
  }

  function addEmployee() {
    var base = 'Novo', name = base, i = 1;
    while (state.employees.indexOf(name) !== -1) name = base + ' ' + (++i);
    state.employees.push(name);
    var first = Object.keys(state.shifts).find(function (k) { return state.shifts[k].type === 'work'; });
    if (first) state.defaultShift[name] = first;
    if (!state.employeeScale) state.employeeScale = {};
    state.employeeScale[name] = '6x1';
    save(); renderActive(); toast('Colaborador adicionado');
  }

  function renameEmployee(oldName, newName) {
    newName = (newName || '').trim();
    if (!newName || newName === oldName) return false;
    if (state.employees.indexOf(newName) !== -1) { toast('Já existe um colaborador com esse nome'); return false; }
    var idx = state.employees.indexOf(oldName);
    if (idx === -1) return false;
    state.employees[idx] = newName;
    Object.keys(state.schedule).forEach(function (date) {
      var d = state.schedule[date];
      if (d[oldName] !== undefined) { d[newName] = d[oldName]; delete d[oldName]; }
    });
    if (state.defaultShift[oldName] !== undefined) { state.defaultShift[newName] = state.defaultShift[oldName]; delete state.defaultShift[oldName]; }
    if (state.employeeScale && state.employeeScale[oldName] !== undefined) { state.employeeScale[newName] = state.employeeScale[oldName]; delete state.employeeScale[oldName]; }
    Object.keys(state.notes || {}).forEach(function (date) {
      state.notes[date].forEach(function (n) { if (n.emp === oldName) n.emp = newName; });
    });
    save(); return true;
  }

  function deleteEmployee(name) {
    var hasSchedule = Object.keys(state.schedule).some(function (date) { return state.schedule[date][name] !== undefined; });
    var doDelete = function () {
      state.employees = state.employees.filter(function (e) { return e !== name; });
      Object.keys(state.schedule).forEach(function (date) {
        if (state.schedule[date][name] !== undefined) {
          delete state.schedule[date][name];
          if (Object.keys(state.schedule[date]).length === 0) delete state.schedule[date];
        }
      });
      Object.keys(state.notes || {}).forEach(function (date) {
        state.notes[date] = state.notes[date].filter(function (n) { return n.emp !== name; });
        if (!state.notes[date].length) delete state.notes[date];
      });
      delete state.defaultShift[name];
      if (state.employeeScale) delete state.employeeScale[name];
      save(); renderActive(); toast('Colaborador removido');
    };
    if (hasSchedule) {
      showDialog({ title: 'Remover Colaborador', body: name + ' tem escalas registradas. Ao remover, todas as escalas dele serão apagadas. Continuar?', confirmText: 'Remover', isDanger: true, onConfirm: doDelete });
    } else doDelete();
  }

  function addWorkShift() {
    var candidates = ['08:00', '11:00', '12:00', '13:00', '15:00', '17:00', '19:00', '20:00', '21:00', '05:00', '23:00'];
    var start = candidates.find(function (t) { return !state.shifts[t]; });
    if (!start) {
      for (var h = 0; h < 24; h++) { var t = pad(h) + ':00'; if (!state.shifts[t]) { start = t; break; } }
    }
    if (!start) return toast('Sem horários disponíveis');
    var startMin = parseTime(start), endMin = (startMin + 500) % 1440;
    state.shifts[start] = { type: 'work', label: start.split(':')[0], name: start + ' – ' + fmtMin(endMin), start: start, end: fmtMin(endMin), color: '#f1f5f9', text: '#0f172a' };
    save(); renderActive(); toast('Turno adicionado');
  }

  function addEvent() {
    var base = 'E', code = base, i = 1;
    while (state.shifts[code]) code = base + (++i);
    state.shifts[code] = { type: 'event', label: code, name: 'Novo evento', color: '#e2e8f0', text: '#0f172a' };
    save(); renderActive(); toast('Evento adicionado');
  }

  function deleteShift(id) {
    var doDelete = function () {
      delete state.shifts[id];
      Object.keys(state.schedule).forEach(function (date) {
        var d = state.schedule[date];
        Object.keys(d).forEach(function (emp) { if (d[emp] === id) delete d[emp]; });
        if (Object.keys(d).length === 0) delete state.schedule[date];
      });
      Object.keys(state.defaultShift).forEach(function (emp) {
        if (state.defaultShift[emp] === id) {
          var first = Object.keys(state.shifts).find(function (k) { return state.shifts[k].type === 'work'; });
          if (first) state.defaultShift[emp] = first;
          else delete state.defaultShift[emp];
        }
      });
      save(); renderActive(); toast('Turno removido');
    };
    if (isShiftInUse(id)) {
      showDialog({ title: 'Remover Turno', body: 'Este turno está em uso. As células que o usam ficarão vazias. Continuar?', confirmText: 'Remover', isDanger: true, onConfirm: doDelete });
    } else doDelete();
  }

  function updateShiftField(id, field, value) {
    var s = state.shifts[id]; if (!s) return;
    if (field === 'start' && s.type === 'work') {
      var newId = value;
      if (state.shifts[newId] && newId !== id) { toast('Já existe um turno com este horário'); renderActive(); return; }
      var doRename = function () {
        s.start = newId; s.name = newId + ' – ' + s.end;
        delete state.shifts[id]; state.shifts[newId] = s;
        Object.keys(state.schedule).forEach(function (date) {
          var d = state.schedule[date];
          Object.keys(d).forEach(function (emp) { if (d[emp] === id) d[emp] = newId; });
        });
        Object.keys(state.defaultShift).forEach(function (emp) { if (state.defaultShift[emp] === id) state.defaultShift[emp] = newId; });
        save(); renderActive(); toast('Turno atualizado');
      };
      if (isShiftInUse(id)) {
        showDialog({ title: 'Alterar Início do Turno', body: 'Este turno está em uso. As referências serão atualizadas automaticamente. Continuar?', confirmText: 'Continuar', isDanger: false, onConfirm: doRename });
      } else doRename();
      return;
    }
    s[field] = value;
    if (field === 'color') s.text = getContrastColor(value);
    if (field === 'end' && s.type === 'work') s.name = s.start + ' – ' + value;
    save();
  }

  function setPrintOrientation(mode) {
    var st = document.getElementById('printPageStyle');
    if (!st) { st = document.createElement('style'); st.id = 'printPageStyle'; document.head.appendChild(st); }
    st.textContent = mode === 'portrait'
      ? '@page { size: A4 portrait; margin: 10mm; }'
      : '@page { size: A4 landscape; margin: 8mm; }';
  }

  // ==========================================
  // IMPRESSÃO POR PERÍODO (data início / fim)
  // ==========================================
  function getDefaultRangeForView() {
    if (activeView === 'week') {
      var ws = getWeekStart(currentDate);
      var we = new Date(ws); we.setDate(we.getDate() + 6);
      return { start: keyOf(ws), end: keyOf(we) };
    }
    var y = currentDate.getFullYear(), m = currentDate.getMonth();
    return { start: dateKey(y, m, 1), end: dateKey(y, m, daysInMonth(currentDate)) };
  }

  function formatRangeLabel(startStr, endStr) {
    var d1 = new Date(startStr + 'T00:00:00');
    var d2 = new Date(endStr + 'T00:00:00');
    if (startStr === endStr) {
      return d1.getDate() + ' ' + MONTHS[d1.getMonth()].slice(0, 3) + ' ' + d1.getFullYear();
    }
    if (d1.getMonth() === d2.getMonth() && d1.getFullYear() === d2.getFullYear()) {
      return d1.getDate() + ' – ' + d2.getDate() + ' ' + MONTHS[d1.getMonth()].slice(0, 3) + ' ' + d1.getFullYear();
    }
    return d1.getDate() + ' ' + MONTHS[d1.getMonth()].slice(0, 3) +
           ' – ' + d2.getDate() + ' ' + MONTHS[d2.getMonth()].slice(0, 3) +
           ' ' + d2.getFullYear();
  }

  function doPrintRange(startStr, endStr, withNotes) {
    var originalView = activeView;

    // Gera a grade do intervalo no container do mês
    _exporting = true;
    try {
      renderRange(startStr, endStr, { notes: withNotes });
    } finally {
      _exporting = false;
    }

    // Força view "month" (o CSS de print reaproveita o layout grid-table)
    activeView = 'month';
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.view === 'month');
    });
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('active', v.id === 'view-month');
    });

    var dayCount = Math.round((new Date(endStr + 'T00:00:00') - new Date(startStr + 'T00:00:00')) / 86400000) + 1;
    // <= 10 dias: melhor retrato; senão paisagem (mais colunas cabem)
    setPrintOrientation(dayCount <= 10 ? 'portrait' : 'landscape');

    $('printTeam').textContent = state.teamName;
    $('printPeriod').textContent = formatRangeLabel(startStr, endStr);
    $('printFooter').textContent = 'Gerado em ' + new Date().toLocaleString('pt-BR');

    var restore = function () {
      window.removeEventListener('afterprint', restore);
      applyTheme();
      switchToView(originalView);
    };
    window.addEventListener('afterprint', restore);

    setTimeout(function () { document.documentElement.removeAttribute('data-theme'); window.print(); }, 100);
  }

  function requestPrint() {
    if (!state.employees || state.employees.length === 0) {
      toast('Nenhum colaborador para imprimir.');
      return;
    }
    var def = getDefaultRangeForView();

    showDialog({
      title: 'Imprimir escala',
      body:
        '<div style="margin-bottom:12px">' +
          '<label class="png-label">Período</label>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
            '<div>' +
              '<input type="date" id="printStartDate" class="png-date-input" value="' + def.start + '">' +
              '<span style="display:block;font-size:10.5px;color:var(--muted);margin-top:3px;text-align:center">Início</span>' +
            '</div>' +
            '<div>' +
              '<input type="date" id="printEndDate" class="png-date-input" value="' + def.end + '">' +
              '<span style="display:block;font-size:10.5px;color:var(--muted);margin-top:3px;text-align:center">Fim</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">' +
          '<button type="button" class="png-preset" data-print-preset="week">Semana atual</button>' +
          '<button type="button" class="png-preset" data-print-preset="month">Mês atual</button>' +
          '<button type="button" class="png-preset" data-print-preset="next7">Próximos 7 dias</button>' +
        '</div>' +
        '<label class="note-imp" style="display:flex;margin-bottom:12px"><input type="checkbox" id="printNotes" checked> Incluir anotações do período</label>' +
        '<div style="padding:8px 10px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:7px;font-size:11px;color:#1e3a8a;line-height:1.45">' +
          '💡 <strong>Impressão</strong> gera a grade da escala em papel. Para uma imagem (WhatsApp), use o botão <strong>Exportar PNG</strong>.' +
        '</div>' +
        '<div id="printRangeHint" style="font-size:11.5px;color:var(--muted);margin-top:8px;text-align:center;min-height:16px"></div>',
      confirmText: 'Imprimir',
      cancelText: 'Cancelar',
      isDanger: false,
      onConfirm: function () {
        var startEl = document.getElementById('printStartDate');
        var endEl = document.getElementById('printEndDate');
        if (!startEl || !endEl) return false;
        var start = startEl.value, end = endEl.value;
        if (!start || !end) { toast('Preencha as duas datas.'); return false; }
        if (start > end) { toast('A data final deve ser depois do início.'); return false; }
        var d1 = new Date(start + 'T00:00:00');
        var d2 = new Date(end + 'T00:00:00');
        var days = Math.round((d2 - d1) / 86400000) + 1;
        if (days > 62) { toast('Máximo de 62 dias por impressão.'); return false; }
        var pn = document.getElementById('printNotes');
        var printWithNotes = pn ? pn.checked : true;
        setTimeout(function () { doPrintRange(start, end, printWithNotes); }, 80);
        return true;
      }
    });

    // Presets + hint no diálogo de impressão
    var hint = document.getElementById('printRangeHint');
    var startInp = document.getElementById('printStartDate');
    var endInp = document.getElementById('printEndDate');

    function updateHint() {
      if (!hint || !startInp || !endInp) return;
      if (!startInp.value || !endInp.value || startInp.value > endInp.value) { hint.textContent = ''; return; }
      var a = new Date(startInp.value + 'T00:00:00');
      var b = new Date(endInp.value + 'T00:00:00');
      var days = Math.round((b - a) / 86400000) + 1;
      hint.textContent = days + ' dia' + (days > 1 ? 's' : '') + ' selecionado' + (days > 1 ? 's' : '');
    }
    if (startInp) startInp.addEventListener('change', updateHint);
    if (endInp) endInp.addEventListener('change', updateHint);
    updateHint();

    // Escopo os presets ao dialogBody para evitar conflito com o de PNG
    document.querySelectorAll('#dialogBody [data-print-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var preset = btn.dataset.printPreset;
        var s, e;
        if (preset === 'week') {
          var ws = getWeekStart(currentDate);
          var we = new Date(ws); we.setDate(we.getDate() + 6);
          s = keyOf(ws); e = keyOf(we);
        } else if (preset === 'month') {
          var y = currentDate.getFullYear(), m = currentDate.getMonth();
          s = dateKey(y, m, 1); e = dateKey(y, m, daysInMonth(currentDate));
        } else if (preset === 'next7') {
          var now = new Date();
          s = keyOf(now);
          var e7 = new Date(now); e7.setDate(e7.getDate() + 6);
          e = keyOf(e7);
        }
        if (startInp) startInp.value = s;
        if (endInp) endInp.value = e;
        updateHint();
      });
    });
  }

  // ==========================================
  // EXPORTAÇÃO DE IMAGEM (PNG) POR INTERVALO
  // ==========================================
  function canShareFiles() {
    try {
      if (!navigator.canShare || typeof File === 'undefined') return false;
      var testFile = new File(['test'], 'test.png', { type: 'image/png' });
      return navigator.canShare({ files: [testFile] });
    } catch (e) {
      return false;
    }
  }

  function requestPNGExport() {
    if (typeof html2canvas === 'undefined') {
      toast('Biblioteca de exportação não carregou.');
      return;
    }
    if (!state.employees || state.employees.length === 0) {
      toast('Nenhum colaborador para exportar.');
      return;
    }
    if (_exportBusy) { toast('Aguarde, a imagem anterior ainda está sendo gerada.'); return; }

    var def = getDefaultRangeForView();

    showDialog({
      title: 'Exportar imagem (PNG)',
      body:
        '<div style="margin-bottom:12px">' +
          '<label class="png-label">Período</label>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
            '<div>' +
              '<input type="date" id="pngStartDate" class="png-date-input" value="' + def.start + '">' +
              '<span style="display:block;font-size:10.5px;color:var(--muted);margin-top:3px;text-align:center">Início</span>' +
            '</div>' +
            '<div>' +
              '<input type="date" id="pngEndDate" class="png-date-input" value="' + def.end + '">' +
              '<span style="display:block;font-size:10.5px;color:var(--muted);margin-top:3px;text-align:center">Fim</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">' +
          '<button type="button" class="png-preset" data-preset="week">Semana</button>' +
          '<button type="button" class="png-preset" data-preset="month">Mês</button>' +
          '<button type="button" class="png-preset" data-preset="next7">Próx. 7 dias</button>' +
        '</div>' +
        '<label class="note-imp" style="display:flex;margin-bottom:10px"><input type="checkbox" id="pngNotes" checked> Incluir anotações do período</label>' +
        '<div class="dialog-tip">A imagem é gerada em <strong>PNG</strong>, com qualidade máxima e fundo branco (independente do tema). Depois de gerar, você vê a prévia e escolhe entre compartilhar ou baixar.</div>' +
        '<div id="pngRangeHint" style="font-size:11.5px;color:var(--muted);margin-top:8px;text-align:center;min-height:16px"></div>',
      confirmText: 'Gerar imagem',
      cancelText: 'Cancelar',
      isDanger: false,
      onConfirm: function () {
        var startEl = document.getElementById('pngStartDate');
        var endEl = document.getElementById('pngEndDate');
        if (!startEl || !endEl) return false;
        var start = startEl.value, end = endEl.value;
        if (!start || !end) { toast('Preencha as duas datas.'); return false; }
        if (start > end) { toast('A data final deve ser depois do início.'); return false; }
        var d1 = new Date(start + 'T00:00:00');
        var d2 = new Date(end + 'T00:00:00');
        var days = Math.round((d2 - d1) / 86400000) + 1;
        if (days > 62) { toast('Máximo de 62 dias por exportação.'); return false; }
        var pnn = document.getElementById('pngNotes');
        var withNotes = pnn ? pnn.checked : true;
        setTimeout(function () { exportImageRange(start, end, withNotes); }, 60);
        return true;
      }
    });

    var hint = document.getElementById('pngRangeHint');
    var startInp = document.getElementById('pngStartDate');
    var endInp = document.getElementById('pngEndDate');

    function updateHint() {
      if (!hint || !startInp || !endInp) return;
      if (!startInp.value || !endInp.value || startInp.value > endInp.value) { hint.textContent = ''; return; }
      var a = new Date(startInp.value + 'T00:00:00');
      var b = new Date(endInp.value + 'T00:00:00');
      var days = Math.round((b - a) / 86400000) + 1;
      hint.textContent = days + ' dia' + (days > 1 ? 's' : '') + ' selecionado' + (days > 1 ? 's' : '');
    }
    if (startInp) startInp.addEventListener('change', updateHint);
    if (endInp) endInp.addEventListener('change', updateHint);
    updateHint();

    document.querySelectorAll('#dialogBody [data-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var preset = btn.dataset.preset;
        var s, e;
        if (preset === 'week') {
          var ws = getWeekStart(currentDate);
          var we = new Date(ws); we.setDate(we.getDate() + 6);
          s = keyOf(ws); e = keyOf(we);
        } else if (preset === 'month') {
          var y = currentDate.getFullYear(), m = currentDate.getMonth();
          s = dateKey(y, m, 1); e = dateKey(y, m, daysInMonth(currentDate));
        } else if (preset === 'next7') {
          var now = new Date();
          s = keyOf(now);
          var e7 = new Date(now); e7.setDate(e7.getDate() + 6);
          e = keyOf(e7);
        }
        if (startInp) startInp.value = s;
        if (endInp) endInp.value = e;
        updateHint();
      });
    });
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.download = filename;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  var _exportBusy = false;

  // Tela de resultado: prévia + compartilhar/baixar (o clique cria um gesto novo, exigido pelo navegador para compartilhar)
  function showImageResult(blob, filename, periodStr, w, h) {
    var url = URL.createObjectURL(blob);
    var canShare = canShareFiles();
    var kb = Math.round(blob.size / 1024);
    var sizeLabel = kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB';
    showDialog({
      title: 'Imagem pronta',
      body:
        '<div class="png-preview"><img src="' + url + '" alt="Pré-visualização da escala"></div>' +
        '<div class="png-meta">' + escapeHtml(periodStr) + ' · ' + w + '×' + h + ' px · ' + sizeLabel + '</div>' +
        (canShare
          ? '<button type="button" class="png-preset" id="pngDownloadBtn" style="width:100%;margin-top:10px;padding:10px">Baixar PNG</button>' +
            '<div class="dialog-tip">Compartilhando direto, o WhatsApp recebe o arquivo original, sem recompressão.</div>'
          : '<div class="dialog-tip"><strong>Dica WhatsApp:</strong> ao enviar o arquivo baixado, toque em <strong>+ → Documento</strong> (não em "Foto") para evitar a compressão.</div>'),
      confirmText: canShare ? 'Compartilhar' : 'Baixar PNG',
      cancelText: 'Fechar',
      isDanger: false,
      onOpen: function () {
        var b = document.getElementById('pngDownloadBtn');
        if (b) b.addEventListener('click', function () {
          downloadBlob(blob, filename);
          toast('✓ Imagem baixada');
          $('dialogCancel').click();
        });
      },
      onCancel: function () { setTimeout(function () { URL.revokeObjectURL(url); }, 500); },
      onConfirm: function () {
        if (canShare) {
          var file = new File([blob], filename, { type: 'image/png' });
          navigator.share({ files: [file], title: 'Escala ' + state.teamName, text: 'Escala ' + state.teamName + ' (' + periodStr + ')' })
            .then(function () { toast('✓ Compartilhado com qualidade original'); })
            .catch(function (err) {
              if (err && err.name === 'AbortError') return;
              console.warn('[Share] Falhou, usando download:', err);
              downloadBlob(blob, filename);
              toast('✓ Imagem baixada');
            });
        } else {
          downloadBlob(blob, filename);
          toast('✓ Imagem baixada');
        }
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        return true;
      }
    });
  }

  async function exportImageRange(startStr, endStr, withNotes) {
    if (typeof html2canvas === 'undefined') {
      toast('Biblioteca de exportação não disponível.');
      return;
    }
    if (!state.employees || state.employees.length === 0) {
      toast('Nenhum colaborador para exportar.');
      return;
    }
    if (startStr > endStr) {
      toast('Intervalo inválido.');
      return;
    }
    if (_exportBusy) return;
    _exportBusy = true;
    toast('Gerando imagem...');

    var d1 = new Date(startStr + 'T00:00:00');
    var d2 = new Date(endStr + 'T00:00:00');
    var dayCount = Math.round((d2 - d1) / 86400000) + 1;
    var periodStr = formatRangeLabel(startStr, endStr);
    var width = Math.max(1000, 130 + dayCount * 60 + 60);

    var wrapper = document.createElement('div');
    wrapper.className = 'png-export-wrapper';
    wrapper.style.width = width + 'px';

    var header = document.createElement('div');
    header.className = 'png-export-header';
    header.innerHTML = '<div class="png-export-team">' + escapeHtml(state.teamName) + '</div>' +
                       '<div class="png-export-period">' + escapeHtml(periodStr) + '</div>';

    var content = document.createElement('div');
    content.className = 'view active';

    wrapper.appendChild(header);
    wrapper.appendChild(content);
    document.body.appendChild(wrapper);

    var originalMonth = viewMonth;
    _exporting = true;

    try {
      try {
        viewMonth = content;
        renderRange(startStr, endStr, { notes: withNotes });
      } finally {
        viewMonth = originalMonth;
      }

      try {
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
      } catch (e) {}

      await new Promise(function (resolve) {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { setTimeout(resolve, 150); });
        });
      });

      // Escala adaptativa: 3x quando cabe; reduz em períodos longos para não estourar o limite de canvas (principalmente no iPhone)
      var rect = wrapper.getBoundingClientRect();
      var cw = Math.max(1, Math.ceil(rect.width)), ch = Math.max(1, Math.ceil(rect.height));
      var scale = Math.min(3, Math.sqrt(15000000 / (cw * ch)), 8000 / Math.max(cw, ch));
      scale = Math.max(1, Math.round(scale * 100) / 100);

      var canvas = await html2canvas(wrapper, {
        backgroundColor: '#ffffff',
        scale: scale,
        useCORS: true,
        logging: false,
        imageTimeout: 0,
        allowTaint: false,
        // a imagem sai sempre com o visual claro, mesmo com o tema escuro ativo
        onclone: function (doc) { doc.documentElement.removeAttribute('data-theme'); }
      });

      var blob = await new Promise(function (resolve) {
        canvas.toBlob(function (b) { resolve(b); }, 'image/png');
      });
      if (!blob) throw new Error('Falha ao gerar blob');

      var safeName = (state.teamName || 'equipe').replace(/[^\w\-]+/g, '-').toLowerCase();
      var filename = 'escala-' + safeName + '-' + startStr + '_' + endStr + '.png';

      showImageResult(blob, filename, periodStr, canvas.width, canvas.height);
    } catch (err) {
      console.error('[Image Export] Erro:', err);
      toast('Erro ao gerar imagem. Tente um período menor.');
    } finally {
      _exporting = false;
      _exportBusy = false;
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    }
  }

  // ==========================================
  // EVENTOS DA UI
  // ==========================================
  $('prevBtn').addEventListener('click', function () {
    if (activeView === 'week') currentDate = new Date(currentDate.getTime() - 7 * 86400000);
    else currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1);
    drawerState.day = ''; drawerState.editing = null;
    renderActive();
  });
  $('nextBtn').addEventListener('click', function () {
    if (activeView === 'week') currentDate = new Date(currentDate.getTime() + 7 * 86400000);
    else currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
    drawerState.day = ''; drawerState.editing = null;
    renderActive();
  });
  tabsEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.tab'); if (!btn) return;
    switchToView(btn.dataset.view);
  });
  $('printBtn').addEventListener('click', requestPrint);
  $('pngBtn').addEventListener('click', requestPNGExport);

  var feHoverTipEl = $('feHoverTip');
  var feHoverTarget = null;
  function hideFEHoverTip() {
    feHoverTarget = null;
    if (!feHoverTipEl) return;
    feHoverTipEl.classList.remove('show', 'below');
    feHoverTipEl.setAttribute('aria-hidden', 'true');
  }
  function showFEHoverTip(cell) {
    if (!feHoverTipEl || !cell) return;
    var emp = cell.dataset.emp, date = cell.dataset.date;
    var info = getFERefInfo(emp, date);
    if (!info) { hideFEHoverTip(); return; }
    feHoverTarget = cell;
    feHoverTipEl.innerHTML =
      '<div class="fe-tip-head">' +
        '<span class="fe-tip-title">🏖 Folga de Feriado</span>' +
        '<span class="fe-tip-pill ' + info.status + '">' + escapeHtml(info.badge) + '</span>' +
      '</div>' +
      '<div class="fe-tip-hol">Ref.: ' + escapeHtml(info.holLabel) + '</div>' +
      '<div class="fe-tip-sub">' + escapeHtml(info.sub) + '</div>';
    feHoverTipEl.classList.remove('below');
    feHoverTipEl.classList.add('show');
    feHoverTipEl.setAttribute('aria-hidden', 'false');
    var rect = cell.getBoundingClientRect();
    var tipRect = feHoverTipEl.getBoundingClientRect();
    var vw = window.innerWidth || document.documentElement.clientWidth || 1024;
    var left = Math.round(rect.left + rect.width / 2 - tipRect.width / 2);
    left = Math.max(8, Math.min(left, vw - tipRect.width - 8));
    var top = Math.round(rect.top - tipRect.height - 10);
    if (top < 8) {
      top = Math.round(rect.bottom + 10);
      feHoverTipEl.classList.add('below');
    }
    feHoverTipEl.style.left = left + 'px';
    feHoverTipEl.style.top = top + 'px';
  }
  [viewWeek, viewMonth].forEach(function (vEl) {
    vEl.addEventListener('pointerover', function (e) {
      var cell = e.target.closest('[data-fe-ref]');
      if (!cell) return;
      if (cell !== feHoverTarget) showFEHoverTip(cell);
    });
    vEl.addEventListener('pointerout', function (e) {
      var cell = e.target.closest('[data-fe-ref]');
      if (!cell) return;
      if (e.relatedTarget && cell.contains(e.relatedTarget)) return;
      if (feHoverTarget === cell) hideFEHoverTip();
    });
    vEl.addEventListener('focusin', function (e) {
      var cell = e.target.closest('[data-fe-ref]');
      if (cell) showFEHoverTip(cell);
    });
    vEl.addEventListener('focusout', function (e) {
      var cell = e.target.closest('[data-fe-ref]');
      if (cell && feHoverTarget === cell) hideFEHoverTip();
    });
  });
  window.addEventListener('scroll', hideFEHoverTip, true);
  window.addEventListener('resize', hideFEHoverTip);

  viewWeek.addEventListener('click', function (e) {
    hideFEHoverTip();
    var op = e.target.closest('[data-open-drawer]');
    if (op) { openNotesDrawer({ filter: op.dataset.openDrawer === 'alerts' ? 'alerts' : 'all', day: '' }); return; }
    var head = e.target.closest('.wk-day-head.col-has-note');
    if (head && head.dataset.dayKey) { openNotesDrawer({ filter: 'all', day: head.dataset.dayKey }); return; }
    var missHead = e.target.closest('.wk-day-head.missing-essential');
    if (missHead) { openNotesDrawer({ filter: 'alerts', day: '' }); return; }
    var cell = e.target.closest('.wk-cell');
    if (cell) openSheet(cell.dataset.emp, cell.dataset.date);
  });
  viewMonth.addEventListener('click', function (e) {
    hideFEHoverTip();
    var op = e.target.closest('[data-open-drawer]');
    if (op) { openNotesDrawer({ filter: op.dataset.openDrawer === 'alerts' ? 'alerts' : 'all', day: '' }); return; }
    var th = e.target.closest('thead th.col-has-note');
    if (th && th.dataset.dayKey) { openNotesDrawer({ filter: 'all', day: th.dataset.dayKey }); return; }
    var missTh = e.target.closest('thead th.missing-essential');
    if (missTh) { openNotesDrawer({ filter: 'alerts', day: '' }); return; }
    var td = e.target.closest('td.cell');
    if (td) openSheet(td.dataset.emp, td.dataset.date);
  });
  workShiftGrid.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-code]'); if (btn) applyShift(btn.dataset.code);
  });
  eventShiftGrid.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-code]'); if (btn) applyShift(btn.dataset.code);
  });
  sheetClear.addEventListener('click', function () { applyShift(''); });
  sheetBackdrop.addEventListener('click', closeSheet);

  viewSettings.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'teamNameInput') {
      var newTeamName = t.value.trim() || 'Equipe';
      t.value = newTeamName;
      state.teamName = newTeamName;
      if (currentTeam) {
        currentTeam.name = newTeamName;
        userTeams.forEach(function (ut) { if (ut && ut.id === currentTeam.id) ut.name = newTeamName; });
        sb.from('teams').update({ name: newTeamName }).eq('id', currentTeam.id).then(function () {});
      }
      updateHeaderUI();
      var badge = $('settingsTeamBadge');
      if (badge) badge.textContent = newTeamName;
      save();
      toast('Nome do time atualizado');
      return;
    }
    if (t.matches('.limit-config')) { if (!state.limits) state.limits = {}; state.limits[t.dataset.key] = parseInt(t.value, 10); save(); renderActive(); return; }
    if (t.matches('.sun-rule-config')) { state.sundayRule[t.dataset.key] = parseInt(t.value, 10); save(); return; }
    if (t.matches('.def-shift')) {
      var empDef = (t.closest('[data-emp]') && t.closest('[data-emp]').dataset.emp) || t.dataset.emp;
      if (empDef) { state.defaultShift[empDef] = t.value; save(); }
      return;
    }
    if (t.matches('.emp-scale')) {
      var empScale = (t.closest('[data-emp]') && t.closest('[data-emp]').dataset.emp) || t.dataset.emp;
      if (empScale) { if (!state.employeeScale) state.employeeScale = {}; state.employeeScale[empScale] = t.value; save(); }
      return;
    }
    if (t.matches('.sunday-color')) { state.colors.SUNDAY = { color: t.value, text: getContrastColor(t.value) }; save(); renderActive(); return; }
    if (t.id === 'importFile') { var f = t.files[0]; if (f) importBackup(f); t.value = ''; return; }
  });

  viewSettings.addEventListener('blur', function (e) {
    var t = e.target; if (!t.matches('input')) return;
    var row = t.closest('.edit-row'); if (!row) return;
    if (t.matches('.emp-name')) {
      var oldName = row.dataset.emp, newName = t.value.trim();
      if (newName && newName !== oldName) {
        if (renameEmployee(oldName, newName)) {
          row.dataset.emp = newName;
          var av = row.querySelector('.emp-avatar'); if (av) av.textContent = initialsOf(newName);
          var delB = row.querySelector('[data-del-emp]'); if (delB) delB.dataset.delEmp = newName;
          var ds = row.querySelector('.def-shift'); if (ds) ds.dataset.emp = newName;
          var es = row.querySelector('.emp-scale'); if (es) es.dataset.emp = newName;
          toast('Nome atualizado');
        } else t.value = oldName;
      }
      return;
    }
    if (row.dataset.shift && t.matches('.shift-color, .shift-label, .shift-start, .shift-end, .shift-name-input')) {
      var id = row.dataset.shift; if (!state.shifts[id]) return;
      if (t.matches('.shift-color')) updateShiftField(id, 'color', t.value);
      else if (t.matches('.shift-label')) updateShiftField(id, 'label', t.value);
      else if (t.matches('.shift-start')) updateShiftField(id, 'start', t.value);
      else if (t.matches('.shift-end')) {
        updateShiftField(id, 'end', t.value);
        viewSettings.querySelectorAll('.def-shift option[value="' + id + '"]').forEach(function (op) { op.textContent = state.shifts[id].name; });
      }
      else if (t.matches('.shift-name-input')) updateShiftField(id, 'name', t.value);
    }
  }, true);

  viewSettings.addEventListener('click', function (e) {
    var t = e.target;
    var scatBtn = t.closest('[data-scat]');
    if (scatBtn) { settingsCat = scatBtn.dataset.scat; renderSettings(); return; }
    var themeBtn = t.closest('[data-theme-btn]');
    if (themeBtn) { setThemePref(themeBtn.dataset.themeBtn); return; }
    var actBtn = t.closest('[data-settings-act]');
    if (actBtn) {
      if (actBtn.dataset.settingsAct === 'change-team') window.changeTeam();
      else if (actBtn.dataset.settingsAct === 'logout') window.doLogout();
      return;
    }
    if (t.closest('[data-del-emp]')) { deleteEmployee(t.closest('[data-del-emp]').dataset.delEmp); return; }
    if (t.closest('[data-del-shift]')) { deleteShift(t.closest('[data-del-shift]').dataset.delShift); return; }
    if (t.closest('[data-del-hol]')) { delete state.holidays[t.closest('[data-del-hol]').dataset.delHol]; syncAllAutoFENotes(); save(); renderActive(); return; }
    if (t.closest('#addEmployeeBtn')) { addEmployee(); return; }
    if (t.closest('#addWorkShiftBtn')) { addWorkShift(); return; }
    if (t.closest('#addEventBtn')) { addEvent(); return; }
    if (t.closest('#btnAuto')) { autoFill(); return; }
    if (t.closest('#forceSyncBtn')) {
      pendingSave = true; _syncState = 'pending'; updateStorageStatus();
      doSave().then(function () { if (_syncState === 'synced') toast('✓ Sincronizado'); });
      return;
    }
    if (t.closest('#downloadCsvBtn')) { downloadCSV(); return; }
    if (t.closest('#importBtn')) { document.getElementById('importFile').click(); return; }
    if (t.closest('#addHolBtn')) {
      var d = document.getElementById('newHolDate').value;
      var n = document.getElementById('newHolName').value.trim() || 'Feriado';
      if (d) { state.holidays[d] = n; syncAllAutoFENotes(); save(); renderActive(); }
      return;
    }
    if (t.closest('#clearMonthBtn')) {
      var yC = currentDate.getFullYear(), mC = currentDate.getMonth();
      showDialog({
        title: 'Limpar Escala', body: 'Apagar toda a escala de <strong>' + MONTHS[mC] + ' ' + yC + '</strong>?', confirmText: 'Limpar Tudo', isDanger: true, onConfirm: function () {
          var n = daysInMonth(currentDate);
          for (var d = 1; d <= n; d++) delete state.schedule[dateKey(yC, mC, d)];
          syncAllAutoFENotes(); save(); renderActive(); toast('Mês limpo');
        }
      });
      return;
    }
    if (t.closest('#resetBtn')) {
      showDialog({
        title: 'Apagar Tudo', body: 'Apagar <strong>TODOS os dados</strong>? Ação irreversível.', confirmText: 'Apagar Tudo', isDanger: true, onConfirm: function () {
          state = getDefaultState(); save(); renderActive(); toast('Dados apagados');
        }
      });
      return;
    }
  });

  // ==========================================
  // TEMA (claro / escuro / automático) — preferência salva neste dispositivo
  // ==========================================
  var THEME_KEY = 'escala-theme';
  var ICON_MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  var ICON_SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';

  function getThemePref() {
    try { var v = localStorage.getItem(THEME_KEY); return (v === 'light' || v === 'dark') ? v : 'auto'; } catch (e) { return 'auto'; }
  }
  function systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function isDarkNow() {
    var p = getThemePref();
    return p === 'dark' || (p === 'auto' && systemPrefersDark());
  }
  function applyTheme() {
    var dark = isDarkNow();
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b1220' : '#ffffff');
    var btn = document.getElementById('themeBtn');
    if (btn) {
      btn.innerHTML = dark ? ICON_SUN : ICON_MOON;
      var lbl = dark ? 'Mudar para o tema claro' : 'Mudar para o tema escuro';
      btn.setAttribute('aria-label', lbl); btn.title = lbl;
    }
    var pref = getThemePref();
    document.querySelectorAll('[data-theme-btn]').forEach(function (tb) {
      tb.classList.toggle('active', tb.dataset.themeBtn === pref);
    });
  }
  function setThemePref(p) {
    try { if (p === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, p); } catch (e) {}
    applyTheme();
  }
  $('themeBtn').addEventListener('click', function () { setThemePref(isDarkNow() ? 'light' : 'dark'); });
  if (window.matchMedia) {
    var _mq = window.matchMedia('(prefers-color-scheme: dark)');
    var _mqHandler = function () { if (getThemePref() === 'auto') applyTheme(); };
    if (_mq.addEventListener) _mq.addEventListener('change', _mqHandler); else if (_mq.addListener) _mq.addListener(_mqHandler);
  }
  // Impressão sempre no visual claro (papel)
  window.addEventListener('beforeprint', function () { document.documentElement.removeAttribute('data-theme'); });
  window.addEventListener('afterprint', function () { applyTheme(); });

  // ---------- Alertas: clique leva até o problema ----------
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var go = e.target.closest('.goto-notes');
    if (go) { closeNotesDrawer(); switchToView('notes'); return; }
    var b = e.target.closest('.issue-item');
    if (!b) return;
    var date = b.dataset.date, emp = b.dataset.emp;
    closeNotesDrawer();
    if (b.dataset.act === 'sheet' && emp) { openSheet(emp, date); return; }
    currentDate = new Date(date + 'T00:00:00');
    switchToView('week');
  });

  // ---------- Controle P3 (Resumo + Gaveta) ----------
  viewSummary.addEventListener('click', function (e) {
    var chip = e.target.closest('[data-p3-emp]');
    if (chip) { summaryP3Emp = chip.dataset.p3Emp; renderSummary(); return; }
    var go = e.target.closest('[data-p3-goto]');
    if (go) { currentDate = new Date(go.dataset.p3Goto + 'T00:00:00'); switchToView('week'); }
  });

  // ---------- Gaveta lateral (Opção D + N2) ----------
  $('notesDrawerBackdrop').addEventListener('click', closeNotesDrawer);
  $('drawerCloseBtn').addEventListener('click', closeNotesDrawer);
  $('notesDrawer').addEventListener('click', function (e) {
    var t = e.target;
    var p3Chip = t.closest('[data-p3-emp]');
    if (p3Chip) { summaryP3Emp = p3Chip.dataset.p3Emp; renderNotesDrawer(); return; }
    var p3Go = t.closest('[data-p3-goto]');
    if (p3Go) { closeNotesDrawer(); currentDate = new Date(p3Go.dataset.p3Goto + 'T00:00:00'); switchToView('week'); return; }
    var fBtn = t.closest('[data-drw-filter]');
    if (fBtn) {
      drawerState.filter = fBtn.dataset.drwFilter;
      drawerState.editing = null;
      renderNotesDrawer();
      return;
    }
    if (t.closest('[data-drw-clear-day]')) {
      drawerState.day = '';
      drawerState.editing = null;
      renderNotesDrawer();
      return;
    }
    if (t.closest('[data-drw-goto-notes]')) {
      closeNotesDrawer();
      switchToView('notes');
      return;
    }
    if (t.closest('#drawerNewToggle')) {
      drawerState.composing = true;
      var range = getDrawerRange();
      renderNotesDrawer();
      var dateInp = $('drwDate');
      if (dateInp) dateInp.value = drawerState.day || defaultDateInRange(range);
      var txtInp = $('drwText');
      if (txtInp) { txtInp.value = ''; txtInp.focus(); }
      var impInp = $('drwImp');
      if (impInp) impInp.checked = false;
      return;
    }
    if (t.closest('#drwCancelBtn')) {
      drawerState.composing = false;
      renderNotesDrawer();
      return;
    }
    if (t.closest('#drwSaveBtn')) {
      var dateVal = $('drwDate') ? $('drwDate').value : '';
      var scopeVal = $('drwScope') ? $('drwScope').value : 'day';
      var textVal = $('drwText') ? $('drwText').value : '';
      var impVal = $('drwImp') ? $('drwImp').checked : false;
      if (!dateVal) { toast('Escolha a data.'); return; }
      if (!addNote(dateVal, scopeVal === 'day' ? '' : scopeVal.slice(4), textVal, impVal)) {
        toast('Escreva a anotação antes de salvar.');
        return;
      }
      drawerState.composing = false;
      drawerState.filter = 'all';
      var curRange = getDrawerRange();
      if (dateVal < curRange.start || dateVal > curRange.end) {
        currentDate = new Date(dateVal + 'T00:00:00');
        drawerState.day = '';
      }
      renderActive();
      toast('Anotação adicionada');
      return;
    }
    var actBtn = t.closest('[data-drw-act]');
    if (!actBtn) return;
    var card = actBtn.closest('.n2-card');
    if (!card) return;
    var nDate = card.dataset.date, nId = card.dataset.id, act = actBtn.dataset.drwAct;
    var note = getNotes(nDate).filter(function (x) { return x.id === nId; })[0];
    if (!note) return;
    if (act === 'imp') {
      updateNote(nDate, nId, { important: !note.important });
      renderActive();
    } else if (act === 'cell' && note.emp) {
      closeNotesDrawer();
      openSheet(note.emp, nDate);
    } else if (act === 'edit') {
      drawerState.editing = { date: nDate, id: nId };
      renderNotesDrawer();
    } else if (act === 'cancel') {
      drawerState.editing = null;
      renderNotesDrawer();
    } else if (act === 'save') {
      var newTxt = ($('drwEditText') ? $('drwEditText').value : '').trim();
      if (!newTxt) { toast('A anotação não pode ficar vazia.'); return; }
      updateNote(nDate, nId, { text: newTxt.slice(0, 600), edited: true });
      drawerState.editing = null;
      renderActive();
      toast('Anotação atualizada');
    } else if (act === 'del') {
      showDialog({
        title: 'Excluir anotação', body: 'Excluir esta anotação? Essa ação não pode ser desfeita.', confirmText: 'Excluir', isDanger: true,
        onConfirm: function () { deleteNote(nDate, nId); renderActive(); toast('Anotação removida'); }
      });
    }
  });

  // ---------- Ficha da célula: fechar, vizinhos e anotações N2 ----------
  $('sheetCloseBtn').addEventListener('click', closeSheet);
  $('sheetNeighbors').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-jump-date]');
    if (!btn || !sheetCtx) return;
    openSheet(sheetCtx.emp, btn.dataset.jumpDate);
  });
  $('sheetNoteToggle').addEventListener('click', function () {
    if (!sheetCtx) return;
    sheetNoteState.composing = !sheetNoteState.composing;
    renderSheetNotes();
    if (sheetNoteState.composing && $('noteInput')) $('noteInput').focus();
  });
  $('noteCancelBtn').addEventListener('click', function () {
    sheetNoteState.composing = false;
    renderSheetNotes();
  });
  $('noteAddBtn').addEventListener('click', function () {
    if (!sheetCtx) return;
    var scope = $('noteScope').value;
    var ok = addNote(sheetCtx.date, scope === 'day' ? '' : sheetCtx.emp, $('noteInput').value, $('noteImportant').checked);
    if (!ok) { toast('Escreva a anotação antes de adicionar.'); return; }
    $('noteInput').value = ''; $('noteImportant').checked = false;
    sheetNoteState.composing = false;
    renderSheetNotes(); renderActive(); toast('Anotação adicionada');
  });
  $('sheetNotesList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-sheet-note-act]');
    if (!btn || !sheetCtx) return;
    var card = btn.closest('.n2-card');
    if (!card) return;
    var nId = card.dataset.id, act = btn.dataset.sheetNoteAct, date = sheetCtx.date;
    var note = getNotes(date).filter(function (x) { return x.id === nId; })[0];
    if (!note) return;
    if (act === 'imp') {
      updateNote(date, nId, { important: !note.important });
      renderSheetNotes(); renderActive();
    } else if (act === 'edit') {
      sheetNoteState.editingId = nId;
      renderSheetNotes();
    } else if (act === 'cancel') {
      sheetNoteState.editingId = null;
      renderSheetNotes();
    } else if (act === 'save') {
      var txt = ($('sheetEditNoteText') ? $('sheetEditNoteText').value : '').trim();
      if (!txt) { toast('A anotação não pode ficar vazia.'); return; }
      updateNote(date, nId, { text: txt.slice(0, 600), edited: true });
      sheetNoteState.editingId = null;
      renderSheetNotes(); renderActive(); toast('Anotação atualizada');
    } else if (act === 'del') {
      showDialog({
        title: 'Excluir anotação', body: 'Excluir esta anotação? Essa ação não pode ser desfeita.', confirmText: 'Excluir', isDanger: true,
        onConfirm: function () { deleteNote(date, nId); renderSheetNotes(); renderActive(); toast('Anotação removida'); }
      });
    }
  });

  // ---------- Aba Notas ----------
  viewNotes.addEventListener('input', function (e) {
    if (e.target.id === 'nvSearch') { notesFilter.q = e.target.value; editingNote = null; renderNotesList(); }
  });
  viewNotes.addEventListener('click', function (e) {
    var t = e.target;
    var chip = t.closest('[data-nf]');
    if (chip) {
      notesFilter.mode = chip.dataset.nf; editingNote = null;
      viewNotes.querySelectorAll('.note-chip').forEach(function (c) { c.classList.toggle('active', c === chip); });
      renderNotesList();
      return;
    }
    var gd = t.closest('[data-goto-date]');
    if (gd) { currentDate = new Date(gd.dataset.gotoDate + 'T00:00:00'); switchToView('week'); return; }
    if (t.closest('#nvAdd')) {
      var date = $('nvDate').value, scope = $('nvScope').value;
      if (!date) { toast('Escolha a data.'); return; }
      var ok = addNote(date, scope === 'day' ? '' : scope.slice(4), $('nvText').value, $('nvImp').checked);
      if (!ok) { toast('Escreva a anotação antes de adicionar.'); return; }
      var dd = new Date(date + 'T00:00:00');
      if (dd.getMonth() !== currentDate.getMonth() || dd.getFullYear() !== currentDate.getFullYear()) {
        currentDate = new Date(dd.getFullYear(), dd.getMonth(), 1);
        renderActive();
      } else {
        $('nvText').value = ''; $('nvImp').checked = false;
        renderNotesList(); updateBadges();
      }
      toast('Anotação adicionada');
      return;
    }
    var actBtn = t.closest('[data-na]');
    if (!actBtn) return;
    var item = actBtn.closest('.note-item');
    if (!item) return;
    var nDate = item.dataset.date, nId = item.dataset.id, act = actBtn.dataset.na;
    var note = getNotes(nDate).filter(function (x) { return x.id === nId; })[0];
    if (!note) return;
    if (act === 'imp') { updateNote(nDate, nId, { important: !note.important }); renderNotesList(); }
    else if (act === 'edit') { editingNote = { date: nDate, id: nId }; renderNotesList(); }
    else if (act === 'cancel') { editingNote = null; renderNotesList(); }
    else if (act === 'save') {
      var txt = ($('editNoteText').value || '').trim();
      if (!txt) { toast('A anotação não pode ficar vazia.'); return; }
      updateNote(nDate, nId, { text: txt.slice(0, 600), edited: true });
      editingNote = null; renderNotesList(); toast('Anotação atualizada');
    }
    else if (act === 'del') {
      showDialog({
        title: 'Excluir anotação', body: 'Excluir esta anotação? Essa ação não pode ser desfeita.', confirmText: 'Excluir', isDanger: true,
        onConfirm: function () { deleteNote(nDate, nId); renderNotesList(); updateBadges(); toast('Anotação removida'); }
      });
    }
  });

  window.changeTeam = function () {
    currentTeam = null;
    updateHeaderUI();
    if (userTeams.length === 1) {
      currentTeam = userTeams[0];
      startApp();
    } else {
      renderTeamSelection();
    }
  };
  window.doLogout = function () {
    sb.auth.signOut();
  };

  applyTheme();
  initApp();
})();