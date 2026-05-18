// ─── app.js ──────────────────────────────────────────────────────────────────
// BuggyDash — intentional errors for DevHelper V2 testing
// Each function below triggers a different browser error type.
// ─────────────────────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════
// ERROR 1 — TypeError: Cannot read properties of undefined
// Triggered by: "Load User" button
// Root cause: user object is null; we try to access user.profile.name
// ════════════════════════════════════════════════════════════════
function loadUser() {
  const user = null;  // BUG: should be fetched from an API

  // This will throw: TypeError: Cannot read properties of null (reading 'profile')
  document.getElementById('user-name').textContent  = user.profile.name;
  document.getElementById('user-email').textContent = user.profile.email;
}

// ════════════════════════════════════════════════════════════════
// ERROR 2 — Network Error: 404 on fetch()
// Triggered by: "Fetch Stats" button
// Root cause: the endpoint /api/stats does not exist
// ════════════════════════════════════════════════════════════════
async function fetchStats() {
  const output = document.getElementById('stats-output');
  output.textContent = 'Fetching…';

  // BUG: this route does not exist → fetch will get a 404 but won't throw.
  // DevHelper intercepts non-ok responses.
  const response = await fetch('http://localhost:3000/api/stats');

  if (!response.ok) {
    // Intentionally NOT handling the error so DevHelper catches it
    output.textContent = `HTTP ${response.status} — ${response.statusText}`;
  }
}

// ════════════════════════════════════════════════════════════════
// ERROR 3 — Unhandled Promise Rejection
// Triggered by: "Process Payment" button
// Root cause: async function throws but caller has no .catch()
// ════════════════════════════════════════════════════════════════
async function chargeCard(amount) {
  await new Promise(resolve => setTimeout(resolve, 400)); // fake network delay
  // BUG: deliberately throw with no handler
  throw new Error(`Payment gateway rejected: invalid card token for amount $${amount}`);
}

function processPayment() {
  // BUG: no await + no .catch() = unhandled rejection
  chargeCard(49.99);
}

// ════════════════════════════════════════════════════════════════
// ERROR 4 — console.warn + console.error
// Triggered by: "Load Notifications" button
// Root cause: bad config object shape, deprecated API call
// ════════════════════════════════════════════════════════════════
function loadNotifications() {
  const config = {
    endpoint: undefined,   // BUG: should be set
    retries:  -1,          // BUG: invalid value
  };

  if (!config.endpoint) {
    console.warn('[Notifications] Config warning: endpoint is undefined — falling back to default.');
  }

  if (config.retries < 0) {
    console.error('[Notifications] Invalid retry count:', config.retries, '— must be >= 0');
  }

  // Pretend we loaded something
  document.getElementById('notif-count').textContent = '3 notifications (check console for warnings)';
}

// ════════════════════════════════════════════════════════════════
// ERROR 5 — DOM Resource Error (broken image)
// Auto-triggered on page load
// Root cause: <img> src points to a non-existent domain
// DevHelper captures this via window.onerror in capture phase
// ════════════════════════════════════════════════════════════════
// (The <img id="avatar-img"> in index.html has a broken src URL —
//  no JS needed, this fires automatically on page load)

// ════════════════════════════════════════════════════════════════
// ERROR 6 — XHR 500 Error
// Triggered by: "Load via XHR" button
// Root cause: server at /api/reports returns 500
//             (httpbin.org/status/500 simulates this)
// ════════════════════════════════════════════════════════════════
function loadReportsXHR() {
  const output = document.getElementById('reports-output');
  output.textContent = 'Loading via XHR…';

  const xhr = new XMLHttpRequest();
  // BUG: this endpoint returns HTTP 500
  xhr.open('GET', 'https://httpbin.org/status/500', true);

  xhr.onload = function () {
    if (this.status >= 400) {
      output.textContent = `XHR failed: ${this.status} ${this.statusText}`;
      // DevHelper intercepts this via the XHR monkey-patch in inject.js
    }
  };

  xhr.onerror = function () {
    output.textContent = 'XHR network failure';
  };

  xhr.send();
}
