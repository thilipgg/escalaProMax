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

  // Variáveis de sincronização
  let _syncState = 'idle'; // 'idle' | 'pending' | 'saving' | 'synced' | 'error'
  let _lastSyncTime = null;
  let pendingSave = false;
  let _saving = false;
  let saveTimer = null;
  let realtimeChannel = null;
  let state = {}; // O estado da escala em si

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
      sundayRule: { maxWorkers: 2, maxConsecutive: 2 }
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
        await doSave(); // Cria a linha se não existir
      }
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
      saveTimer = setTimeout(doSave, 5000); // Tenta de novo em 5s
    } finally {
      _saving = false;
      updateStorageStatus();
    }
  }

  function updateStorageStatus(mode) {
    if (mode) _syncState = mode;
    var el = document.getElementById('storageStatus');
    if (!el) return;
    var now = _lastSyncTime || new Date();
    var timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

    if (_syncState === 'pending') { el.textContent = '⟳ Alterações pendentes'; el.style.background = '#fef3c7'; el.style.color = '#92400e'; }
    else if (_syncState === 'saving') { el.textContent = '⟳ Sincronizando...'; el.style.background = '#fef3c7'; el.style.color = '#92400e'; }
    else if (_syncState === 'synced') { el.textContent = '✓ Nuvem · ' + timeStr; el.style.background = '#dcfce7'; el.style.color = '#166534'; }
    else if (_syncState === 'error') { el.textContent = '✗ Erro de sincronização'; el.style.background = '#fee2e2'; el.style.color = '#991b1b'; }
    else { el.textContent = '—'; el.style.background = '#f1f5f9'; el.style.color = '#475569'; }
  }

  // ==========================================
  // 4. AUTENTICAÇÃO E TIMES (UI E LÓGICA)
  // ==========================================
  function updateHeaderUI() {
    const isApp = (currentUser && currentTeam);
    document.querySelector('.period-row').style.display = isApp ? 'flex' : 'none';
    document.querySelector('.tabs').style.display = isApp ? 'flex' : 'none';
    document.getElementById('printBtn').style.display = isApp ? 'grid' : 'none';

    if (currentTeam) {
      document.getElementById('teamNameDisplay').textContent = currentTeam.name;
      document.title = currentTeam.name + ' · Escala';
    } else {
      document.getElementById('teamNameDisplay').textContent = 'Gerenciador de Escalas';
      document.title = 'Gerenciador de Escalas';
    }
  }

  function renderAuthScreen() {
    // ✅ FIX 1: garante que a view de semana esteja visível
    activeView = 'week';
    document.querySelectorAll('.tab').forEach(t =>
      t.classList.toggle('active', t.dataset.view === 'week')
    );
    document.querySelectorAll('.view').forEach(v =>
      v.classList.toggle('active', v.id === 'view-week')
    );

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
    </div>
  `;

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

      if (!email || !pass) {
        errorDiv.style.color = 'var(--danger)';
        errorDiv.textContent = 'Preencha e-mail e senha.';
        return;
      }
      if (isRegistering && !name) {
        errorDiv.style.color = 'var(--danger)';
        errorDiv.textContent = 'Preencha seu nome.';
        return;
      }

      btnLogin.textContent = 'Aguarde...';
      btnLogin.disabled = true;
      errorDiv.textContent = '';

      try {
        if (isRegistering) {
          console.log('[Auth] Tentando signUp:', email);
          const { data, error } = await sb.auth.signUp({
            email,
            password: pass,
            options: { data: { full_name: name } }
          });
          if (error) throw error;
          console.log('[Auth] signUp resposta:', data);

          if (data.session === null) {
            // Confirmação de e-mail pendente
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
          console.log('[Auth] Tentando login:', email);
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
    if (error) {
      console.error(error);
      return [];
    }
    return data.map(d => d.teams);
  }

  function renderTeamSelection() {

    activeView = 'week';
    document.querySelectorAll('.tab').forEach(t =>
      t.classList.toggle('active', t.dataset.view === 'week')
    );
    document.querySelectorAll('.view').forEach(v =>
      v.classList.toggle('active', v.id === 'view-week')
    );

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
        // 1. Cria o time
        const { data: team, error: err1 } = await sb
          .from('teams')
          .insert({ name, created_by: currentUser.id })
          .select()
          .single();
        if (err1) throw err1;

        // 2. Adiciona o criador como membro
        const { error: err2 } = await sb
          .from('team_members')
          .insert({ team_id: team.id, user_id: currentUser.id, role: 'admin' });
        if (err2) throw err2;

        // 3. Cria a escala inicial
        await sb.from('escala').insert({ team_id: team.id, data: getDefaultState() });

        currentTeam = team;
        await startApp();
      } catch (e) {
        console.error('[Team Creation] Erro:', e);
        alert('Erro ao criar time: ' + e.message);
        // ✅ SEMPRE restaura o botão, independente de erro ou sucesso
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

  // ==========================================
  // 5. INICIALIZAÇÃO DA APLICAÇÃO
  // ==========================================
  async function initApp() {
    sb.auth.onAuthStateChange(async (event, session) => {
      if (session) {
        currentUser = session.user;
        userTeams = await fetchUserTeams();

        // Se o usuário só tem 1 time, entra direto
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
  // 6. LÓGICA DO APP (CÓDIGO ORIGINAL ADAPTADO)
  // ==========================================
  var currentDate = new Date();
  var activeView = 'week';

  var $ = function (id) { return document.getElementById(id); };
  var periodTitle = $('periodTitle'), tabsEl = $('tabs');
  var viewWeek = $('view-week'), viewMonth = $('view-month'), viewSummary = $('view-summary'), viewSettings = $('view-settings');
  var sheet = $('sheet'), sheetBackdrop = $('sheetBackdrop'), sheetTitle = $('sheetTitle'), sheetSub = $('sheetSub');
  var workShiftGrid = $('workShiftGrid'), eventShiftGrid = $('eventShiftGrid'), sheetClear = $('sheetClear');
  var workSectionTitle = $('workSectionTitle'), eventSectionTitle = $('eventSectionTitle');
  var toastEl = $('toast');
  var toastTimer;

  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600); }

  var dialogCallback = null, dialogCancelCb = null;
  function showDialog(opt) {
    $('dialogTitle').textContent = opt.title;
    $('dialogBody').innerHTML = opt.body;
    var btn = $('dialogConfirm');
    btn.textContent = opt.confirmText || 'Confirmar';
    btn.className = 'dialog-confirm' + (opt.isDanger === false ? ' primary' : '');
    $('dialogCancel').textContent = opt.cancelText || 'Cancelar';
    dialogCallback = opt.onConfirm || null;
    dialogCancelCb = opt.onCancel || null;
    $('dialogBackdrop').classList.add('open');
  }
  $('dialogConfirm').addEventListener('click', function () {
    $('dialogBackdrop').classList.remove('open');
    var cb = dialogCallback; dialogCallback = null; dialogCancelCb = null;
    if (cb) cb();
  });
  $('dialogCancel').addEventListener('click', function () {
    $('dialogBackdrop').classList.remove('open');
    var cb = dialogCancelCb; dialogCallback = null; dialogCancelCb = null;
    if (cb) cb();
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
  function shiftNextMin(id) { var en = shiftEndMin(id); if (en === null) return null; return (en + REST_11H) % 1440; }
  function isValidTransition(prev, next) { if (!isWorkShift(prev) || !isWorkShift(next)) return true; return shiftStartMin(next) >= shiftNextMin(prev); }

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

  function getWeekWarningsForMonth(y, m) {
    var warnings = [];
    var monthStart = new Date(y, m, 1);
    var monthEnd = new Date(y, m + 1, 0);
    var w = getWeekStart(monthStart);
    var guard = 0;
    while (w.getTime() <= monthEnd.getTime() && guard++ < 10) {
      var weekStart = new Date(w);
      var weekEnd = new Date(w); weekEnd.setDate(w.getDate() + 6);
      (function (ws, we) {
        state.employees.forEach(function (emp) {
          var scale = getEmployeeScale(emp);
          var req = requiredFolgas(scale);
          if (req === 0) return;
          var info = getWeekFolgas(emp, ws);
          if (!info.planned) return;
          if (info.folgas + info.empty < req) {
            warnings.push(emp + ': semana ' + pad(ws.getDate()) + '/' + pad(ws.getMonth() + 1) +
              '–' + pad(we.getDate()) + '/' + pad(we.getMonth() + 1) +
              ' — ' + info.folgas + ' folga(s), precisa ' + req + ' (' + scale + ')');
          }
        });
      })(weekStart, weekEnd);
      w.setDate(w.getDate() + 7);
    }
    return warnings;
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

  function getWarningsForCell(emp, date, code) {
    var warnings = [];
    if (!code) return warnings;
    if (code === 'FE' && !isHoliday(date)) {
      var b = getHolidayBalances(date, date, emp);
      if (b[emp] <= 0) warnings.push('Saldo de folgas de feriado até a data é ' + b[emp] + '. Você está usando folga sem saldo.');
      return warnings;
    }
    if (!isWorkShift(code)) return warnings;

    var d = new Date(date + 'T00:00:00');
    var prev = new Date(d); prev.setDate(prev.getDate() - 1);
    var next = new Date(d); next.setDate(next.getDate() + 1);
    var prevCode = (state.schedule[keyOf(prev)] || {})[emp];
    var nextCode = (state.schedule[keyOf(next)] || {})[emp];

    if (isWorkShift(prevCode) && !isValidTransition(prevCode, code)) {
      warnings.push('Após ' + prevCode + ' no dia anterior, o próximo turno só pode começar a partir de ' + fmtMin(shiftNextMin(prevCode)) + '.');
    }
    if (isWorkShift(nextCode) && !isValidTransition(code, nextCode)) {
      var s = getShift(code);
      warnings.push(code + ' termina às ' + s.end + ', então o dia seguinte só pode ter turno a partir de ' + fmtMin(shiftNextMin(code)) + '.');
    }
    if (d.getDay() === 0) {
      var maxW = state.sundayRule.maxWorkers || 2;
      var others = state.employees.filter(function (e) { return e !== emp && isWorkShift((state.schedule[date] || {})[e]); });
      if (others.length >= maxW) warnings.push('Domingo já tem ' + maxW + ' colaboradores trabalhando. O limite é ' + maxW + '.');
      var cons = getConsecutiveSundays(emp, date);
      var maxC = state.sundayRule.maxConsecutive || 2;
      if (cons > maxC) warnings.push('Este colaborador vai trabalhar ' + cons + ' domingos consecutivos. O limite configurado é ' + maxC + '.');
    }
    return warnings;
  }

  function countSundayWorkers(date) {
    return state.employees.filter(function (e) { return isWorkShift((state.schedule[date] || {})[e]); }).length;
  }

  function checkEssentialShifts(key) {
    var d = new Date(key + 'T00:00:00');
    if (d.getDay() === 0) return { missing06: false, missing14: false };
    var has06 = false, has14 = false;
    state.employees.forEach(function (emp) {
      var code = (state.schedule[key] || {})[emp];
      if (code === '06:00') has06 = true;
      if (code === '14:00') has14 = true;
    });
    return { missing06: !!state.shifts['06:00'] && !has06, missing14: !!state.shifts['14:00'] && !has14 };
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

  function renderWeek() {
    if (!state.employees || state.employees.length === 0) {
      viewWeek.innerHTML = emptyStateHTML('Nenhum colaborador cadastrado. Adicione em <strong>Ajustes</strong>.');
      return;
    }
    var start = getWeekStart(currentDate);
    var days = [];
    for (var i = 0; i < 7; i++) { var d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
    var todayStr = new Date().toDateString();
    var h = '<div class="week-grid"><div class="wk-corner"></div>';
    for (var j = 0; j < days.length; j++) {
      var d = days[j], key = keyOf(d), dow = d.getDay();
      var miss = checkEssentialShifts(key);
      var missClass = (miss.missing06 || miss.missing14) ? 'missing-essential' : '';
      var cls = [dow === 0 || dow === 6 ? 'weekend' : '', isHoliday(key) ? 'holiday' : '', d.toDateString() === todayStr ? 'today' : '', missClass].filter(Boolean).join(' ');
      var headStyle = '';
      if (dow === 0) {
        var sun = state.colors.SUNDAY || { color: '#ef4444', text: '#ffffff' };
        headStyle = 'background:' + sun.color + '; color:' + sun.text + ';';
      }
      var badge = '';
      if (dow === 0) {
        var n = countSundayWorkers(key);
        var maxW = state.sundayRule.maxWorkers || 2;
        badge = '<span class="sun-count ' + (n <= maxW ? 'ok' : 'bad') + '">' + n + '/' + maxW + '</span>';
      }
      var alertIcon = (miss.missing06 || miss.missing14) ? '<span style="color:var(--danger);font-size:11px;display:block;line-height:1;margin-top:2px;" title="Falta turno essencial">⚠</span>' : '';
      h += '<div class="wk-day-head ' + cls + '" style="' + headStyle + '"><span class="wk-dow" style="' + (dow === 0 ? 'color:inherit;opacity:.9' : '') + '">' + DOW[dow] + '</span><span class="wk-num">' + d.getDate() + '</span>' + badge + alertIcon + '</div>';
    }
    for (var k = 0; k < state.employees.length; k++) {
      var emp = state.employees[k];
      h += '<div class="wk-emp">' + emp + '</div>';
      for (var l = 0; l < days.length; l++) {
        var d = days[l], key = keyOf(d);
        var code = (state.schedule[key] || {})[emp] || '';
        var s = getShift(code);
        var style = '';
        if (s) {
          if (s.type === 'work') {
            style = 'color:' + (isHoliday(key) ? '#fff' : s.text) + ';';
          } else if (d.getDay() === 0) {
            // Domingo + folga: letra amarela sobre o vermelho do domingo
            var sunColor = (state.colors.SUNDAY || { color: '#ef4444' }).color;
            style = 'background:' + sunColor + ';color:#facc15;font-weight:900;';
          } else {
            style = 'background:' + s.color + ';color:' + s.text + ';';
          }
        }
        var w = code && getWarningsForCell(emp, key, code).length > 0;
        var holidayClass = isHoliday(key) ? 'holiday' : '';
        h += '<button class="wk-cell ' + holidayClass + ' ' + (w ? 'has-warning' : '') + '" data-emp="' + emp + '" data-date="' + key + '" style="' + style + '">' + (s ? s.label : '') + '</button>';
      }
    }
    h += '</div>';

    var weekStart = getWeekStart(currentDate);
    var anyPlanned = false;
    var folgaIssues = [];
    var folgaOkList = [];
    state.employees.forEach(function (emp) {
      var scale = getEmployeeScale(emp);
      var req = requiredFolgas(scale);
      var info = getWeekFolgas(emp, weekStart);
      if (info.planned) anyPlanned = true;
      if (req > 0 && info.planned) {
        if (info.folgas + info.empty < req) folgaIssues.push({ emp: emp, folgas: info.folgas, req: req, scale: scale });
        else if (info.folgas >= req) folgaOkList.push(emp + ': ' + info.folgas + '/' + req);
      }
    });
    if (folgaIssues.length) {
      h += '<div class="week-alerts"><div class="warn-card"><h3>⚠ Folgas da Semana (Seg–Dom)</h3><ul>' +
        folgaIssues.map(function (w) { return '<li><strong>' + w.emp + '</strong>: ' + w.folgas + ' folga(s) — precisa ' + w.req + ' (escala ' + w.scale + ')</li>'; }).join('') +
        '</ul></div></div>';
    } else if (anyPlanned && folgaOkList.length) {
      h += '<div class="week-alerts"><div class="warn-card ok"><h3>✓ Folgas em dia (Seg–Dom)</h3><div style="font-size:12.5px;color:#166534;line-height:1.7">' + folgaOkList.join(' · ') + '</div></div></div>';
    }
    viewWeek.innerHTML = h;
  }

  function renderMonth() {
    if (!state.employees || state.employees.length === 0) {
      viewMonth.innerHTML = emptyStateHTML('Nenhum colaborador cadastrado. Adicione em <strong>Ajustes</strong>.');
      return;
    }
    var y = currentDate.getFullYear(), m = currentDate.getMonth();
    var n = daysInMonth(currentDate);
    var todayStr = new Date().toDateString();
    var h = '<div class="grid-scroll" id="gridScrollInner"><table class="grid-table"><thead><tr><th class="sticky-col">Equipe</th>';
    for (var d = 1; d <= n; d++) {
      var dt = new Date(y, m, d), dow = dt.getDay(), key = dateKey(y, m, d);
      var miss = checkEssentialShifts(key);
      var missClass = (miss.missing06 || miss.missing14) ? 'missing-essential' : '';
      var cls = [dow === 0 || dow === 6 ? 'weekend' : '', isHoliday(key) ? 'holiday' : '', dt.toDateString() === todayStr ? 'today' : '', missClass].filter(Boolean).join(' ');
      var headStyle = '';
      if (dow === 0) {
        var sun = state.colors.SUNDAY || { color: '#ef4444', text: '#ffffff' };
        headStyle = 'background:' + sun.color + '; color:' + sun.text + ';';
      }
      var alertIcon = (miss.missing06 || miss.missing14) ? '<span style="color:var(--danger);font-size:11px;display:block;line-height:1;margin-top:2px;" title="Falta turno essencial">⚠</span>' : '';
      h += '<th class="' + cls + '" style="' + headStyle + '"><span class="dnum">' + d + '</span><span class="dow" style="' + (dow === 0 ? 'color:inherit;opacity:.9' : '') + '">' + DOW[dow] + '</span>' + alertIcon + '</th>';
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
            // Domingo + folga: letra amarela sobre o vermelho do domingo
            var sunColor = (state.colors.SUNDAY || { color: '#ef4444' }).color;
            style = 'background:' + sunColor + ';color:#facc15;font-weight:900;';
          } else {
            style = 'background:' + s.color + ';color:' + s.text + ';';
          }
        }
        var w = code && getWarningsForCell(emp, key, code).length > 0;
        h += '<td class="' + cls + ' ' + (w ? 'has-warning' : '') + '" data-emp="' + emp + '" data-date="' + key + '" style="' + style + '">' + (s ? s.label : '') + '</td>';
      }
      h += '</tr>';
    }
    h += '</tbody></table></div><div class="legend">';
    Object.keys(state.shifts).forEach(function (id) {
      var s = state.shifts[id];
      if (s.type === 'event') h += '<div class="legend-item"><span class="legend-dot" style="background:' + s.color + ';color:' + s.text + '">' + s.label + '</span>' + s.name + '</div>';
    });
    h += '</div>';

    var monthWarnings = getWeekWarningsForMonth(y, m);
    if (monthWarnings.length) {
      h += '<div class="week-alerts"><div class="warn-card"><h3>⚠ Folgas Semanais (Seg–Dom)</h3><ul>' +
        monthWarnings.map(function (w) { return '<li>' + w + '</li>'; }).join('') + '</ul></div></div>';
    } else {
      var hasAnyPlanned = false;
      for (var dd = 1; dd <= n; dd++) {
        var kk = dateKey(y, m, dd);
        if (state.schedule[kk] && Object.keys(state.schedule[kk]).length) { hasAnyPlanned = true; break; }
      }
      if (hasAnyPlanned) {
        h += '<div class="week-alerts"><div class="warn-card ok"><h3>✓ Folgas Semanais em dia (Seg–Dom)</h3><div style="font-size:12.5px;color:#166534;line-height:1.7">Todas as semanas do mês respeitam a escala configurada.</div></div></div>';
      }
    }

    viewMonth.innerHTML = h;
    requestAnimationFrame(function () {
      var th = document.querySelector('#gridScrollInner th.today');
      var sc = document.getElementById('gridScrollInner');
      if (th && sc) sc.scrollLeft = Math.max(0, th.offsetLeft - 80);
    });
  }

  function renderSummary() {
    if (!state.employees || state.employees.length === 0) {
      viewSummary.innerHTML = emptyStateHTML('Nenhum colaborador cadastrado.');
      return;
    }
    var y = currentDate.getFullYear(), m = currentDate.getMonth();
    var n = daysInMonth(currentDate);
    var balances = getHolidayBalances();
    var balChips = state.employees.map(function (emp) {
      var b = balances[emp];
      var bg = '#f1f5f9', c = '#475569';
      if (b > 0) { bg = '#dcfce7'; c = '#166534'; }
      if (b < 0) { bg = '#fee2e2'; c = '#991b1b'; }
      return '<span class="bd-chip" style="background:' + bg + ';color:' + c + ';border:1px solid rgba(0,0,0,.05)">' + emp + ': ' + b + '</span>';
    }).join('');
    var h = '<div class="summary"><div class="summary-card" style="background:linear-gradient(135deg,#eff6ff,#f8fafc);border-color:#bfdbfe">' +
      '<div class="section-head" style="margin-bottom:10px"><div class="section-icon" style="background:#dbeafe;color:#1e40af"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></div>' +
      '<h3 class="section-title" style="color:#1e3a8a">Saldo de Folgas de Feriado</h3></div>' +
      '<p style="font-size:12.5px;color:#64748b;margin:-4px 0 14px">+1 ao trabalhar em feriado · −1 ao usar FE em dia útil</p>' +
      '<div class="bd">' + balChips + '</div></div>';

    for (var i = 0; i < state.employees.length; i++) {
      var emp = state.employees[i];
      var work = 0, folga = 0, ferias = 0, counts = {};
      for (var j = 1; j <= n; j++) {
        var code = (state.schedule[dateKey(y, m, j)] || {})[emp];
        if (!code) continue;
        if (code === 'D' || code === 'F6') folga++;
        else if (code === 'F' || code === 'x' || code === 'FE') ferias++;
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

    var warningList = [];
    for (var d = 1; d <= n; d++) {
      var key = dateKey(y, m, d);
      var dt = new Date(y, m, d);
      if (dt.getDay() === 0) {
        var c = countSundayWorkers(key);
        var maxW = state.sundayRule.maxWorkers || 2;
        if (c > maxW) warningList.push('Domingo ' + pad(d) + '/' + pad(m + 1) + ': ' + c + ' trabalhando (limite ' + maxW + ').');
        state.employees.forEach(function (emp) {
          var code = (state.schedule[key] || {})[emp];
          if (isWorkShift(code)) {
            var cons = getConsecutiveSundays(emp, key);
            var maxC = state.sundayRule.maxConsecutive || 2;
            if (cons > maxC) {
              var prev = new Date(dt); prev.setDate(prev.getDate() - 7);
              var prevCode = (state.schedule[keyOf(prev)] || {})[emp];
              if (!isWorkShift(prevCode)) warningList.push(emp + ': ' + cons + ' domingos consecutivos a partir de ' + pad(d) + '/' + pad(m + 1) + ' (limite ' + maxC + ').');
            }
          }
        });
      }
      var miss = checkEssentialShifts(key);
      if (miss.missing06) warningList.push('Dia ' + pad(d) + '/' + pad(m + 1) + ': Ninguém escalado no horário essencial das 06:00.');
      if (miss.missing14) warningList.push('Dia ' + pad(d) + '/' + pad(m + 1) + ': Ninguém escalado no horário essencial das 14:00.');
    }
    state.employees.forEach(function (emp) {
      for (var d = 1; d < n; d++) {
        var k1 = dateKey(y, m, d), k2 = dateKey(y, m, d + 1);
        var c1 = (state.schedule[k1] || {})[emp], c2 = (state.schedule[k2] || {})[emp];
        if (isWorkShift(c1) && isWorkShift(c2) && !isValidTransition(c1, c2)) {
          warningList.push(emp + ': ' + pad(d) + '/' + pad(m + 1) + ' ' + c1 + ' → ' + pad(d + 1) + '/' + pad(m + 1) + ' ' + c2 + ' — descanso insuficiente (mín. 11h).');
        }
      }
    });
    getWeekWarningsForMonth(y, m).forEach(function (w) { warningList.push(w); });

    if (warningList.length) {
      var listHtml = warningList.map(function (w) { return '<li>' + w + '</li>'; }).join('');
      h += '<div class="warn-card"><h3>⚠ Verificações Pendentes</h3><ul>' + listHtml + '</ul></div>';
    } else {
      h += '<div class="warn-card ok"><h3>✓ Tudo Certo!</h3><ul><li>Descanso de 11h respeitado</li><li>Regras de domingo (limite e consecutivos) ok</li><li>Turnos essenciais (06h e 14h) preenchidos</li><li>Folgas semanais conforme escala (6x1 / 5x2)</li></ul></div>';
    }
    h += '</div>';
    viewSummary.innerHTML = h;
  }

  function renderSettings() {
  var h = '';
  // === NOVA ÁREA DE CONTA ===
  h += `<div class="settings-section full" style="background:linear-gradient(135deg,#f8fafc,#f1f5f9);border-color:#e2e8f0">
    <div class="section-head">
      <div class="section-icon" style="background:#e2e8f0;color:#475569"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
      <h3 class="section-title">Conta e Equipe</h3>
    </div>
    <div class="settings-row"><label>Líder logado</label><span style="font-weight:600;font-size:13px;">${currentUser.email}</span></div>
    <div class="settings-row"><label>Time atual</label><span style="font-weight:600;font-size:13px;">${currentTeam.name}</span></div>
    <div style="display:flex;gap:10px;margin-top:15px;">
      <button class="danger-btn neutral" style="flex:1;" onclick="window.changeTeam()">Trocar de Time</button>
      <button class="danger-btn" style="flex:1;" onclick="window.doLogout()">Sair da Conta</button>
    </div>
  </div>`;

  h += '<div class="settings-section full">' +
    '<div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg></div><h3 class="section-title">Geral</h3></div>' +
    '<div class="settings-row"><label>Nome do time</label><input type="text" class="team-name-input" id="teamNameInput" value="' + state.teamName.replace(/"/g, '&quot;') + '" style="max-width:280px;flex:1"></div>' +
    '<div class="settings-row"><label>Sincronização</label><span id="storageStatus" style="font-size:12px;font-weight:700;padding:6px 12px;border-radius:20px;background:#f1f5f9;color:#475569">—</span></div>' +
    '<div class="settings-row"><label>Forçar envio à nuvem</label><button class="danger-btn neutral" id="forceSyncBtn">Sincronizar agora</button></div></div>';

  h += '<div class="settings-section"><div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div><h3 class="section-title">Colaboradores</h3></div><div class="edit-list" id="employeeList">';
  state.employees.forEach(function (emp) {
    h += '<div class="edit-row" data-emp="' + emp.replace(/"/g, '&quot;') + '"><input type="text" class="name-input emp-name" value="' + emp.replace(/"/g, '&quot;') + '" placeholder="Nome"><button class="row-delete" data-del-emp="' + emp.replace(/"/g, '&quot;') + '" title="Remover"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div>';
  });
  h += '</div><button class="add-btn" id="addEmployeeBtn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5v14"/></svg> Adicionar colaborador</button></div>';

  var workIds = Object.keys(state.shifts).filter(function (k) { return state.shifts[k].type === 'work'; });
  workIds.sort(function (a, b) { return parseTime(state.shifts[a].start) - parseTime(state.shifts[b].start); });

  h += '<div class="settings-section"><div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><h3 class="section-title">Turnos de Trabalho</h3></div><div class="edit-list" id="workShiftList">';
  workIds.forEach(function (id) {
    var s = state.shifts[id];
    h += '<div class="edit-row" data-shift="' + id + '" data-type="work"><input type="color" class="color-picker shift-color" value="' + s.color + '" title="Cor"><input type="text" class="label-input shift-label" value="' + s.label.replace(/"/g, '&quot;') + '" maxlength="4" title="Rótulo"><input type="time" class="time-input shift-start" value="' + s.start + '" title="Início"><span class="arrow">→</span><input type="time" class="time-input shift-end" value="' + s.end + '" title="Fim"><button class="row-delete" data-del-shift="' + id + '" title="Remover"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div>';
  });
  h += '</div><button class="add-btn" id="addWorkShiftBtn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5v14"/></svg> Adicionar turno</button></div>';

  var eventIds = Object.keys(state.shifts).filter(function (k) { return state.shifts[k].type === 'event'; });
  h += '<div class="settings-section"><div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z"/><line x1="7" x2="7.01" y1="7" y2="7"/></svg></div><h3 class="section-title">Eventos e Folgas</h3></div><div class="edit-list" id="eventShiftList">';
  eventIds.forEach(function (id) {
    var s = state.shifts[id];
    h += '<div class="edit-row" data-shift="' + id + '" data-type="event"><input type="color" class="color-picker shift-color" value="' + s.color + '" title="Cor"><input type="text" class="label-input shift-label" value="' + s.label.replace(/"/g, '&quot;') + '" maxlength="4" title="Rótulo"><input type="text" class="name-input shift-name-input" value="' + s.name.replace(/"/g, '&quot;') + '" placeholder="Nome do evento" title="Nome"><button class="row-delete" data-del-shift="' + id + '" title="Remover"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div>';
  });
  h += '</div><button class="add-btn" id="addEventBtn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5v14"/></svg> Adicionar evento</button></div>';

  h += '<div class="settings-section full" style="background:linear-gradient(135deg,#eff6ff,#f8fafc);border-color:#bfdbfe"><div class="section-head"><div class="section-icon" style="background:#dbeafe;color:#1e40af"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div><h3 class="section-title" style="color:#1e3a8a">Automação</h3></div><p style="font-size:12.5px;color:#64748b;margin:-4px 0 12px">Preenche o mês com os horários padrão (Seg a Sáb). Domingos e folgas ficam em branco.</p><div class="sub-section-title">Turno padrão por colaborador</div>';
  state.employees.forEach(function (emp) {
    var cur = state.defaultShift[emp] || '';
    var opts = workIds.map(function (id) { return '<option value="' + id + '" ' + (id === cur ? 'selected' : '') + '>' + state.shifts[id].name + '</option>'; }).join('');
    h += '<div class="settings-row"><label>' + emp + '</label><select class="def-shift" data-emp="' + emp.replace(/"/g, '&quot;') + '">' + opts + '</select></div>';
  });
  h += '<button class="btn-auto" id="btnAuto" style="margin-top:14px"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Gerar Escala do Mês</button></div>';

  var rule = state.sundayRule;
  h += '<div class="settings-section full"><div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg></div><h3 class="section-title">Regras de Escala</h3></div>' +
    '<div class="settings-row"><label>Máximo de colaboradores no domingo</label><select class="sun-rule-config" data-key="maxWorkers">' + [1, 2, 3, 4, 5].map(function (v) { return '<option value="' + v + '" ' + (rule.maxWorkers == v ? 'selected' : '') + '>' + v + '</option>'; }).join('') + '</select></div>' +
    '<div class="settings-row"><label>Máximo de domingos consecutivos</label><select class="sun-rule-config" data-key="maxConsecutive">' + [1, 2, 3, 4].map(function (v) { return '<option value="' + v + '" ' + (rule.maxConsecutive == v ? 'selected' : '') + '>' + v + ' Domingo(s)</option>'; }).join('') + '</select></div>' +
    '<div class="settings-row"><label>Cor do cabeçalho de Domingo</label><input type="color" class="color-picker sunday-color" value="' + (state.colors.SUNDAY ? state.colors.SUNDAY.color : '#ef4444') + '"></div>' +
    '<div class="sub-section-title">Escala semanal por colaborador</div>';
  state.employees.forEach(function (emp) {
    var cur = getEmployeeScale(emp);
    h += '<div class="settings-row"><label>' + emp + '</label><select class="emp-scale" data-emp="' + emp.replace(/"/g, '&quot;') + '"><option value="6x1" ' + (cur === '6x1' ? 'selected' : '') + '>6x1 — 1 folga/semana</option><option value="5x2" ' + (cur === '5x2' ? 'selected' : '') + '>5x2 — 2 folgas/semana</option><option value="off" ' + (cur === 'off' ? 'selected' : '') + '>Não verificar</option></select></div>';
  });
  h += '</div>';

  h += '<div class="settings-section"><div class="section-head"><div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg></div><h3 class="section-title">Feriados</h3></div>';
  var sorted = Object.keys(state.holidays).sort();
  if (sorted.length === 0) h += '<p style="font-size:12.5px;color:var(--muted);padding:8px 0">Nenhum feriado cadastrado.</p>';
  h += '<div class="holiday-list">';
  sorted.forEach(function (k) {
    var p = k.split('-');
    h += '<div class="holiday-item"><span>' + p[2] + '/' + p[1] + '/' + p[0] + ' — ' + state.holidays[k] + '</span><button data-del-hol="' + k + '">remover</button></div>';
  });
  h += '</div><div class="add-holiday"><input type="date" id="newHolDate"><input type="text" id="newHolName" placeholder="Nome do feriado"><button id="addHolBtn">Adicionar</button></div></div>';

  // ===== DADOS / BACKUP (com input file oculto para o botão Importar) =====
  h += '<div class="settings-section full">' +
    '<div class="section-head">' +
      '<div class="section-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/></svg></div>' +
      '<h3 class="section-title">Dados / Backup</h3>' +
    '</div>' +
    '<div class="settings-row"><label>Exportar backup completo</label><button class="danger-btn neutral" id="downloadCsvBtn">Baixar CSV</button></div>' +
    '<div class="settings-row"><label>Importar backup</label>' +
      '<button class="danger-btn success" id="importBtn">Importar</button>' +
      '<input type="file" id="importFile" accept=".csv,text/csv" style="display:none">' +
    '</div>' +
    '<div class="settings-row"><label>Limpar escala do mês atual</label><button class="danger-btn" id="clearMonthBtn">Limpar</button></div>' +
    '<div class="settings-row"><label>Apagar todos os dados</label><button class="danger-btn" id="resetBtn">Apagar</button></div>' +
  '</div>';

  viewSettings.innerHTML = h;
  updateStorageStatus();
}

  function renderActive() {
    renderHeader();
    switch (activeView) {
      case 'week': renderWeek(); break;
      case 'month': renderMonth(); break;
      case 'summary': renderSummary(); break;
      case 'settings': renderSettings(); break;
    }
  }

  function switchToView(view) {
    activeView = view;
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === view); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + view); });
    renderActive();
  }

  var sheetCtx = null;
  function buildShiftBtn(code, cur, emp, dateStr) {
    var s = getShift(code); if (!s) return '';
    var active = code === cur ? 'active' : '';
    var invalid = false, reason = '';
    if (isWorkShift(code) && code !== cur) {
      var ws = getWarningsForCell(emp, dateStr, code);
      if (ws.length) { invalid = true; reason = ws[0]; }
    }
    var nameDisplay = s.name;
    if (code === 'FE') {
      var b = getHolidayBalances(dateStr, dateStr, emp);
      nameDisplay = 'Saldo: ' + b[emp];
    }
    return '<button class="shift-btn ' + active + ' ' + (invalid ? 'invalid' : '') + '" data-code="' + code + '" style="--c:' + s.color + ';--t:' + s.text + '" title="' + (invalid ? reason.replace(/"/g, '&quot;') : '') + '"><span class="shift-code">' + s.label + '</span><span class="shift-name">' + nameDisplay + '</span>' + (invalid ? '<span class="shift-reason">' + (reason.length > 40 ? reason.slice(0, 40) + '…' : reason) + '</span>' : '') + '</button>';
  }

  function openSheet(emp, dateStr) {
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
      workShiftGrid.innerHTML = workIds.map(function (id) { return buildShiftBtn(id, cur, emp, dateStr); }).join('');
    } else { workShiftGrid.style.display = 'none'; workSectionTitle.style.display = 'none'; }

    if (eventIds.length) {
      eventShiftGrid.style.display = 'grid'; eventSectionTitle.style.display = 'block';
      eventShiftGrid.innerHTML = eventIds.map(function (id) { return buildShiftBtn(id, cur, emp, dateStr); }).join('');
    } else { eventShiftGrid.style.display = 'none'; eventSectionTitle.style.display = 'none'; }

    sheet.classList.add('open'); sheetBackdrop.classList.add('open');
  }

  function closeSheet() { sheet.classList.remove('open'); sheetBackdrop.classList.remove('open'); sheetCtx = null; }

  function commitShift(emp, date, code) {
    if (!state.schedule[date]) state.schedule[date] = {};
    if (code) state.schedule[date][emp] = code;
    else delete state.schedule[date][emp];
    if (Object.keys(state.schedule[date]).length === 0) delete state.schedule[date];
    save(); closeSheet(); renderActive();
    toast(code ? 'Turno aplicado' : 'Célula limpa');
  }

  function applyShift(code) {
    if (!sheetCtx) return;
    var emp = sheetCtx.emp, date = sheetCtx.date;
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
        for (var d = 1; d <= n; d++) {
          var dow = new Date(y, m, d).getDay();
          if (dow === 0) continue;
          var key = dateKey(y, m, d); state.schedule[key] = {};
          state.employees.forEach(function (emp) {
            var def = state.defaultShift[emp];
            if (def && isWorkShift(def)) state.schedule[key][emp] = def;
          });
          if (Object.keys(state.schedule[key]).length === 0) delete state.schedule[key];
        }
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
    lines.push(JSON.stringify({ teamName: state.teamName, employees: state.employees, shifts: state.shifts, defaultShift: state.defaultShift, employeeScale: state.employeeScale, holidays: state.holidays, colors: state.colors, sundayRule: state.sundayRule }));
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
        for (var d = 1; d <= n; d++) {
          var code = row[d];
          if (code) {
            var key = dateKey(y, m, d);
            if (!state.schedule[key]) state.schedule[key] = {};
            state.schedule[key][emp] = code;
          }
        }
      }
      if (!imported) return toast('Nenhum colaborador reconhecido.');
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
    if (field === 'end' && s.type === 'work') s.name = s.start + ' – ' + value;
    save();
  }

  function setPrintOrientation(mode) {
    var st = document.getElementById('printPageStyle');
    if (!st) { st = document.createElement('style'); st.id = 'printPageStyle'; document.head.appendChild(st); }
    st.textContent = mode === 'week' ? '@page { size: A4 portrait; margin: 10mm; }' : '@page { size: A4 landscape; margin: 8mm; }';
  }

  function doPrint(mode) {
    var originalView = activeView;
    if (activeView !== mode) switchToView(mode);
    $('printTeam').textContent = state.teamName;
    $('printPeriod').textContent = periodTitle.textContent;
    $('printFooter').textContent = 'Gerado em ' + new Date().toLocaleString('pt-BR');
    setPrintOrientation(mode);
    var restore = function () {
      window.removeEventListener('afterprint', restore);
      if (activeView !== originalView) switchToView(originalView);
    };
    window.addEventListener('afterprint', restore);
    setTimeout(function () { window.print(); }, 80);
  }

  function requestPrint() {
    if (activeView === 'week' || activeView === 'month') { doPrint(activeView); return; }
    showDialog({ title: 'Imprimir', body: 'O que você deseja imprimir?', confirmText: 'Mês atual', cancelText: 'Semana atual', isDanger: false, onConfirm: function () { doPrint('month'); }, onCancel: function () { doPrint('week'); } });
  }

  // ==========================================
  // 7. EVENT LISTENERS (Original)
  // ==========================================
  $('prevBtn').addEventListener('click', function () {
    if (activeView === 'week') currentDate = new Date(currentDate.getTime() - 7 * 86400000);
    else currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1);
    renderActive();
  });
  $('nextBtn').addEventListener('click', function () {
    if (activeView === 'week') currentDate = new Date(currentDate.getTime() + 7 * 86400000);
    else currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
    renderActive();
  });
  tabsEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.tab'); if (!btn) return;
    switchToView(btn.dataset.view);
  });
  $('printBtn').addEventListener('click', requestPrint);

  viewWeek.addEventListener('click', function (e) {
    var cell = e.target.closest('.wk-cell');
    if (cell) openSheet(cell.dataset.emp, cell.dataset.date);
  });
  viewMonth.addEventListener('click', function (e) {
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
    if (t.id === 'teamNameInput') { state.teamName = t.value.trim() || 'Equipe'; save(); renderHeader(); return; }
    if (t.matches('.sun-rule-config')) { state.sundayRule[t.dataset.key] = parseInt(t.value, 10); save(); return; }
    if (t.matches('.def-shift')) { state.defaultShift[t.dataset.emp] = t.value; save(); return; }
    if (t.matches('.emp-scale')) { if (!state.employeeScale) state.employeeScale = {}; state.employeeScale[t.dataset.emp] = t.value; save(); return; }
    if (t.matches('.sunday-color')) { state.colors.SUNDAY = { color: t.value, text: getContrastColor(t.value) }; save(); renderActive(); return; }
    if (t.id === 'importFile') { var f = t.files[0]; if (f) importBackup(f); t.value = ''; return; }
  });

  viewSettings.addEventListener('blur', function (e) {
    var t = e.target; if (!t.matches('input')) return;
    var row = t.closest('.edit-row'); if (!row) return;
    if (t.matches('.emp-name')) {
      var oldName = row.dataset.emp, newName = t.value.trim();
      if (newName && newName !== oldName) {
        if (renameEmployee(oldName, newName)) { row.dataset.emp = newName; toast('Nome atualizado'); }
        else t.value = oldName;
      }
      return;
    }
    if (row.dataset.shift && t.matches('.shift-color, .shift-label, .shift-start, .shift-end, .shift-name-input')) {
      var id = row.dataset.shift; if (!state.shifts[id]) return;
      if (t.matches('.shift-color')) updateShiftField(id, 'color', t.value);
      else if (t.matches('.shift-label')) updateShiftField(id, 'label', t.value);
      else if (t.matches('.shift-start')) updateShiftField(id, 'start', t.value);
      else if (t.matches('.shift-end')) updateShiftField(id, 'end', t.value);
      else if (t.matches('.shift-name-input')) updateShiftField(id, 'name', t.value);
    }
  }, true);

  viewSettings.addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest('[data-del-emp]')) { deleteEmployee(t.closest('[data-del-emp]').dataset.delEmp); return; }
    if (t.closest('[data-del-shift]')) { deleteShift(t.closest('[data-del-shift]').dataset.delShift); return; }
    if (t.closest('[data-del-hol]')) { delete state.holidays[t.closest('[data-del-hol]').dataset.delHol]; save(); renderActive(); return; }
    if (t.id === 'addEmployeeBtn') { addEmployee(); return; }
    if (t.id === 'addWorkShiftBtn') { addWorkShift(); return; }
    if (t.id === 'addEventBtn') { addEvent(); return; }
    if (t.id === 'btnAuto') { autoFill(); return; }
    if (t.id === 'forceSyncBtn') {
      pendingSave = true; _syncState = 'pending'; updateStorageStatus();
      doSave().then(function () { if (_syncState === 'synced') toast('✓ Sincronizado'); });
      return;
    }
    if (t.id === 'downloadCsvBtn') { downloadCSV(); return; }
    if (t.id === 'importBtn') { document.getElementById('importFile').click(); return; }
    if (t.id === 'addHolBtn') {
      var d = document.getElementById('newHolDate').value;
      var n = document.getElementById('newHolName').value.trim() || 'Feriado';
      if (d) { state.holidays[d] = n; save(); renderActive(); }
      return;
    }
    if (t.id === 'clearMonthBtn') {
      showDialog({
        title: 'Limpar Escala', body: 'Apagar toda a escala deste mês?', confirmText: 'Limpar Tudo', isDanger: true, onConfirm: function () {
          var y = currentDate.getFullYear(), m = currentDate.getMonth(), n = daysInMonth(currentDate);
          for (var d = 1; d <= n; d++) delete state.schedule[dateKey(y, m, d)];
          save(); renderActive(); toast('Mês limpo');
        }
      });
      return;
    }
    if (t.id === 'resetBtn') {
      showDialog({
        title: 'Apagar Tudo', body: 'Apagar <strong>TODOS os dados</strong>? Ação irreversível.', confirmText: 'Apagar Tudo', isDanger: true, onConfirm: function () {
          state = getDefaultState(); save(); renderActive(); toast('Dados apagados');
        }
      });
      return;
    }
  });

  // Expor funções para os botões inline do HTML (Logout / Trocar de Time)
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

  // Inicia a aplicação checando a sessão
  initApp();
})();