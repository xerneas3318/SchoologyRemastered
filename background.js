// Prevent loops - only process each URL once per session
let lastProcessedUrl = '';

// Listen for completed requests to detect and cache files
chrome.webRequest.onCompleted.addListener(
    async (details) => {
        const url = details.url;
        
        // Skip if we already processed this URL (prevents loops)
        if (url === lastProcessedUrl) {
            return;
        }
        
        // Only catch actual document files from Schoology CDN
        const isSchoologyFile = url.includes('files-cdn.schoology.com') && 
                               (url.includes('content-type=application') || url.includes('content-disposition=attachment'));
        
        if (isSchoologyFile) {
            lastProcessedUrl = url;
            
            // Extract clean filename from URL
            let fileName = url.split('/').pop().split('?')[0];
            
            // Add .pdf extension if missing
            if (!fileName.includes('.')) {
                if (url.includes('.pdf') || url.includes('pdf')) {
                    fileName += '.pdf';
                }
            }

            const fileData = {
                url: details.url,
                fileName: fileName,
                timestamp: Date.now()
            };

            // Cache file immediately when detected
            try {
                const response = await fetch(details.url, {
                    cache: 'force-cache'
                });
                if (response.ok) {
                    const blob = await response.blob();
                    // Convert blob to base64 so it can be sent through messages
                    const arrayBuffer = await blob.arrayBuffer();
                    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
                    
                    fileData.cachedBlob = base64;
                    fileData.blobType = blob.type;
                    console.log('File cached:', fileName, 'Size:', blob.size, 'bytes');
                }
            } catch (error) {
                console.error('Error caching file:', error);
            }
            
            // Send cached file data to content script
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