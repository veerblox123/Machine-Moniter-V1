const form = document.getElementById('login-form');
const password = document.getElementById('login-password');
const error = document.getElementById('login-error');
const submit = form.querySelector('button[type="submit"]');

fetch('/api/auth/status', { cache: 'no-store' }).then(response => response.json()).then(data => {
  if (data.authenticated) location.replace('/');
  if (data.username) document.getElementById('login-username').textContent = data.username;
}).catch(() => {});

document.getElementById('password-toggle').addEventListener('click', event => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  event.currentTarget.textContent = visible ? 'Hide' : 'Show';
  event.currentTarget.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  password.focus();
});

form.addEventListener('submit', async event => {
  event.preventDefault(); error.hidden = true; submit.disabled = true;
  const label = submit.innerHTML; submit.innerHTML = '<span>Verifying locally…</span><b>·</b>';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: password.value }), cache: 'no-store',
    });
    const result = await response.json();
    password.value = '';
    if (!response.ok) throw new Error(result.error || 'Could not sign in.');
    location.replace('/');
  } catch (reason) {
    error.textContent = reason.message; error.hidden = false; password.focus();
  } finally { submit.disabled = false; submit.innerHTML = label; }
});
