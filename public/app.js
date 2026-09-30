const $ = id => document.getElementById(id);
const histories = { cpu: [], mem: [], disk: [] };
const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let value = bytes; let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400); const hours = Math.floor(seconds % 86400 / 3600); const minutes = Math.floor(seconds % 3600 / 60);
  return `${days ? `${days}d ` : ''}${hours}h ${minutes}m`;
}
function setMetric(key, value, used, total) {
  const percent = clamp(value); $(key + '-value').textContent = Math.round(percent);
  $(key + '-meter').style.width = `${percent}%`;
  $(key + '-state').textContent = percent > 85 ? 'HIGH' : percent > 65 ? 'MODERATE' : 'NORMAL';
  if (used) $(key + '-used').textContent = used;
  if (total) $(key + '-total').textContent = total;
  histories[key].push(percent); if (histories[key].length > 28) histories[key].shift();
  const spark = $(`${key}-spark`);
  if (spark && histories[key].length > 1) {
    const points = histories[key].map((sample, index) => `${(index / (histories[key].length - 1)) * 240},${22 - sample * .19}`).join(' ');
    spark.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(`<svg viewBox="0 0 240 24" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><polyline points="${points}" fill="none" stroke="#b5f365" stroke-width="1.5"/></svg>`)}")`;
  }
}
function renderProcesses(processes) {
  $('process-count').textContent = `${processes.length} ACTIVE`;
  if (!processes.length) { $('process-rows').innerHTML = '<tr><td colspan="5" class="empty-state">No process data available</td></tr>'; return; }
  $('process-rows').innerHTML = processes.slice(0, 7).map((p, i) => `<tr><td><span class="process-name"><span class="process-glyph" data-index="${i % 3}">${p.name.slice(0, 1).toUpperCase()}</span>${escapeHtml(p.name)}</span></td><td class="pid">${p.pid}</td><td class="value-cell">${p.cpu.toFixed(1)}%</td><td class="value-cell">${p.memory.toFixed(1)}%</td><td class="state-cell"><span>${escapeHtml(p.state)}</span></td></tr>`).join('');
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
function render(data) {
  const { host, cpu, memory, disk, temperature, interfaces, processes } = data;
  $('error-banner').hidden = true;
  $('hostname').textContent = host.hostname; $('side-host').textContent = host.hostname;
  const osName = ({ linux: 'Linux', darwin: 'macOS', win32: 'Windows' })[host.platform] || host.platform;
  $('host-detail').textContent = `${osName} ${host.release} · ${host.arch}`; $('side-os').textContent = `${osName} · ${host.arch}`;
  $('cpu-model').textContent = cpu.model; $('cpu-cores').textContent = `${cpu.cores} cores`;
  $('detail-os').textContent = `${osName} ${host.release}`; $('detail-cpu').textContent = cpu.model;
  $('detail-arch').textContent = `${host.arch} · ${cpu.cores} logical cores`; $('detail-uptime').textContent = formatUptime(host.uptime);
  $('detail-network').textContent = interfaces.length ? interfaces.map(x => x.address).join(', ') : 'No external interface';
  setMetric('cpu', cpu.usage); setMetric('mem', memory.percent, `${formatBytes(memory.used)} used`, `${formatBytes(memory.total)} total`);
  if (disk) setMetric('disk', disk.percent, `${formatBytes(disk.used)} used`, `${formatBytes(disk.total)} total`);
  if (temperature === null) { $('temp-value').textContent = '—'; $('temp-label').textContent = 'Sensor data unavailable'; $('temp-bar').style.left = '0'; }
  else { $('temp-value').textContent = temperature; $('temp-label').textContent = temperature >= 85 ? 'Running hot' : temperature >= 70 ? 'Elevated temperature' : 'Within normal range'; $('temp-bar').style.left = `${clamp(temperature)}%`; }
  renderProcesses(processes);
  $('updated-at').textContent = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
async function refresh() {
  try { const response = await fetch('/api/snapshot', { cache: 'no-store' }); if (response.status === 401) { location.replace('/'); return; } if (!response.ok) throw new Error('Snapshot unavailable'); render(await response.json()); }
  catch { $('error-banner').hidden = false; $('hostname').textContent = 'Monitor service offline'; $('side-host').textContent = 'Service offline'; }
}
$('refresh').addEventListener('click', refresh);
const pageInfo = {
  processes: ['LIVE PROCESSES', 'Processes', 'Inspect CPU and memory use for every running process.'],
  services: ['SYSTEMD', 'Services', 'Inspect system services and request start, stop, or restart actions.'],
  logs: ['SYSTEM JOURNAL', 'Logs', 'Recent system journal entries, newest first.'],
  storage: ['BLOCK DEVICES', 'Storage', 'Disks, partitions, filesystems, and mounted volumes.'],
  network: ['NETWORK STATUS', 'Networking', 'Interfaces, assigned addresses, and default routes.'],
  updates: ['PACKAGE MANAGER', 'Software updates', 'Available Debian package updates from the local package index.'],
  packages: ['SOFTWARE INVENTORY', 'Installed packages', 'Installed packages detected in the dpkg database.'],
  accounts: ['LOCAL USERS', 'Accounts', 'Human user accounts found in the local account directory.'],
  firewall: ['FIREWALL STATUS', 'Firewall', 'Status from UFW or firewalld, when installed.'],
  containers: ['CONTAINER RUNTIME', 'Containers', 'Containers reported by Docker or Podman.'],
  'virtual-machines': ['LIBVIRT', 'Virtual machines', 'Virtual machines reported by libvirt.'],
  ssh: ['REMOTE SHELL', 'SSH connection', 'Open a remote shell using your existing OpenSSH configuration.'],
  tmate: ['TERMINAL SHARING', 'tmate sharing', 'Create a temporary, shareable terminal session.'],
  sshx: ['COLLABORATIVE TERMINAL', 'sshx sharing', 'Share a browser terminal with sshx.'],
};
let currentPage = 'overview';
let currentModuleData = null;
let terminalReturnPage = 'overview';
function moduleSummary(items, label) { return `<div class="summary-chip"><b>${items.length}</b><span>${escapeHtml(label)}</span></div>`; }
function moduleTable(headers, rows) {
  if (!rows.length) return '<div class="module-empty">No matching items were reported by this system.</div>';
  return `<div class="data-table-wrap"><table class="data-table"><thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
function statusPill(text, good = false) { return `<span class="module-status ${good ? 'good' : ''}">${escapeHtml(text || 'unknown')}</span>`; }
function renderModule(page, data) {
  currentModuleData = data;
  const items = data.items || data.devices || [];
  $('module-notice').hidden = !!data.available;
  $('module-notice').textContent = data.reason || 'This feature is not available on this host.';
  $('module-summary').innerHTML = data.available ? moduleSummary(items, ({ processes:'running processes',services:'services',logs:'journal entries',storage:'block devices',network:'interfaces',updates:'available updates',packages:'installed packages',accounts:'user accounts',containers:'containers','virtual-machines':'virtual machines' })[page] || 'items') : '';
  $('module-search').placeholder = page === 'logs' ? 'Search log messages' : 'Filter results';
  if (page === 'services') {
    $('module-content').innerHTML = moduleTable(['SERVICE','DESCRIPTION','STATE','ACTIONS'], items.map(item => `<tr data-filter="${escapeHtml(`${item.name} ${item.description} ${item.active} ${item.sub}`.toLowerCase())}"><td><b>${escapeHtml(item.name)}</b><small class="cell-sub">${escapeHtml(item.load)}</small></td><td>${escapeHtml(item.description || '—')}</td><td>${statusPill(`${item.active} · ${item.sub}`, item.active === 'active')}</td><td class="action-cell"><button data-service-action="${escapeHtml(item.active === 'active' ? 'stop' : 'start')}" data-service="${escapeHtml(item.name)}">${item.active === 'active' ? 'Stop' : 'Start'}</button><button data-service-action="restart" data-service="${escapeHtml(item.name)}">Restart</button></td></tr>`));
  } else if (page === 'processes') {
    $('module-content').innerHTML = moduleTable(['PROCESS','PID','CPU','MEMORY','RSS','STATE',''], items.map(item => `<tr data-filter="${escapeHtml(`${item.name} ${item.pid} ${item.state}`.toLowerCase())}"><td><b>${escapeHtml(item.name)}</b></td><td>${item.pid}</td><td>${item.cpu.toFixed(1)}%</td><td>${item.memory.toFixed(1)}%</td><td>${formatBytes(item.rss)}</td><td>${statusPill(item.state, item.state.startsWith('S'))}</td><td class="action-cell"><button class="danger-action" data-kill-process="${item.pid}">End</button></td></tr>`));
  } else if (page === 'logs') {
    const filtered = items.filter(line => line.toLowerCase().includes($('module-search').value.toLowerCase()));
    $('module-content').innerHTML = `<div class="log-view">${filtered.length ? filtered.map(line => `<div class="log-line" data-filter="${escapeHtml(line.toLowerCase())}">${escapeHtml(line)}</div>`).join('') : '<div class="module-empty">No log entries match this filter.</div>'}</div>`;
  } else if (page === 'storage') {
    const flatten = (devices, depth = 0) => devices.flatMap(item => [`<article class="inventory-card" data-filter="${escapeHtml(`${item.name} ${item.model || ''} ${item.type} ${item.fstype || ''} ${(item.mountpoints || []).join(' ')}`.toLowerCase())}"><div class="inventory-icon">▣</div><div class="inventory-copy"><b>${escapeHtml(item.name)} ${item.model ? `· ${escapeHtml(item.model)}` : ''}</b><small>${escapeHtml(item.type)}${item.fstype ? ` · ${escapeHtml(item.fstype)}` : ''}</small></div><div class="inventory-meta"><b>${formatBytes(Number(item.size))}</b><small>${escapeHtml((item.mountpoints || []).filter(Boolean).join(', ') || 'Not mounted')}</small></div></article>`, ...(item.children ? flatten(item.children, depth + 1) : [])]);
    $('module-content').innerHTML = data.available ? `<div class="inventory-list">${flatten(data.devices).join('')}</div>` : '';
  } else if (page === 'network') {
    const routes = (data.routes || []).map(route => `<div class="route-row"><span>DEFAULT ROUTE</span><b>${escapeHtml(route)}</b></div>`).join('');
    $('module-content').innerHTML = `<div class="network-grid">${items.map(item => `<article class="network-card" data-filter="${escapeHtml(`${item.name} ${item.mac} ${(item.addresses || []).join(' ')}`.toLowerCase())}"><div class="network-card-head"><span class="network-glyph">⌁</span><b>${escapeHtml(item.name)}</b>${statusPill(item.state, item.state === 'UP')}</div><div class="network-attrs"><div><small>MAC ADDRESS</small><b>${escapeHtml(item.mac)}</b></div><div><small>MTU</small><b>${escapeHtml(item.mtu || '—')}</b></div><div class="addresses"><small>ADDRESSES</small><b>${(item.addresses || []).map(escapeHtml).join('<br>') || 'No address assigned'}</b></div></div></article>`).join('')}</div><div class="route-list">${routes || '<div class="module-empty">No default route reported.</div>'}</div>`;
  } else if (page === 'accounts') {
    $('module-content').innerHTML = moduleTable(['USER','UID','PRIMARY GROUP','HOME','LOGIN SHELL'], items.map(item => `<tr data-filter="${escapeHtml(`${item.name} ${item.gecos} ${item.home} ${item.shell}`.toLowerCase())}"><td><b>${escapeHtml(item.name)}</b><small class="cell-sub">${escapeHtml(item.gecos || 'Local user')}</small></td><td>${item.uid}</td><td>${item.gid}</td><td>${escapeHtml(item.home)}</td><td>${escapeHtml(item.shell)}</td></tr>`));
  } else if (page === 'updates' || page === 'packages') {
    $('module-content').innerHTML = data.available ? moduleTable(page === 'updates' ? ['PACKAGE','INSTALLED','AVAILABLE'] : ['PACKAGE','VERSION'], items.map(item => `<tr data-filter="${escapeHtml(`${item.name} ${item.version || ''} ${item.current || ''} ${item.candidate || ''}`.toLowerCase())}"><td><b>${escapeHtml(item.name)}</b></td>${page === 'updates' ? `<td>${escapeHtml(item.current)}</td><td>${escapeHtml(item.candidate)}</td>` : `<td>${escapeHtml(item.version)}</td>`}</tr>`)) : '';
    if (page === 'updates' && data.available && !items.length) $('module-content').innerHTML = '<div class="module-empty success-empty">System is up to date according to the current package index.</div>';
  } else if (page === 'firewall') {
    $('module-content').innerHTML = data.available ? `<article class="inventory-card firewall-card"><div class="inventory-icon">⬡</div><div class="inventory-copy"><b>${escapeHtml(data.provider)} firewall</b><small>${data.reason ? escapeHtml(data.reason) : 'Detected firewall manager'}</small></div>${statusPill(data.status.split('\n')[0], /active|running/i.test(data.status))}</article><pre class="firewall-output">${escapeHtml(data.status)}</pre>` : '';
  } else if (page === 'containers') {
    $('module-content').innerHTML = moduleTable(['CONTAINER','IMAGE','STATUS','PORTS','ID'], items.map(item => `<tr data-filter="${escapeHtml(`${item.name} ${item.image} ${item.status} ${item.ports}`.toLowerCase())}"><td><b>${escapeHtml(item.name)}</b></td><td>${escapeHtml(item.image)}</td><td>${statusPill(item.status, /up|running/i.test(item.status))}</td><td>${escapeHtml(item.ports || '—')}</td><td><code>${escapeHtml(item.id)}</code></td></tr>`));
  } else if (page === 'virtual-machines') {
    $('module-content').innerHTML = moduleTable(['VIRTUAL MACHINE','STATE'], items.map(item => `<tr data-filter="${escapeHtml(`${item.name} ${item.state}`.toLowerCase())}"><td><b>${escapeHtml(item.name)}</b></td><td>${statusPill(item.state, item.state === 'running')}</td></tr>`));
  }
  applyModuleFilter();
}
function applyModuleFilter() {
  const query = $('module-search').value.trim().toLowerCase();
  $('module-content').querySelectorAll('[data-filter]').forEach(row => { row.hidden = !row.dataset.filter.includes(query); });
}
async function loadModule(page) {
  $('module-eyebrow').textContent = pageInfo[page][0]; $('module-title').textContent = pageInfo[page][1]; $('module-description').textContent = pageInfo[page][2];
  $('module-search').closest('label').hidden = false; $('module-refresh').hidden = false;
  $('module-search').value = ''; $('module-notice').hidden = true; $('module-summary').innerHTML = ''; $('module-content').innerHTML = '<div class="module-empty">Loading system information…</div>';
  try {
    const url = page === 'processes' ? '/api/processes' : `/api/system/${page}`;
    const response = await fetch(url, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load system information.');
    renderModule(page, data);
  } catch (error) { $('module-notice').hidden = false; $('module-notice').textContent = error.message; $('module-content').innerHTML = ''; }
}
function renderToolPage(page) {
  $('module-eyebrow').textContent = pageInfo[page][0]; $('module-title').textContent = pageInfo[page][1]; $('module-description').textContent = pageInfo[page][2];
  $('module-notice').hidden = true; $('module-summary').innerHTML = '';
  $('module-search').closest('label').hidden = true; $('module-refresh').hidden = true;
  if (page === 'ssh') {
    $('module-content').innerHTML = `<div class="tool-form-wrap"><form id="ssh-connect-form" class="tool-form"><div class="tool-form-top"><span class="tool-form-icon">⇄</span><div><b>Connect to a host</b><small>Enter the remote host details. Your SSH keys, agent, and known_hosts are used automatically.</small></div></div><label>HOST OR IP ADDRESS<input name="host" required maxlength="253" placeholder="server.example.com or 192.168.1.10" autocomplete="url"></label><div class="tool-form-row"><label>USERNAME <span class="optional-label">OPTIONAL</span><input name="user" maxlength="32" placeholder="Uses current username" autocomplete="username"></label><label>SSH PORT<input name="port" type="number" min="1" max="65535" value="22" required></label></div><div class="tool-form-note">Password and host-key prompts appear in the terminal. Credentials are not stored by this app.</div><button class="primary-action" type="submit">Connect over SSH <span>→</span></button></form></div>`;
  } else if (page === 'tmate') {
    $('module-content').innerHTML = `<div class="tool-form-wrap"><div class="tmate-card"><span class="tool-form-icon">◉</span><div class="tmate-copy"><div class="eyebrow">SHARE A LIVE SHELL</div><h2>Temporary terminal access</h2><p>Start tmate to create a one-time SSH and browser link for this machine. The session runs with your current user’s permissions.</p><div class="tmate-warning"><b>Anyone with the link can access this shell.</b> Only share it with people you trust. The link is not saved by this app; stop the session to revoke access.</div><button class="primary-action" id="start-tmate" type="button">Start tmate session <span>→</span></button></div></div></div>`;
  } else {
    $('module-content').innerHTML = `<div class="tool-form-wrap"><div class="tmate-card"><span class="tool-form-icon">↗</span><div class="tmate-copy"><div class="eyebrow">COLLABORATIVE TERMINAL</div><h2>Share a secure browser terminal</h2><p>Start sshx to create a collaborative browser terminal link. The sshx project describes its sessions as end-to-end encrypted.</p><div class="tmate-warning"><b>Anyone with the link can interact with this shell.</b> Only share it with people you trust. Stop the session to end access.</div><button class="primary-action" id="start-sshx" type="button">Start sshx session <span>→</span></button></div></div></div>`;
  }
}
function startInteractiveSession(options, returnPage) {
  terminalReturnPage = returnPage;
  currentPage = returnPage;
  $('module-view').hidden = true; $('dashboard-view').hidden = true; terminalView.hidden = false;
  document.querySelectorAll('.nav-item[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === returnPage));
  document.querySelector('.breadcrumbs b').textContent = returnPage === 'ssh' ? 'SSH session' : `${returnPage} sharing`;
  openTerminal(options);
}
$('module-search').addEventListener('input', applyModuleFilter);
$('module-refresh').addEventListener('click', () => { if (pageInfo[currentPage]) loadModule(currentPage); });
$('module-content').addEventListener('click', async event => {
  if (event.target.closest('#start-tmate, #start-sshx')) {
    const type = event.target.closest('#start-sshx') ? 'sshx' : 'tmate';
    if (!confirm(`Start a ${type} session? Anyone with its access link can control a shell on this machine.`)) return;
    startInteractiveSession({ type }, type);
    return;
  }
  const serviceButton = event.target.closest('[data-service-action]');
  if (serviceButton) {
    const action = serviceButton.dataset.serviceAction; const name = serviceButton.dataset.service;
    if (!confirm(`${action[0].toUpperCase()}${action.slice(1)} ${name}?`)) return;
    try {
      const response = await fetch('/api/system/service-action', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ name, action }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      $('module-notice').hidden = false; $('module-notice').textContent = result.message; loadModule('services');
    } catch (error) { $('module-notice').hidden = false; $('module-notice').textContent = error.message; }
    return;
  }
  const processButton = event.target.closest('[data-kill-process]');
  if (processButton) {
    const pid = Number(processButton.dataset.killProcess);
    if (!confirm(`Send a termination signal to process ${pid}? Unsaved work in that process may be lost.`)) return;
    try {
      const response = await fetch('/api/processes', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({pid}) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      loadModule('processes');
    } catch (error) { $('module-notice').hidden = false; $('module-notice').textContent = error.message; }
  }
});
$('module-content').addEventListener('submit', event => {
  if (event.target.id !== 'ssh-connect-form') return;
  event.preventDefault();
  const form = new FormData(event.target);
  const host = String(form.get('host') || '').trim();
  const user = String(form.get('user') || '').trim();
  const port = Number(form.get('port'));
  startInteractiveSession({ type: 'ssh', host, user, port }, 'ssh');
});
let terminalId = null;
let terminalPoll = null;
let terminalOpening = false;
const terminalView = $('terminal-view');
async function readApi(response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error('The running server does not have the terminal API loaded. Restart it with `node server.js`, then reload this page.'); }
}
function appendTerminal(text) {
  const clean = text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '');
  const output = $('terminal-output');
  const fragment = document.createDocumentFragment();
  clean.split(/(https?:\/\/[^\s<>"']+)/g).forEach(part => {
    if (/^https?:\/\//i.test(part)) {
      const link = document.createElement('a'); link.href = part.replace(/[),.;]+$/, ''); link.textContent = link.href;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; fragment.append(link);
      if (link.href.length < part.length) fragment.append(document.createTextNode(part.slice(link.href.length)));
    } else fragment.append(document.createTextNode(part));
  });
  output.append(fragment); output.scrollTop = output.scrollHeight;
}
async function openTerminal(options = { type: 'local' }) {
  if (terminalOpening || terminalId) return;
  terminalOpening = true;
  $('dashboard-view').hidden = true;
  terminalView.hidden = false;
  const label = options.type === 'ssh' ? `SSH · ${options.host}` : options.type === 'tmate' ? 'tmate session' : options.type === 'sshx' ? 'sshx session' : 'Terminal';
  document.querySelector('.breadcrumbs b').textContent = label;
  $('terminal-output').textContent = '';
  $('terminal-title').textContent = 'Terminal — connecting…';
  try {
    const response = await fetch('/api/terminal/session', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(options) });
    const data = await readApi(response);
    if (!response.ok) throw new Error(data.error || 'Could not start terminal session');
    terminalId = data.id;
    $('terminal-title').textContent = options.type === 'ssh' ? `SSH — ${options.user ? `${options.user}@` : ''}${options.host}` : options.type === 'tmate' ? 'tmate — starting shared session' : options.type === 'sshx' ? 'sshx — starting shared session' : `Terminal — ${location.hostname}`;
    $('terminal-input').disabled = false;
    $('terminal-input').focus();
    if (options.type === 'tmate') appendTerminal('Starting tmate. Wait for the SSH and web access links below, then share them only with trusted people.\r\n\r\n');
    else if (options.type === 'sshx') appendTerminal('Starting sshx. Wait for the secure browser link below, then share it only with trusted people.\r\n\r\n');
    else if (options.type === 'ssh') appendTerminal(`Connecting to ${options.user ? `${options.user}@` : ''}${options.host}:${options.port}…\r\n\r\n`);
    else appendTerminal('Connected to your machine. Commands run with your current user permissions.\r\n\r\n');
    terminalPoll = setInterval(async () => {
      if (!terminalId) return;
      try {
        const result = await fetch(`/api/terminal/session/${terminalId}`, { cache: 'no-store' });
        const payload = await readApi(result);
        if (!result.ok) throw new Error(payload.error);
        if (payload.output) appendTerminal(payload.output);
        if (payload.closed) { $('terminal-input').disabled = true; clearInterval(terminalPoll); }
      } catch (error) { appendTerminal(`\r\n${error.message}\r\n`); closeTerminalSession(); }
    }, 250);
  } catch (error) {
    appendTerminal(`Could not open terminal: ${error.message}\r\n`);
    $('terminal-title').textContent = 'Terminal — unavailable';
  } finally { terminalOpening = false; }
}
async function closeTerminalSession() {
  if (terminalPoll) clearInterval(terminalPoll);
  terminalPoll = null;
  const id = terminalId;
  terminalId = null;
  $('terminal-input').disabled = true;
  if (id) { try { await fetch(`/api/terminal/session/${id}`, { method: 'DELETE' }); } catch {} }
}
async function navigate(page) {
  await closeTerminalSession();
  currentPage = page;
  document.querySelectorAll('.nav-item[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  document.querySelector('.breadcrumbs b').textContent = page === 'overview' ? 'Overview' : pageInfo[page]?.[1] || page;
  if (page === 'terminal') {
    terminalReturnPage = 'overview';
    $('dashboard-view').hidden = true; $('module-view').hidden = true; terminalView.hidden = false;
    openTerminal({ type: 'local' }); return;
  }
  terminalView.hidden = true;
  if (page === 'overview') {
    $('module-view').hidden = true; $('dashboard-view').hidden = false; refresh();
  } else {
    $('dashboard-view').hidden = true; $('module-view').hidden = false;
    if (page === 'ssh' || page === 'tmate' || page === 'sshx') renderToolPage(page);
    else loadModule(page);
  }
}
$('terminal-close').addEventListener('click', () => navigate('overview'));
document.getElementById('logout').addEventListener('click', async () => {
  await closeTerminalSession();
  try { await fetch('/api/auth/logout', { method: 'POST' }); } finally { location.replace('/'); }
});
document.querySelectorAll('.nav-item[data-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)));
$('terminal-clear').addEventListener('click', () => { $('terminal-output').textContent = ''; $('terminal-input').focus(); });
async function sendTerminalInput(value) {
  if (!terminalId) return;
  const response = await fetch(`/api/terminal/session/${terminalId}/input`, {
    method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ input: value }),
  });
  if (!response.ok) appendTerminal(`\r\n${(await response.json()).error}\r\n`);
}
$('terminal-input').addEventListener('keydown', event => {
  if (event.ctrlKey && event.key.toLowerCase() === 'c' && terminalId) {
    event.preventDefault(); sendTerminalInput('\x03').catch(() => appendTerminal('\r\nCould not interrupt the running command.\r\n'));
  }
});
$('terminal-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('terminal-input');
  const command = input.value;
  if (!command.trim() || !terminalId) return;
  input.value = '';
  try { await sendTerminalInput(command + '\n'); }
  catch { appendTerminal('\r\nTerminal connection lost.\r\n'); }
});
window.addEventListener('pagehide', () => { if (terminalId) navigator.sendBeacon(`/api/terminal/session/${terminalId}/close`); });
fetch('/api/auth/status', { cache: 'no-store' }).then(response => response.json()).then(data => {
  if (!data.authenticated) { location.replace('/'); return; }
  refresh(); setInterval(refresh, 3000);
}).catch(() => location.replace('/'));
