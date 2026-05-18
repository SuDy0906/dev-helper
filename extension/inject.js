// This script is injected into the MAIN world to intercept native APIs

(function() {
  if (window.__devHelperSpyLoaded) return;
  window.__devHelperSpyLoaded = true;

  function sendToContentScript(type, data) {
    window.postMessage({
      source: 'dev-helper-spy',
      payload: { type, page_url: window.location.href, ...data }
    }, '*');
  }

  // 1. Intercept Console Errors/Warnings
  const originalError = console.error;
  const originalWarn = console.warn;

  console.error = function(...args) {
    originalError.apply(console, args);
    const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
    sendToContentScript('console_error', { message });
  };

  console.warn = function(...args) {
    originalWarn.apply(console, args);
    const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
    sendToContentScript('console_warn', { message });
  };

  // 2. Intercept Global Errors
  window.addEventListener('error', function(event) {
    let domSnippet = '';
    // If the error comes from a DOM element (like an image failing to load)
    if (event.target && event.target !== window && event.target.outerHTML) {
      domSnippet = event.target.outerHTML;
    }
    
    sendToContentScript('unhandled_error', {
      message: event.message || 'Unknown Error',
      stack: event.error ? event.error.stack : '',
      filename: event.filename,
      lineno: event.lineno,
      dom_snippet: domSnippet
    });
  }, true); // Use capture phase for resource loading errors

  // 3. Intercept Unhandled Promise Rejections
  window.addEventListener('unhandledrejection', function(event) {
    sendToContentScript('unhandled_rejection', {
      message: event.reason ? (event.reason.message || event.reason.toString()) : 'Promise Rejected',
      stack: event.reason && event.reason.stack ? event.reason.stack : ''
    });
  });

  // 4. Intercept Fetch API
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    try {
      const response = await originalFetch.apply(this, args);
      if (!response.ok) {
        sendToContentScript('network_error', {
          url: response.url,
          status: response.status,
          statusText: response.statusText,
          method: (args[1] && args[1].method) ? args[1].method : 'GET'
        });
      }
      return response;
    } catch (err) {
      sendToContentScript('network_error', {
        url: typeof args[0] === 'string' ? args[0] : (args[0].url || 'Unknown URL'),
        status: 0,
        statusText: 'Network Failure (CORS/Offline)',
        method: (args[1] && args[1].method) ? args[1].method : 'GET'
      });
      throw err;
    }
  };

  // 5. Intercept XMLHttpRequest
  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      if (this.status >= 400) {
        sendToContentScript('network_error', {
          url: this.responseURL,
          status: this.status,
          statusText: this.statusText,
          method: 'XHR'
        });
      }
    });
    this.addEventListener('error', function() {
      sendToContentScript('network_error', {
        url: this.responseURL || 'Unknown XHR URL',
        status: 0,
        statusText: 'XHR Network Failure',
        method: 'XHR'
      });
    });
    originalXHRSend.apply(this, args);
  };

})();
