// Keep track of errors per tab
const tabStates = {};

chrome.runtime.onInstalled.addListener(() => {
    // Allow users to open the side panel by clicking on the action toolbar icon
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => console.error(error));
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'log_event' && sender.tab) {
        const tabId = sender.tab.id;
        
        if (!tabStates[tabId]) {
            tabStates[tabId] = { errors: [], warnings: [] };
        }

        const payload = request.data;
        payload.timestamp = Date.now();

        if (payload.type.includes('error') || payload.type.includes('rejection')) {
            tabStates[tabId].errors.push(payload);
        } else if (payload.type.includes('warn')) {
            tabStates[tabId].warnings.push(payload);
        }

        // Notify the side panel if it's open
        chrome.runtime.sendMessage({
            action: 'state_updated',
            tabId: tabId,
            state: tabStates[tabId]
        }).catch(() => {
            // Side panel might be closed, ignore error
        });
    } else if (request.action === 'clear_state') {
        // User clicked the clear/trash button in the side panel
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length > 0) {
                const tabId = tabs[0].id;
                tabStates[tabId] = { errors: [], warnings: [] };
                chrome.runtime.sendMessage({
                    action: 'state_updated',
                    tabId: tabId,
                    state: tabStates[tabId]
                }).catch(() => {});
            }
        });
    } else if (request.action === 'get_state') {
        // Called by the side panel when it opens to get current state
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length > 0) {
                const tabId = tabs[0].id;
                sendResponse(tabStates[tabId] || { errors: [], warnings: [] });
            } else {
                sendResponse({ errors: [], warnings: [] });
            }
        });
        return true; // Keep channel open for async response
    }
});

// Clean up when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
    delete tabStates[tabId];
});

// Clear state on reload
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        tabStates[tabId] = { errors: [], warnings: [] };
        chrome.runtime.sendMessage({
            action: 'state_updated',
            tabId: tabId,
            state: tabStates[tabId]
        }).catch(() => {});
    }
});
