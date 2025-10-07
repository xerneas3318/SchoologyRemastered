// Track processed files by their base ID to prevent loops
let processedFiles = new Set();

// Listen for completed requests to detect and cache files
chrome.webRequest.onCompleted.addListener(
    async (details) => {
        const url = details.url;
        
        
        // Only catch actual document files from Schoology CDN
        const isSchoologyFile = url.includes('files-cdn.schoology.com') && 
                               (url.includes('content-type=application') || url.includes('content-disposition=attachment'));
        
        if (isSchoologyFile) {
            // Extract base file ID (before query parameters) to prevent loops
            const baseFileId = url.split('/').pop().split('?')[0];
            
            // Skip if we already processed this file ID
            if (processedFiles.has(baseFileId)) {
                return;
            }
            
            // Mark this file ID as processed
            processedFiles.add(baseFileId);
            
            // Extract clean filename from URL
            let fileName = url.split('/').pop().split('?')[0];
            
            // Try to extract original filename from content-disposition header
            const contentDispositionMatch = url.match(/filename%3D%22([^%]+)/);
            if (contentDispositionMatch) {
                const originalFileName = decodeURIComponent(contentDispositionMatch[1]);
                console.log('Original filename from content-disposition:', originalFileName);
                fileName = originalFileName;
            } else if (!fileName.includes('.')) {
                // Only add .pdf if no extension and URL explicitly contains .pdf
                if (url.includes('.pdf')) {
                    fileName += '.pdf';
                }
            }

            const fileData = {
                url: details.url,
                fileName: fileName,
                timestamp: Date.now()
            };

            // Send file detection to content script for caching
            chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                if (tabs[0] && tabs[0].url.includes('schoology.com')) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        type: 'FILE_DETECTED',
                        data: fileData
                    });
                }
            });
        }
    },
    {urls: ["*://*.schoology.com/*"]}
);


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'DOWNLOAD_FILE' || request.type === 'CACHE_AND_DOWNLOAD') {
      chrome.downloads.download({
        url: request.url,
        filename: request.fileName
      });
    }
  });