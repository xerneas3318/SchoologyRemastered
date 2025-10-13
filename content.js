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

// Voice Recognition System
class VoiceCommandSystem {
  constructor() {
    this.recognition = null;
    this.isListening = false;
    this.isEnabled = false;
    this.statusElement = null;
    this.toggleButton = null;
    
    // Text-to-Speech properties
    this.synthesis = window.speechSynthesis;
    this.currentUtterance = null;
    this.isSpeaking = false;
    this.isPaused = false;
    this.currentText = '';
    this.currentPosition = 0;
    this.speechRate = 1.0;
    this.ttsControls = null;
    
    // Voice command timeout
    this.lastInterimCommand = '';
    this.commandTimeout = null;
    this.init();
  }

  init() {
    // Check if speech recognition is supported
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      console.log('Speech recognition not supported in this browser');
      return;
    }

    // Initialize speech recognition
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    // Set up event handlers
    this.recognition.onstart = () => {
      console.log('Voice recognition started');
      this.isListening = true;
      this.updateStatus('Listening...', '#4CAF50');
    };

    this.recognition.onresult = (event) => {
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      if (finalTranscript) {
        console.log('Voice command:', finalTranscript);
        this.processVoiceCommand(finalTranscript.toLowerCase().trim());
        this.updateStatus('Command processed', '#2196F3');
        setTimeout(() => this.updateStatus('Listening...', '#4CAF50'), 1000);
      } else if (interimTranscript) {
        this.updateStatus(`Hearing: ${interimTranscript}`, '#FF9800');
        
        // Check for urgent commands in interim results
        const urgentCommands = ['pause', 'stop', 'resume', 'continue'];
        const lowerInterim = interimTranscript.toLowerCase().trim();
        
        // Store the last interim command
        this.lastInterimCommand = lowerInterim;
        
        // Clear any existing timeout
        if (this.commandTimeout) {
          clearTimeout(this.commandTimeout);
        }
        
        // Set a timeout to process the command if no final result comes
        this.commandTimeout = setTimeout(() => {
          if (this.lastInterimCommand) {
            console.log('Voice: Processing command from timeout:', this.lastInterimCommand);
            this.processVoiceCommand(this.lastInterimCommand);
            this.updateStatus('Command processed (timeout)', '#FF5722');
            this.lastInterimCommand = '';
          }
        }, 1500); // 1.5 second timeout
        
        for (const command of urgentCommands) {
          if (lowerInterim.includes(command)) {
            console.log('Voice: Urgent command detected in interim:', command);
            this.processVoiceCommand(lowerInterim);
            this.updateStatus(`Urgent command: ${command}`, '#FF5722');
            // Clear timeout since we processed it immediately
            if (this.commandTimeout) {
              clearTimeout(this.commandTimeout);
              this.commandTimeout = null;
            }
            break;
          }
        }
      }
    };

    this.recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      this.isListening = false;
      
      // Update button state immediately
      if (this.toggleButton) {
        this.toggleButton.innerHTML = '🎤 Voice Off';
        this.toggleButton.style.background = '#9E9E9E';
      }
      
      // Handle different error types
      if (event.error === 'no-speech' || event.error === 'audio-capture') {
        this.updateStatus(`Error: ${event.error} - restarting...`, '#FF9800');
        // Restart for recoverable errors
        if (this.isEnabled) {
          setTimeout(() => {
            if (this.isEnabled) {
              console.log('Voice: Restarting after error:', event.error);
              this.startListening();
            }
          }, 2000);
        }
      } else {
        this.updateStatus(`Error: ${event.error}`, '#F44336');
        // For serious errors, disable voice recognition
        this.isEnabled = false;
      }
    };

    this.recognition.onend = () => {
      console.log('Voice recognition ended');
      this.isListening = false;
      
      // Update button state immediately
      if (this.toggleButton) {
        this.toggleButton.innerHTML = '🎤 Voice Off';
        this.toggleButton.style.background = '#9E9E9E';
      }
      
      if (this.isEnabled) {
        this.updateStatus('Voice recognition stopped - restarting...', '#FF9800');
        console.log('Voice: Attempting to restart recognition...');
        
        // Restart recognition if it was enabled
        setTimeout(() => {
          if (this.isEnabled) {
            console.log('Voice: Restarting recognition...');
            this.startListening();
          }
        }, 1000);
      } else {
        this.updateStatus('Voice recognition stopped', '#9E9E9E');
      }
    };

    this.createVoiceUI();
  }

  createVoiceUI() {
    // Create voice toggle button
    this.toggleButton = document.createElement('button');
    this.toggleButton.id = 'voice-toggle-btn';
    this.toggleButton.innerHTML = '🎤 Voice Off';
    this.toggleButton.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10001;
      background: #9E9E9E;
      color: white;
      border: none;
      padding: 10px 15px;
      border-radius: 25px;
      cursor: pointer;
      font-size: 14px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      transition: all 0.3s ease;
    `;

    // Create status element
    this.statusElement = document.createElement('div');
    this.statusElement.id = 'voice-status';
    this.statusElement.style.cssText = `
      position: fixed;
      top: 70px;
      right: 20px;
      z-index: 10001;
      background: rgba(0,0,0,0.8);
      color: white;
      padding: 8px 12px;
      border-radius: 5px;
      font-size: 12px;
      max-width: 200px;
      display: none;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
    `;

    // Toggle button click handler
    this.toggleButton.addEventListener('click', () => {
      this.toggleVoiceRecognition();
    });

    // Add elements to page
    document.body.appendChild(this.toggleButton);
    document.body.appendChild(this.statusElement);
  }

  toggleVoiceRecognition() {
    if (this.isEnabled) {
      this.stopListening();
    } else {
      this.startListening();
    }
  }

  startListening() {
    if (!this.recognition) {
      console.error('Speech recognition not initialized');
      return;
    }

    this.isEnabled = true;
    this.toggleButton.innerHTML = '🎤 Voice On';
    this.toggleButton.style.background = '#4CAF50';
    this.statusElement.style.display = 'block';
    this.updateStatus('Starting voice recognition...', '#FF9800');

    try {
      this.recognition.start();
      console.log('Voice: Recognition start command sent');
    } catch (error) {
      console.error('Failed to start voice recognition:', error);
      this.updateStatus('Failed to start - click to retry', '#F44336');
      this.isEnabled = false;
      this.toggleButton.innerHTML = '🎤 Voice Off';
      this.toggleButton.style.background = '#9E9E9E';
      
      // Auto-retry after a delay
      setTimeout(() => {
        if (!this.isEnabled) {
          console.log('Voice: Auto-retrying recognition start...');
          this.startListening();
        }
      }, 3000);
    }
  }

  stopListening() {
    this.isEnabled = false;
    this.isListening = false;
    this.toggleButton.innerHTML = '🎤 Voice Off';
    this.toggleButton.style.background = '#9E9E9E';
    this.statusElement.style.display = 'none';

    if (this.recognition) {
      this.recognition.stop();
    }
  }

  updateStatus(message, color) {
    if (this.statusElement) {
      this.statusElement.textContent = message;
      this.statusElement.style.background = color;
    }
  }

  processVoiceCommand(command) {
    console.log('Processing voice command:', command);

    // Voice commands for adding buttons - more flexible matching
    if (command.includes('download') || command.includes('download button')) {
      this.downloadFile();
    } else if (command.includes('extract') || command.includes('read') || command.includes('text')) {
      this.extractText();
    } else if (command.includes('ocr') || command.includes('scan')) {
      this.performOCR();
    } else if (command.includes('speak') || command.includes('read aloud') || command.includes('play text')) {
      this.speakText();
    } else if (command.includes('pause') || command.includes('stop speaking')) {
      this.pauseSpeaking();
    } else if (command.includes('resume') || command.includes('continue') || command.includes('play')) {
      this.resumeSpeaking();
    } else if (command.includes('skip') || command.includes('forward')) {
      this.skipSeconds(10);
    } else if (command.includes('back') || command.includes('rewind')) {
      this.skipSeconds(-10);
    } else if (command.includes('skip 5') || command.includes('forward 5')) {
      this.skipSeconds(5);
    } else if (command.includes('back 5') || command.includes('rewind 5')) {
      this.skipSeconds(-5);
    } else if (command.includes('skip 15') || command.includes('forward 15')) {
      this.skipSeconds(15);
    } else if (command.includes('back 15') || command.includes('rewind 15')) {
      this.skipSeconds(-15);
    } else if (command.includes('add download button')) {
      this.addDownloadButton();
    } else if (command.includes('add extract button')) {
      this.addExtractButton();
    } else if (command.includes('add ocr button')) {
      this.addOCRButton();
    } else if (command.includes('all') && command.includes('button')) {
      this.addAllButtons();
    } else if (command.includes('remove') || command.includes('clear') || command.includes('delete')) {
      this.removeAllButtons();
    } else if (command.includes('force download') || command.includes('force add download')) {
      this.forceAddDownloadButton();
    } else if (command.includes('help') || command.includes('commands') || command.includes('what')) {
      this.showVoiceCommands();
    } else {
      this.updateStatus('Unknown command. Say "help" for commands.', '#FF9800');
    }
  }

  addDownloadButton() {
    console.log('Voice: Attempting to add download button. Cached file data:', !!cachedFileData);
    
    if (cachedFileData) {
      // Create just the download button
      const existingDownloadBtn = document.getElementById('schoology-download-btn');
      console.log('Voice: Existing download button found:', !!existingDownloadBtn);
      
      if (existingDownloadBtn) {
        this.updateStatus('Download button already exists', '#FF9800');
        console.log('Voice: Download button already exists, not creating new one');
        return;
      }

      const downloadButton = document.createElement('button');
      downloadButton.id = 'schoology-download-btn';
      downloadButton.textContent = `Download ${cachedFileData.fileName}`;
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

      downloadButton.addEventListener('click', () => {
        console.log('Downloading:', cachedFileData.fileName);
        
        if (cachedFileData.cachedBlob && cachedFileData.cachedBlob.length > 0) {
          const binaryString = atob(cachedFileData.cachedBlob);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: cachedFileData.blobType || 'application/pdf' });
          
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = cachedFileData.fileName;
          a.click();
          URL.revokeObjectURL(url);
          console.log('Download completed:', cachedFileData.fileName);
        } else {
          console.error('CRITICAL ERROR: FILE NOT CACHED');
          downloadButton.textContent = 'Cache Failed';
          downloadButton.disabled = true;
        }
      });

      document.body.appendChild(downloadButton);
      this.updateStatus('Download button added', '#4CAF50');
      console.log('Voice: Download button successfully added');
    } else {
      this.updateStatus('No file loaded. Click a file link first, then try again.', '#FF9800');
      console.log('Voice: No cached file data available for download button');
    }
  }

  addExtractButton() {
    console.log('Voice: Attempting to add extract button. Cached file data:', !!cachedFileData);
    
    if (cachedFileData) {
      const existingExtractBtn = document.getElementById('schoology-extract-btn');
      if (existingExtractBtn) {
        this.updateStatus('Extract button already exists', '#FF9800');
        return;
      }

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

      extractButton.addEventListener('click', async () => {
        console.log('Extracting text from:', cachedFileData.fileName);
        
        if (cachedFileData.cachedBlob && cachedFileData.cachedBlob.length > 0) {
          const binaryString = atob(cachedFileData.cachedBlob);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: cachedFileData.blobType || 'application/pdf' });
          
          const text = await extractText(blob, cachedFileData.fileName);
          console.log('Extracted text:', text);
        } else {
          console.error('CRITICAL ERROR: FILE NOT CACHED');
          extractButton.textContent = 'Cache Failed';
          extractButton.disabled = true;
        }
      });

      document.body.appendChild(extractButton);
      this.updateStatus('Extract button added', '#4CAF50');
      console.log('Voice: Extract button successfully added');
    } else {
      this.updateStatus('No file loaded. Click a file link first, then try again.', '#FF9800');
      console.log('Voice: No cached file data available for extract button');
    }
  }

  addOCRButton() {
    console.log('Voice: Attempting to add OCR button. Cached file data:', !!cachedFileData);
    
    if (cachedFileData) {
      const existingOCRBtn = document.getElementById('schoology-ocr-btn');
      if (existingOCRBtn) {
        this.updateStatus('OCR button already exists', '#FF9800');
        return;
      }

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

      ocrButton.addEventListener('click', async () => {
        console.log('Force OCR extraction from:', cachedFileData.fileName);
        
        if (cachedFileData.cachedBlob && cachedFileData.cachedBlob.length > 0) {
          const binaryString = atob(cachedFileData.cachedBlob);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: cachedFileData.blobType || 'application/pdf' });
          
          const text = await extractTextFromImage(blob);
          console.log('OCR extracted text:', text);
        } else {
          console.error('CRITICAL ERROR: FILE NOT CACHED');
          ocrButton.textContent = 'Cache Failed';
          ocrButton.disabled = true;
        }
      });

      document.body.appendChild(ocrButton);
      this.updateStatus('OCR button added', '#4CAF50');
      console.log('Voice: OCR button successfully added');
    } else {
      this.updateStatus('No file loaded. Click a file link first, then try again.', '#FF9800');
      console.log('Voice: No cached file data available for OCR button');
    }
  }

  addAllButtons() {
    this.addDownloadButton();
    setTimeout(() => this.addExtractButton(), 100);
    setTimeout(() => this.addOCRButton(), 200);
    this.updateStatus('All buttons added', '#4CAF50');
  }

  removeAllButtons() {
    removeButtons();
    this.updateStatus('All buttons removed', '#4CAF50');
  }

  forceAddDownloadButton() {
    console.log('Voice: Force adding download button');
    // Remove existing download button first
    const existingDownloadBtn = document.getElementById('schoology-download-btn');
    if (existingDownloadBtn) {
      existingDownloadBtn.remove();
      console.log('Voice: Removed existing download button');
    }
    // Now add the new one
    this.addDownloadButton();
  }

  downloadFile() {
    console.log('Voice: Directly downloading file. Cached file data:', !!cachedFileData);
    
    if (cachedFileData && cachedFileData.cachedBlob && cachedFileData.cachedBlob.length > 0) {
      try {
        // Convert base64 back to blob
        const binaryString = atob(cachedFileData.cachedBlob);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: cachedFileData.blobType || 'application/pdf' });
        
        // Create download link and trigger download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = cachedFileData.fileName;
        a.click();
        URL.revokeObjectURL(url);
        
        this.updateStatus(`Downloaded: ${cachedFileData.fileName}`, '#4CAF50');
        console.log('Voice: File downloaded successfully:', cachedFileData.fileName);
      } catch (error) {
        console.error('Voice: Download failed:', error);
        this.updateStatus('Download failed', '#F44336');
      }
    } else {
      this.updateStatus('No file cached. Load a file first.', '#FF9800');
      console.log('Voice: No cached file data available for download');
    }
  }

  async extractText() {
    console.log('Voice: Directly extracting text. Cached file data:', !!cachedFileData);
    
    if (cachedFileData && cachedFileData.cachedBlob && cachedFileData.cachedBlob.length > 0) {
      try {
        this.updateStatus('Extracting text...', '#FF9800');
        
        // Convert base64 back to blob
        const binaryString = atob(cachedFileData.cachedBlob);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: cachedFileData.blobType || 'application/pdf' });
        
        // Extract text
        const text = await extractText(blob, cachedFileData.fileName);
        console.log('Voice: Text extracted:', text);
        
        this.updateStatus(`Text extracted (${text.length} chars)`, '#4CAF50');
        
        // Show text in a popup or copy to clipboard
        if (text && text.length > 0) {
          // Copy to clipboard
          navigator.clipboard.writeText(text).then(() => {
            this.updateStatus('Text copied to clipboard!', '#4CAF50');
          }).catch(() => {
            this.updateStatus('Text extracted (not copied)', '#4CAF50');
          });
        } else {
          this.updateStatus('No text found in file', '#FF9800');
        }
      } catch (error) {
        console.error('Voice: Text extraction failed:', error);
        this.updateStatus('Text extraction failed', '#F44336');
      }
    } else {
      this.updateStatus('No file cached. Load a file first.', '#FF9800');
      console.log('Voice: No cached file data available for text extraction');
    }
  }

  async performOCR() {
    console.log('Voice: Directly performing OCR. Cached file data:', !!cachedFileData);
    
    if (cachedFileData && cachedFileData.cachedBlob && cachedFileData.cachedBlob.length > 0) {
      try {
        this.updateStatus('Performing OCR...', '#FF9800');
        
        // Convert base64 back to blob
        const binaryString = atob(cachedFileData.cachedBlob);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: cachedFileData.blobType || 'application/pdf' });
        
        // Force OCR extraction
        const text = await extractTextFromImage(blob);
        console.log('Voice: OCR completed:', text);
        
        this.updateStatus(`OCR completed (${text.length} chars)`, '#4CAF50');
        
        // Copy to clipboard
        if (text && text.length > 0) {
          navigator.clipboard.writeText(text).then(() => {
            this.updateStatus('OCR text copied to clipboard!', '#4CAF50');
          }).catch(() => {
            this.updateStatus('OCR completed (not copied)', '#4CAF50');
          });
        } else {
          this.updateStatus('No text found via OCR', '#FF9800');
        }
      } catch (error) {
        console.error('Voice: OCR failed:', error);
        this.updateStatus('OCR failed', '#F44336');
      }
    } else {
      this.updateStatus('No file cached. Load a file first.', '#FF9800');
      console.log('Voice: No cached file data available for OCR');
    }
  }

  async speakText() {
    console.log('Voice: Starting text-to-speech');
    
    if (cachedFileData && cachedFileData.cachedBlob && cachedFileData.cachedBlob.length > 0) {
      try {
        this.updateStatus('Extracting text for speech...', '#FF9800');
        
        // Convert base64 back to blob
        const binaryString = atob(cachedFileData.cachedBlob);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: cachedFileData.blobType || 'application/pdf' });
        
        // Extract text
        const text = await extractText(blob, cachedFileData.fileName);
        
        if (text && text.length > 0) {
          this.currentText = text;
          this.currentPosition = 0;
          this.startSpeaking(text);
          this.createTTSControls();
          this.updateStatus('Reading text aloud...', '#4CAF50');
        } else {
          this.updateStatus('No text found to read', '#FF9800');
        }
      } catch (error) {
        console.error('Voice: TTS failed:', error);
        this.updateStatus('Text-to-speech failed', '#F44336');
      }
    } else {
      this.updateStatus('No file cached. Load a file first.', '#FF9800');
    }
  }

  startSpeaking(text) {
    // Stop any current speech
    this.synthesis.cancel();
    
    // Store the text and reset position
    this.currentText = text;
    this.currentPosition = 0;
    this.speechStartTime = Date.now(); // Track when speech starts
    
    // Create new utterance
    this.currentUtterance = new SpeechSynthesisUtterance(text);
    this.currentUtterance.rate = this.speechRate;
    this.currentUtterance.pitch = 1.0;
    this.currentUtterance.volume = 1.0;
    
    // Set up event handlers
    this.currentUtterance.onstart = () => {
      this.isSpeaking = true;
      this.isPaused = false;
      this.updateTTSControls();
      console.log('Voice: Speech started');
    };
    
    this.currentUtterance.onend = () => {
      this.isSpeaking = false;
      this.isPaused = false;
      this.updateTTSControls();
      this.updateStatus('Finished reading', '#4CAF50');
      console.log('Voice: Speech ended');
    };
    
    this.currentUtterance.onerror = (event) => {
      console.error('TTS Error:', event.error);
      // Don't reset paused state if we intentionally cancelled for pause
      if (event.error !== 'interrupted') {
        this.isSpeaking = false;
        this.isPaused = false;
        this.updateTTSControls();
        this.updateStatus('Speech error', '#F44336');
      } else {
        console.log('Voice: Speech interrupted (likely for pause)');
      }
    };
    
    // Start speaking
    this.synthesis.speak(this.currentUtterance);
  }

  pauseSpeaking() {
    console.log('Voice: Pause command received. isSpeaking:', this.isSpeaking, 'isPaused:', this.isPaused);
    
    if (this.isSpeaking && !this.isPaused) {
      console.log('Voice: Pausing speech synthesis');
      
      // Stop current speech and calculate position
      this.synthesis.cancel();
      
      // Estimate current position based on time elapsed
      // Rough estimate: 150 words per minute = 2.5 words per second
      const wordsPerSecond = 2.5;
      const estimatedWordsSpoken = Math.floor((Date.now() - this.speechStartTime) / 1000 * wordsPerSecond);
      const words = this.currentText.split(' ');
      this.currentPosition = Math.min(estimatedWordsSpoken, words.length);
      
      this.isSpeaking = false;
      this.isPaused = true;
      this.updateTTSControls();
      this.updateStatus('Speech paused', '#FF9800');
      console.log('Voice: Speech paused successfully at position:', this.currentPosition, 'of', words.length, 'words');
    } else {
      console.log('Voice: Cannot pause - not speaking or already paused');
      this.updateStatus('Cannot pause - not speaking', '#FF9800');
    }
  }

  resumeSpeaking() {
    console.log('Voice: Resume command received. isSpeaking:', this.isSpeaking, 'isPaused:', this.isPaused);
    console.log('Voice: Current position:', this.currentPosition, 'Current text length:', this.currentText ? this.currentText.length : 0);
    
    if (this.isPaused && this.currentText) {
      console.log('Voice: Resuming speech from position:', this.currentPosition);
      
      // Get remaining text from current position
      const words = this.currentText.split(' ');
      const remainingWords = words.slice(this.currentPosition);
      const remainingText = remainingWords.join(' ');
      
      console.log('Voice: Remaining words:', remainingWords.length, 'Remaining text length:', remainingText.length);
      
      if (remainingText.trim()) {
        // Reset paused state before starting
        this.isPaused = false;
        this.startSpeaking(remainingText);
        this.updateStatus('Speech resumed', '#4CAF50');
        console.log('Voice: Speech resumed successfully from position:', this.currentPosition);
      } else {
        this.updateStatus('No more text to read', '#FF9800');
        this.isPaused = false;
        this.updateTTSControls();
      }
    } else if (!this.isSpeaking && !this.isPaused && this.currentText) {
      // Start from beginning if not paused
      console.log('Voice: Starting from beginning (not paused)');
      this.startSpeaking(this.currentText);
      this.updateStatus('Speech started', '#4CAF50');
    } else {
      console.log('Voice: Cannot resume - no paused speech or no text');
      this.updateStatus('Cannot resume - no paused speech', '#FF9800');
    }
  }

  skipSeconds(seconds) {
    if (this.isSpeaking && this.currentUtterance) {
      // Stop current speech
      this.synthesis.cancel();
      
      // Calculate new position (rough estimate: 150 words per minute = 2.5 words per second)
      const wordsPerSecond = 2.5;
      const wordsToSkip = Math.abs(seconds) * wordsPerSecond;
      const words = this.currentText.split(' ');
      
      if (seconds > 0) {
        // Skip forward
        this.currentPosition = Math.min(this.currentPosition + wordsToSkip, words.length);
      } else {
        // Skip backward
        this.currentPosition = Math.max(this.currentPosition - wordsToSkip, 0);
      }
      
      // Resume from new position
      const remainingText = words.slice(this.currentPosition).join(' ');
      this.startSpeaking(remainingText);
      
      this.updateStatus(`Skipped ${seconds} seconds`, '#2196F3');
    }
  }

  createTTSControls() {
    // Remove existing controls
    if (this.ttsControls) {
      this.ttsControls.remove();
    }
    
    // Create TTS control panel
    this.ttsControls = document.createElement('div');
    this.ttsControls.id = 'tts-controls';
    this.ttsControls.style.cssText = `
      position: fixed;
      top: 120px;
      right: 20px;
      z-index: 10001;
      background: rgba(0,0,0,0.9);
      color: white;
      padding: 15px;
      border-radius: 10px;
      font-size: 12px;
      min-width: 200px;
      box-shadow: 0 4px 15px rgba(0,0,0,0.3);
    `;
    
    // Create elements individually to avoid DOM timing issues
    const title = document.createElement('div');
    title.style.cssText = 'margin-bottom: 10px; font-weight: bold;';
    title.textContent = '🎧 Text Reader';
    
    const status = document.createElement('div');
    status.id = 'tts-status';
    status.style.cssText = 'margin-bottom: 10px;';
    status.textContent = 'Ready';
    
    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = 'display: flex; gap: 5px; flex-wrap: wrap;';
    
    // Create buttons individually
    const pauseBtn = document.createElement('button');
    pauseBtn.id = 'tts-pause';
    pauseBtn.style.cssText = 'padding: 5px 10px; background: #FF9800; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 11px;';
    pauseBtn.textContent = 'Pause';
    pauseBtn.addEventListener('click', () => this.pauseSpeaking());
    
    const resumeBtn = document.createElement('button');
    resumeBtn.id = 'tts-resume';
    resumeBtn.style.cssText = 'padding: 5px 10px; background: #4CAF50; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 11px;';
    resumeBtn.textContent = 'Resume';
    resumeBtn.addEventListener('click', () => this.resumeSpeaking());
    
    const skipBackBtn = document.createElement('button');
    skipBackBtn.id = 'tts-skip-back';
    skipBackBtn.style.cssText = 'padding: 5px 10px; background: #2196F3; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 11px;';
    skipBackBtn.textContent = '⏪ 10s';
    skipBackBtn.addEventListener('click', () => this.skipSeconds(-10));
    
    const skipForwardBtn = document.createElement('button');
    skipForwardBtn.id = 'tts-skip-forward';
    skipForwardBtn.style.cssText = 'padding: 5px 10px; background: #2196F3; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 11px;';
    skipForwardBtn.textContent = '⏩ 10s';
    skipForwardBtn.addEventListener('click', () => this.skipSeconds(10));
    
    const stopBtn = document.createElement('button');
    stopBtn.id = 'tts-stop';
    stopBtn.style.cssText = 'padding: 5px 10px; background: #F44336; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 11px;';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', () => this.stopSpeaking());
    
    // Assemble the control panel
    buttonContainer.appendChild(pauseBtn);
    buttonContainer.appendChild(resumeBtn);
    buttonContainer.appendChild(skipBackBtn);
    buttonContainer.appendChild(skipForwardBtn);
    buttonContainer.appendChild(stopBtn);
    
    this.ttsControls.appendChild(title);
    this.ttsControls.appendChild(status);
    this.ttsControls.appendChild(buttonContainer);
    
    // Add to DOM
    document.body.appendChild(this.ttsControls);
    
    console.log('TTS controls created successfully');
  }

  updateTTSControls() {
    if (!this.ttsControls) return;
    
    const statusEl = document.getElementById('tts-status');
    const pauseBtn = document.getElementById('tts-pause');
    const resumeBtn = document.getElementById('tts-resume');
    
    if (!statusEl || !pauseBtn || !resumeBtn) {
      console.log('TTS control elements not found, skipping update');
      return;
    }
    
    if (this.isSpeaking && !this.isPaused) {
      statusEl.textContent = 'Speaking...';
      pauseBtn.style.display = 'inline-block';
      resumeBtn.style.display = 'none';
    } else if (this.isPaused) {
      statusEl.textContent = 'Paused';
      pauseBtn.style.display = 'none';
      resumeBtn.style.display = 'inline-block';
    } else {
      statusEl.textContent = 'Stopped';
      pauseBtn.style.display = 'none';
      resumeBtn.style.display = 'inline-block';
    }
  }

  stopSpeaking() {
    this.synthesis.cancel();
    this.isSpeaking = false;
    this.isPaused = false;
    this.currentPosition = 0;
    this.updateTTSControls();
    this.updateStatus('Speech stopped', '#9E9E9E');
  }

  showVoiceCommands() {
    const commands = [
      'Voice Commands:',
      '"Download" - Download file directly',
      '"Extract" or "Read" - Extract text & copy to clipboard',
      '"OCR" or "Scan" - OCR text & copy to clipboard',
      '"Speak" or "Read aloud" - Read text with voice',
      '"Pause" - Pause speech',
      '"Resume" or "Continue" - Resume speech',
      '"Skip" or "Forward" - Skip 10 seconds',
      '"Back" or "Rewind" - Go back 10 seconds',
      '"Skip 5" - Skip 5 seconds',
      '"Back 5" - Go back 5 seconds',
      '"Add download button" - Add download button',
      '"Add extract button" - Add extract button',
      '"Add OCR button" - Add OCR button',
      '"All buttons" - Add all buttons',
      '"Remove" - Remove all buttons',
      '"Help" - Show this help'
    ];
    
    this.updateStatus(commands.join(' | '), '#2196F3');
    setTimeout(() => this.updateStatus('Listening...', '#4CAF50'), 5000);
  }
}

// Initialize voice command system when page loads
let voiceSystem = null;

// Wait for page to be fully loaded before initializing voice system
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    voiceSystem = new VoiceCommandSystem();
  });
} else {
  voiceSystem = new VoiceCommandSystem();
}