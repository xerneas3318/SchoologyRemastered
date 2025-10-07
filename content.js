// Minimal PDF.js text extraction
async function extractTextFromPDF(blob) {
  try {
    // Set PDF.js worker path
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');
    
    const arrayBuffer = await blob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
    let fullText = '';
    
    // Extract text from all pages
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      fullText += pageText + '\n';
    }
    
    return fullText.trim();
  } catch (error) {
    console.error('PDF text extraction failed:', error);
    return '';
  }
}

// Create download and extract text buttons when file is detected and cached
function createDownloadButton(fileData) {
  console.log('File cached:', fileData.fileName, 'Size:', fileData.cachedBlob?.length, 'bytes');
  
  // Remove any existing buttons
  const existingDownloadBtn = document.getElementById('schoology-download-btn');
  const existingExtractBtn = document.getElementById('schoology-extract-btn');
  if (existingDownloadBtn) existingDownloadBtn.remove();
  if (existingExtractBtn) existingExtractBtn.remove();
  
  // Create download button
  const downloadButton = document.createElement('button');
  downloadButton.id = 'schoology-download-btn';
  downloadButton.textContent = `Download ${fileData.fileName}`;
  downloadButton.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 150px;
    z-index: 10000;
    background: #007cba;
    color: white;
    border: none;
    padding: 10px 15px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 14px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.3);
  `;
  
  // Create extract text button
  const extractButton = document.createElement('button');
  extractButton.id = 'schoology-extract-btn';
  extractButton.textContent = 'Extract Text';
  extractButton.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 10000;
    background: #28a745;
    color: white;
    border: none;
    padding: 10px 15px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 14px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.3);
  `;
  
  // Download button click handler
  downloadButton.addEventListener('click', () => {
    console.log('Downloading:', fileData.fileName);
    
    if (fileData.cachedBlob && fileData.cachedBlob.length > 0) {
      // Convert base64 back to blob
      const binaryString = atob(fileData.cachedBlob);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: fileData.blobType || 'application/pdf' });
      
      // Create download link and trigger download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileData.fileName;
      a.click();
      URL.revokeObjectURL(url);
      downloadButton.remove();
      extractButton.remove();
      console.log('Download completed:', fileData.fileName);
    } else {
      console.error('CRITICAL ERROR: FILE NOT CACHED, lowkey adityas fault');
      downloadButton.textContent = 'Cache Failed';
      downloadButton.disabled = true;
    }
  });
  
  // Extract text button click handler
  extractButton.addEventListener('click', async () => {
    console.log('Extracting text from:', fileData.fileName);
    
    if (fileData.cachedBlob && fileData.cachedBlob.length > 0) {
      // Convert base64 back to blob
      const binaryString = atob(fileData.cachedBlob);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: fileData.blobType || 'application/pdf' });
      
      // Extract text from PDF
      const text = await extractTextFromPDF(blob);
      console.log('Extracted text:', text);
    } else {
      console.error('CRITICAL ERROR: FILE NOT CACHED');
      extractButton.textContent = 'Cache Failed';
      extractButton.disabled = true;
    }
  });
  
  document.body.appendChild(downloadButton);
  document.body.appendChild(extractButton);
}

// Listen for file detection messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'FILE_DETECTED') {
    console.log('File detected:', request.data.url);
    createDownloadButton(request.data);
  }
});