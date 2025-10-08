// Track cached files to avoid re-caching the same file
let cachedFiles = new Set();

// Use browser API for cross-browser compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Check if file was already cached
function isFileCached(fileId) {
  return cachedFiles.has(fileId);
}

// Mark file as cached
function markAsCached(fileId) {
  cachedFiles.add(fileId);
}

// Listen for completed requests to detect and cache files
browserAPI.webRequest.onCompleted.addListener(
    async (details) => {
        const url = details.url;
        console.log('Background: Request completed:', url);
        
        // Only catch actual document files from Schoology CDN
        const isSchoologyFile = url.includes('files-cdn.schoology.com') && 
                               (url.includes('content-type=application') || url.includes('content-disposition=attachment'));
        
        console.log('Background: Is Schoology file?', isSchoologyFile);
        
        if (isSchoologyFile) {
            console.log('Background: Processing Schoology file:', url);
            // Extract base file ID (before query parameters) to prevent loops
            const baseFileId = url.split('/').pop().split('?')[0];
            
            // Check if file was already cached
            const alreadyCached = isFileCached(baseFileId);
            console.log('Background: File already cached?', alreadyCached);
            
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
                timestamp: Date.now(),
                alreadyCached: alreadyCached,
                fileId: baseFileId
            };

            // Mark file as cached if not already cached
            if (!alreadyCached) {
                markAsCached(baseFileId);
            }

            // Send file detection to content script for caching
            browserAPI.tabs.query({active: true, currentWindow: true}, (tabs) => {
                console.log('Background: Found tabs:', tabs.length);
                if (tabs[0] && tabs[0].url.includes('schoology.com')) {
                    console.log('Background: Sending message to tab:', tabs[0].id, 'URL:', tabs[0].url);
                    browserAPI.tabs.sendMessage(tabs[0].id, {
                        type: 'FILE_DETECTED',
                        data: fileData
                    }).then(() => {
                        console.log('Background: Message sent successfully');
                    }).catch((error) => {
                        console.error('Background: Failed to send message:', error);
                    });
                } else {
                    console.log('Background: No active Schoology tab found');
                }
            });
        }
    },
    {urls: ["*://*.schoology.com/*"]}
);


browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'DOWNLOAD_FILE' || request.type === 'CACHE_AND_DOWNLOAD') {
      browserAPI.downloads.download({
        url: request.url,
        filename: request.fileName
      });
    }
  });