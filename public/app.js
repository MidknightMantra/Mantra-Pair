/* global EventSource */
(() => {
  'use strict';

  const REQUEST_TIMEOUT_MS = 130000;

  let mode = 'code';
  let es = null;

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(text, hint) {
    const box = $('status');
    const on = Boolean(text && text !== 'Idle');
    box.classList.toggle('is-on', on);
    $('statusText').textContent = text || 'Idle';
    $('statusHint').textContent = hint || '';
  }

  function setLoading(which, on) {
    if (which === 'code') {
      $('btnCode').disabled = on;
      $('btnCodeText').innerHTML = on ? '<span class="loading"></span>Connecting...' : 'Generate Pairing Code';
    } else {
      $('btnQr').disabled = on;
      $('btnQrText').innerHTML = on ? '<span class="loading"></span>Generating...' : 'Generate QR Code';
    }
  }

  function hideResults() {
    $('resultCode').classList.remove('is-on');
    $('resultQr').classList.remove('is-on');
  }

  function teardown() {
    if (es) {
      try { es.close(); } catch (_) {}
      es = null;
    }
  }

  async function safeJson(res) {
    try { return await res.json(); } catch (_) { return {}; }
  }

  async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...(init || {}), signal: controller.signal, cache: 'no-store' });
    } finally {
      clearTimeout(t);
    }
  }

  function startEvents(id, streamKey) {
    teardown();

    const url = streamKey ? `/api/sessions/${encodeURIComponent(id)}/events?key=${encodeURIComponent(streamKey)}` : `/api/sessions/${encodeURIComponent(id)}/events`;
    es = new EventSource(url);

    es.addEventListener('status', (ev) => {
      try {
        const d = JSON.parse(ev.data || '{}');
        const st = d.status || 'working';
        let hint = '';
        if (st === 'requesting_code') hint = 'Waiting for pairing code...';
        if (st === 'waiting_qr') hint = 'Waiting for QR from WhatsApp...';
        if (st === 'connected') hint = 'Connected. Sending session to your WhatsApp...';
        setStatus(st, hint);
      } catch (_) {}
    });

    es.addEventListener('code', (ev) => {
      const d = JSON.parse(ev.data || '{}');
      if (!d.code) return;
      $('pairCode').textContent = d.code;
      $('resultCode').classList.add('is-on');
      setStatus('code_ready', 'Enter this code in WhatsApp -> Linked Devices.');
    });

    es.addEventListener('qr', (ev) => {
      const d = JSON.parse(ev.data || '{}');
      if (!d.qr) return;
      $('qrBox').innerHTML = `<img src="${d.qr}" alt="WhatsApp QR">`;
      $('resultQr').classList.add('is-on');
      setStatus('qr_ready', 'Scan this QR from WhatsApp -> Linked Devices.');
    });

    es.addEventListener('exported', () => {
      setStatus('done', 'Session was sent to your WhatsApp chat.');
    });

    es.addEventListener('error', (ev) => {
      let message = 'Session error.';
      try {
        const d = JSON.parse(ev.data || '{}');
        message = d.message || message;
      } catch (_) {}

      teardown();
      setLoading('code', false);
      setLoading('qr', false);

      const looksLikeCodeUnavailable =
        /(\b503\b|unavailable|temporarily unavailable|phone-number pairing|forbidden|\b403\b)/i.test(message);

      if (mode === 'code' && looksLikeCodeUnavailable) {
        const ok = window.confirm(
          `${message}\n\nSwitch to QR Scan instead?`
        );
        if (ok) {
          setMode('qr');
          setStatus('Idle', 'Switched to QR Scan. Tap "Generate QR Code".');
          return;
        }
      }

      alert(message);
    });
  }

  async function createSession(method) {
    const body = { method };
    if (method === 'code') {
      const phone = $('phone').value.replace(/[^0-9]/g, '');
      if (phone.length < 10) {
        alert('Invalid phone number. Use at least 10 digits with country code.');
        return null;
      }
      body.phone = phone;
    }

    const headers = { 'Content-Type': 'application/json' };
    // Optional protection: if you enable it, set window.MANTRA_API_KEY at build time or inject via your own wrapper.
    if (window.MANTRA_API_KEY) headers['x-api-key'] = window.MANTRA_API_KEY;

    const res = await fetchWithTimeout('/api/pair', { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await safeJson(res);
    if (!res.ok || !data.ok) {
      alert(data.error || 'Pairing failed.');
      return null;
    }
    return data;
  }

  async function onCode() {
    hideResults();
    setLoading('code', true);
    setStatus('starting', 'Creating session...');
    try {
      const data = await createSession('code');
      if (!data) return;
      startEvents(data.id, data.streamKey);
    } catch (e) {
      console.error(e);
      alert(e && e.message ? e.message : 'Connection timeout. Try again.');
    } finally {
      setLoading('code', false);
    }
  }

  async function onQr() {
    hideResults();
    setLoading('qr', true);
    setStatus('starting', 'Creating session...');
    try {
      const data = await createSession('qr');
      if (!data) return;
      startEvents(data.id, data.streamKey);
    } catch (e) {
      console.error(e);
      alert(e && e.message ? e.message : 'Connection timeout. Try again.');
    } finally {
      setLoading('qr', false);
    }
  }

  function setMode(next) {
    mode = next;

    $('tab-code').classList.toggle('active', next === 'code');
    $('tab-qr').classList.toggle('active', next === 'qr');
    $('tab-code').setAttribute('aria-selected', next === 'code' ? 'true' : 'false');
    $('tab-qr').setAttribute('aria-selected', next === 'qr' ? 'true' : 'false');

    $('mode-code').classList.toggle('is-hidden', next !== 'code');
    $('mode-qr').classList.toggle('is-hidden', next !== 'qr');

    teardown();
    hideResults();
    setStatus('Idle', '');
  }

  function reset() {
    teardown();
    window.location.reload();
  }

  window.addEventListener('DOMContentLoaded', () => {
    $('tab-code').addEventListener('click', () => setMode('code'));
    $('tab-qr').addEventListener('click', () => setMode('qr'));
    $('btnCode').addEventListener('click', onCode);
    $('btnQr').addEventListener('click', onQr);
    $('btnResetA').addEventListener('click', reset);
    $('btnResetB').addEventListener('click', reset);
    setMode(mode);
  });
})();
