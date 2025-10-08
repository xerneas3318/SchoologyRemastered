// Use browser API for cross-browser compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Check if required libraries are loaded
console.log('Tesseract available:', typeof Tesseract !== 'undefined');
console.log('PDF.js available:', typeof pdfjsLib !== 'undefined');

// PDF text extraction
async function extractTextFromPDF(blob) {
  try {
    // Re-initialize worker path in case extension context was invalidated
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = browserAPI.runtime.getURL('pdf.worker.min.js');
    } catch (contextError) {
      console.log('Extension context invalidated, skipping PDF.js');
      return '';
    }
    
    const arrayBuffer = await blob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
    let fullText = '';
    
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

// Convert PDF to images for OCR (all pages)
async function pdfToImages(blob) {
  try {
    // Re-initialize worker path in case extension context was invalidated
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = browserAPI.runtime.getURL('pdf.worker.min.js');
    } catch (contextError) {
      console.log('Extension context invalidated, cannot convert PDF to image');
      return [];
    }
    
    const arrayBuffer = await blob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
    const imageBlobs = [];
    
    console.log(`Converting ${pdf.numPages} pages to images for OCR...`);
    
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 }); // Higher scale for better OCR
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      
      await page.render({
        canvasContext: context,
        viewport: viewport
      }).promise;
      
      // Convert canvas to blob
      const imageBlob = await new Promise(resolve => {
        canvas.toBlob(resolve, 'image/png');
      });
      
      imageBlobs.push(imageBlob);
      console.log(`Page ${i} converted to image`);
    }
    
    return imageBlobs;
  } catch (error) {
    console.error('PDF to images conversion failed:', error);
    return [];
  }
}

// Convert PDF to image for OCR (single page - kept for backward compatibility)
async function pdfToImage(blob) {
  const images = await pdfToImages(blob);
  return images.length > 0 ? images[0] : null;
}

//Schoology pisses me off since every file is a pdf
// Tesseract OCR for images (supports multiple pages)
async function extractTextFromImage(blob) {
  try {
    console.log('Starting OCR extraction...');
    let imageBlobs = [blob];
    
    // If it's a PDF (which it always is), convert all pages to images
    if (blob.type === 'application/pdf') {
      console.log('Converting PDF to images for OCR...');
      imageBlobs = await pdfToImages(blob);
      if (!imageBlobs || imageBlobs.length === 0) {
        console.error('Failed to convert PDF to images');
        return '';
      }
      console.log(`PDF converted to ${imageBlobs.length} images successfully`);
    }
    
    // Check if Tesseract is available
    if (typeof Tesseract === 'undefined') {
      console.error('Tesseract.js is not loaded');
      return '';
    }
    
    console.log('Creating Tesseract worker...');
    const { createWorker } = Tesseract;
    const worker = await createWorker();
    
    console.log('Loading English language...');
    await worker.loadLanguage('eng');
    await worker.initialize('eng');
    
    let fullText = '';
    
    // Process each page/image
    for (let i = 0; i < imageBlobs.length; i++) {
      console.log(`Starting OCR recognition for page ${i + 1}...`);
      const { data: { text } } = await worker.recognize(imageBlobs[i]);
      console.log(`OCR recognition completed for page ${i + 1}, text length:`, text.length);
      
      if (text.trim()) {
        fullText += `\n--- Page ${i + 1} ---\n${text.trim()}\n`;
      }
    }
    
    await worker.terminate();
    
    return fullText.trim();
  } catch (error) {
    console.error('OCR text extraction failed:', error);
    console.error('Error details:', error.message, error.stack);
    return '';
  }
}

// Smart text extraction - tries PDF.js first, falls back to OCR if no text found
async function extractText(blob, fileName) {
  const fileExtension = fileName.split('.').pop().toLowerCase();
  
  console.log('File extension:', fileExtension, 'Blob type:', blob.type, 'File name:', fileName);
  
  // Check if filename suggests it's an image (even if served as PDF)
  const isImageFilename = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff'].includes(fileExtension);
  const isImageBlob = blob.type.startsWith('image/');
  
  if (isImageFilename || isImageBlob) {
    console.log('Using OCR for image file');
    return await extractTextFromImage(blob);
  } else if (fileExtension === 'pdf' || blob.type === 'application/pdf') {
    console.log('Trying PDF.js first...');
    const pdfText = await extractTextFromPDF(blob);
    
    // If PDF.js returns empty or very little text, try OCR
    if (!pdfText || pdfText.trim().length < 10) {
      console.log('PDF.js returned little/no text, trying OCR...');
      const ocrText = await extractTextFromImage(blob);
      if (ocrText && ocrText.trim().length > 0) {
        console.log('OCR found text, using OCR result');
        return ocrText;
      }
    }
    
    console.log('Using PDF.js result');
    return pdfText;
  } else {
    console.log('Unsupported file type for text extraction:', fileExtension, blob.type);
    return '';
  }
}

// Create download and extract text buttons when file is detected and cached
function createDownloadButton(fileData) {
  console.log('Content: Creating buttons for file:', fileData.fileName, 'Size:', fileData.cachedBlob?.length, 'bytes');
  
  // Remove any existing buttons
  const existingDownloadBtn = document.getElementById('schoology-download-btn');
  const existingExtractBtn = document.getElementById('schoology-extract-btn');
  const existingOCRBtn = document.getElementById('schoology-ocr-btn');
  if (existingDownloadBtn) existingDownloadBtn.remove();
  if (existingExtractBtn) existingExtractBtn.remove();
  if (existingOCRBtn) existingOCRBtn.remove();
  
  // Create download button
  const downloadButton = document.createElement('button');
  downloadButton.id = 'schoology-download-btn';
  downloadButton.textContent = `Download ${fileData.fileName}`;
  downloadButton.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 280px;
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
    right: 150px;
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
  
  // Create OCR button (force OCR regardless of file type)
  const ocrButton = document.createElement('button');
  ocrButton.id = 'schoology-ocr-btn';
  ocrButton.textContent = 'OCR Text';
  ocrButton.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 10000;
    background: #ff6b35;
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
      
      // Smart text extraction (PDF or image)
      const text = await extractText(blob, fileData.fileName);
      console.log('Extracted text:', text);
    } else {
      console.error('CRITICAL ERROR: FILE NOT CACHED');
      extractButton.textContent = 'Cache Failed';
      extractButton.disabled = true;
    }
  });
  
  // OCR button click handler (force OCR regardless of file type)
  ocrButton.addEventListener('click', async () => {
    console.log('Force OCR extraction from:', fileData.fileName);
    
    if (fileData.cachedBlob && fileData.cachedBlob.length > 0) {
      // Convert base64 back to blob
      const binaryString = atob(fileData.cachedBlob);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: fileData.blobType || 'application/pdf' });
      
      // Force OCR extraction
      const text = await extractTextFromImage(blob);
      console.log('OCR extracted text:', text);
    } else {
      console.error('CRITICAL ERROR: FILE NOT CACHED');
      ocrButton.textContent = 'Cache Failed';
      ocrButton.disabled = true;
    }
  });
  
  console.log('Content: Appending buttons to document body');
  document.body.appendChild(downloadButton);
  document.body.appendChild(extractButton);
  document.body.appendChild(ocrButton);
  console.log('Content: Buttons appended successfully');
}

// Cache file data
let cachedFileData = null;

// Remove buttons when navigating away from page
function removeButtons() {
  const existingDownloadBtn = document.getElementById('schoology-download-btn');
  const existingExtractBtn = document.getElementById('schoology-extract-btn');
  const existingOCRBtn = document.getElementById('schoology-ocr-btn');
  if (existingDownloadBtn) existingDownloadBtn.remove();
  if (existingExtractBtn) existingExtractBtn.remove();
  if (existingOCRBtn) existingOCRBtn.remove();
}

// Listen for page navigation (SPA navigation)
window.addEventListener('beforeunload', removeButtons);
window.addEventListener('popstate', removeButtons);

// Listen for file detection messages from background script
browserAPI.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  console.log('Content: Received message:', request.type, request);
  
  if (request.type === 'FILE_DETECTED') {
    console.log('Content: File detected:', request.data.url);
    console.log('Content: File already cached?', request.data.alreadyCached);
    
    // Only cache the file if it hasn't been cached before
    if (!request.data.alreadyCached) {
      try {
        console.log('Content: Attempting to cache file:', request.data.fileName);
      const response = await fetch(request.data.url);
      console.log('Fetch response status:', response.status, response.statusText);
      
      if (response.ok) {
        const blob = await response.blob();
        console.log('Blob created, size:', blob.size, 'type:', blob.type);
        
        //Realllly scuffed but binary data cant be sent through messages so I converted it (blob) to base64
        //I got some overflow errors so I chunked it (I broke into 8kb chunks and converted those to base64)
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        let binaryString = '';
        const chunkSize = 8192; // Process in chunks to avoid call stack overflow
        
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          const chunk = uint8Array.slice(i, i + chunkSize);
          binaryString += String.fromCharCode.apply(null, chunk);
        }
        const base64 = btoa(binaryString);
        
        // Update file data with cached blob
        request.data.cachedBlob = base64;
        request.data.blobType = blob.type;
        cachedFileData = request.data;
        
        // Save cached data to storage for future use
        try {
          await browserAPI.storage.local.set({
            [`cached_file_${request.data.fileId}`]: {
              cachedBlob: base64,
              blobType: blob.type,
              fileName: request.data.fileName,
              timestamp: Date.now()
            }
          });
          console.log('Content: Cached data saved to storage');
        } catch (error) {
          console.error('Content: Error saving cached data to storage:', error);
        }
        
        console.log('Content: File cached successfully:', request.data.fileName, 'Size:', blob.size, 'bytes');
        createDownloadButton(request.data);
      } else {
        console.error('Content: Fetch failed with status:', response.status, response.statusText);
      }
    } catch (error) {
      console.error('Content: Error caching file:', error);
    }
    } else {
      // File already cached, but we need to get the cached data
      console.log('Content: File already cached, retrieving cached data for:', request.data.fileName);
      
      // Try to get cached data from storage
      try {
        const result = await browserAPI.storage.local.get([`cached_file_${request.data.fileId}`]);
        if (result[`cached_file_${request.data.fileId}`]) {
          const cachedData = result[`cached_file_${request.data.fileId}`];
          request.data.cachedBlob = cachedData.cachedBlob;
          request.data.blobType = cachedData.blobType;
          cachedFileData = request.data;
          console.log('Content: Retrieved cached data from storage');
        } else {
          console.log('Content: No cached data found in storage, showing buttons without cache');
        }
      } catch (error) {
        console.error('Content: Error retrieving cached data:', error);
      }
      
      createDownloadButton(request.data);
    }
  }
});