// 1. Inject the Spy script into the MAIN world
const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
script.onload = function() {
    this.remove(); // Clean up after injection
};
(document.head || document.documentElement).appendChild(script);

// 2. Listen for messages from the Spy script
window.addEventListener('message', function(event) {
    // Only accept messages from the same frame
    if (event.source !== window) return;
    
    if (event.data && event.data.source === 'dev-helper-spy') {
        const payload = event.data.payload;
        
        // Relay to the background script
        chrome.runtime.sendMessage({
            action: 'log_event',
            data: payload
        });
    }
});
