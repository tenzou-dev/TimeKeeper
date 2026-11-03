/* StageTimer — login operator */
(function () {
  'use strict';

  var form = document.getElementById('loginForm');
  var emailInput = document.getElementById('email');
  var passwordInput = document.getElementById('password');
  var toggle = document.getElementById('togglePassword');
  var submit = document.getElementById('loginSubmit');
  var submitText = document.getElementById('loginSubmitText');
  var errorBox = document.getElementById('loginError');
  var notice = document.getElementById('configNotice');
  var githubBlock = document.getElementById('githubBlock');
  var githubLogin = document.getElementById('githubLogin');
  var loginDivider = document.getElementById('loginDivider');

  /** Hanya izinkan path internal, supaya ?next= tidak bisa dipakai redirect ke situs lain. */
  function safeNext(value) {
    var next = String(value || '');
    if (!next || next.charAt(0) !== '/' || next.charAt(1) === '/') return '/';
    if (next.indexOf('\\') !== -1) return '/';
    if (/^\/(login|login\.html)(\?|$)/i.test(next)) return '/';
    return next;
  }

  var params = new URLSearchParams(location.search);
  var next = safeNext(params.get('next'));

  if (githubLogin) {
    githubLogin.href = '/api/auth/github?next=' + encodeURIComponent(next);
  }

  fetch('/api/config', { headers: { Accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('config');
      return res.json();
    })
    .then(function (config) {
      var github = Boolean(config && config.githubAuth);
      var password = Boolean(config && config.authConfigured);

      githubBlock.hidden = !github;
      form.hidden = !password;
      loginDivider.hidden = !(github && password);

      if (!github && !password) notice.hidden = false;
    })
    .catch(function () {
      /* diabaikan */
    });

  function showError(message) {
    errorBox.textContent = message || 'Tidak bisa masuk. Coba lagi.';
    errorBox.hidden = false;
  }

  var oauthError = params.get('error');
  if (oauthError) {
    var messages = {
      github: 'Login GitHub gagal. Coba lagi.',
      github_failed: 'Login GitHub gagal. Coba lagi.',
      github_denied: 'Login GitHub dibatalkan.',
      github_state: 'Sesi login GitHub kedaluwarsa. Coba masuk lagi.',
      github_unconfigured: 'Login GitHub belum diatur oleh admin server.',
    };
    showError(messages[oauthError] || 'Login GitHub gagal. Coba lagi.');
  }

  function hideError() {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function setBusy(busy) {
    submit.disabled = busy;
    submitText.textContent = busy ? 'Memproses…' : 'Masuk';
  }

  toggle.addEventListener('click', function () {
    var show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Sembunyikan' : 'Lihat';
    toggle.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
    toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
    passwordInput.focus();
  });

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    hideError();

    var email = emailInput.value.trim();
    var password = passwordInput.value;

    if (!email || !password) {
      showError('Email dan password wajib diisi.');
      (email ? passwordInput : emailInput).focus();
      return;
    }

    setBusy(true);

    try {
      var res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      });

      var data = {};
      try {
        data = await res.json();
      } catch (e) {
        /* diabaikan */
      }

      if (!res.ok) {
        setBusy(false);
        showError(data.error || 'Email atau password salah.');
        passwordInput.select();
        return;
      }

      location.replace(next);
    } catch (err) {
      setBusy(false);
      showError('Tidak dapat menghubungi server. Periksa koneksi internet lalu coba lagi.');
    }
  });

  emailInput.addEventListener('input', hideError);
  passwordInput.addEventListener('input', hideError);
})();
