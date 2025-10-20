// Use browser API for cross-browser compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Dynamically load config.js if it exists
function loadConfig() {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = browserAPI.runtime.getURL('config.js');
    script.onload = () => {
      console.log('Config loaded successfully');
      resolve(true);
    };
    script.onerror = () => {
      console.log('Config file not found, using defaults');
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

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
  const existingViewCommentsBtn = document.getElementById('schoology-view-comments-btn');
  const existingSummarizeBtn = document.getElementById('schoology-summarize-comments-btn');
  if (existingDownloadBtn) existingDownloadBtn.remove();
  if (existingExtractBtn) existingExtractBtn.remove();
  if (existingOCRBtn) existingOCRBtn.remove();
  if (existingViewCommentsBtn) existingViewCommentsBtn.remove();
  if (existingSummarizeBtn) existingSummarizeBtn.remove();
  
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
  
  // Create View Comments button
  const viewCommentsButton = document.createElement('button');
  viewCommentsButton.id = 'schoology-view-comments-btn';
  viewCommentsButton.textContent = '💬 View Comments';
  viewCommentsButton.style.cssText = `
    position: fixed;
    bottom: 70px;
    right: 20px;
    z-index: 10000;
    background: #6f42c1;
    color: white;
    border: none;
    padding: 10px 15px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 14px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.3);
  `;
  
  // Create Summarize Comments button
  const summarizeCommentsButton = document.createElement('button');
  summarizeCommentsButton.id = 'schoology-summarize-comments-btn';
  summarizeCommentsButton.textContent = '🤖 Summarize';
  summarizeCommentsButton.style.cssText = `
    position: fixed;
    bottom: 120px;
    right: 20px;
    z-index: 10000;
    background: #17a2b8;
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
  
  // View Comments button click handler
  viewCommentsButton.addEventListener('click', () => {
    console.log('View Comments clicked');
    if (voiceSystem) {
      voiceSystem.showComments();
    } else {
      console.error('Voice system not available');
    }
  });
  
  // Summarize Comments button click handler
  summarizeCommentsButton.addEventListener('click', () => {
    console.log('Summarize Comments clicked');
    if (voiceSystem) {
      voiceSystem.summarizeComments();
    } else {
      console.error('Voice system not available');
    }
  });
  
  console.log('Content: Appending buttons to document body');
  document.body.appendChild(downloadButton);
  document.body.appendChild(extractButton);
  document.body.appendChild(ocrButton);
  document.body.appendChild(viewCommentsButton);
  document.body.appendChild(summarizeCommentsButton);
  console.log('Content: Buttons appended successfully');
}

// Cache file data
let cachedFileData = null;

// Remove buttons when navigating away from page
function removeButtons() {
  const existingDownloadBtn = document.getElementById('schoology-download-btn');
  const existingExtractBtn = document.getElementById('schoology-extract-btn');
  const existingOCRBtn = document.getElementById('schoology-ocr-btn');
  const existingViewCommentsBtn = document.getElementById('schoology-view-comments-btn');
  const existingSummarizeBtn = document.getElementById('schoology-summarize-comments-btn');
  if (existingDownloadBtn) existingDownloadBtn.remove();
  if (existingExtractBtn) existingExtractBtn.remove();
  if (existingOCRBtn) existingOCRBtn.remove();
  if (existingViewCommentsBtn) existingViewCommentsBtn.remove();
  if (existingSummarizeBtn) existingSummarizeBtn.remove();
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
    
    // Wake word system
    this.isAwake = false;
    this.wakeWord = 'hey schoology';
    this.wakeWordTimeout = null;
    this.commandTimeout = null;
    this.lastInterimCommand = '';
    
    // Text-to-Speech properties
    this.synthesis = window.speechSynthesis;
    this.currentUtterance = null;
    this.isSpeaking = false;
    this.isPaused = false;
    this.currentText = '';
    this.currentPosition = 0;
    this.speechRate = 1.0;
    this.ttsControls = null;
    
    // Comment system
    this.comments = [];
    this.commentDialog = null;
    this.commentDisplay = null;
    this.currentCommentPosition = 0;
    this.init();
  }

  init() {
    this.initializeVoiceRecognition();
    this.createVoiceUI();
  }

  initializeVoiceRecognition() {
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
      this.updateStatus('Say "Hey Schoology" to activate', '#9E9E9E');
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

      const fullText = (finalTranscript + interimTranscript).toLowerCase().trim();
      
      // Check for wake word first
      if (!this.isAwake && fullText.includes(this.wakeWord)) {
        console.log('Voice: Wake word detected:', this.wakeWord);
        this.activateWakeMode();
        this.updateStatus('Hey Schoology! Listening for commands...', '#4CAF50');
        
        // Clear wake word timeout
        if (this.wakeWordTimeout) {
          clearTimeout(this.wakeWordTimeout);
        }
        
        // Set timeout to deactivate if no command comes
        this.wakeWordTimeout = setTimeout(() => {
          this.deactivateWakeMode();
        }, 10000); // 10 second timeout
        
        return;
      }

      // Only process commands if we're in wake mode
      if (!this.isAwake) {
        if (interimTranscript) {
          this.updateStatus('Say "Hey Schoology" to activate', '#9E9E9E');
        }
        return;
      }

      if (finalTranscript) {
        console.log('Voice command:', finalTranscript);
        this.processVoiceCommand(finalTranscript.toLowerCase().trim());
        this.updateStatus('Command processed', '#2196F3');
        setTimeout(() => this.updateStatus('Hey Schoology! Listening...', '#4CAF50'), 1000);
        
        // Clear wake word timeout since we got a command
        if (this.wakeWordTimeout) {
          clearTimeout(this.wakeWordTimeout);
          this.wakeWordTimeout = setTimeout(() => {
            this.deactivateWakeMode();
          }, 10000); // Reset 10 second timeout
        }
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
            
            // Reset wake word timeout
            if (this.wakeWordTimeout) {
              clearTimeout(this.wakeWordTimeout);
              this.wakeWordTimeout = setTimeout(() => {
                this.deactivateWakeMode();
              }, 10000);
            }
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
            
            // Reset wake word timeout
            if (this.wakeWordTimeout) {
              clearTimeout(this.wakeWordTimeout);
              this.wakeWordTimeout = setTimeout(() => {
                this.deactivateWakeMode();
              }, 10000);
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
      
      // Don't auto-restart if we're in comment mode
      if (this.isEnabled && !this.isRecordingComment) {
        this.updateStatus('Voice recognition stopped - restarting...', '#FF9800');
        console.log('Voice: Attempting to restart recognition...');
        
        // Restart recognition if it was enabled
        setTimeout(() => {
          if (this.isEnabled && !this.isRecordingComment) {
            console.log('Voice: Restarting recognition...');
            this.startListening();
          }
        }, 1000);
      } else {
        this.updateStatus('Voice recognition stopped', '#9E9E9E');
      }
    };
  }

  createVoiceUI() {
    // Add CSS animation for pulse effect
    if (!document.getElementById('voice-animations')) {
      const style = document.createElement('style');
      style.id = 'voice-animations';
      style.textContent = `
        @keyframes pulse {
          0% { transform: scale(1); }
          50% { transform: scale(1.05); }
          100% { transform: scale(1); }
        }
      `;
      document.head.appendChild(style);
    }

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

    if (this.isListening) {
      console.log('Voice recognition already listening');
      return;
    }

    this.isEnabled = true;
    this.toggleButton.innerHTML = '🎤 Voice On';
    this.toggleButton.style.background = '#4CAF50';
    this.statusElement.style.display = 'block';
    this.updateStatus('Say "Hey Schoology" to activate', '#9E9E9E');

    try {
      this.recognition.start();
      console.log('Voice: Recognition start command sent');
    } catch (error) {
      console.error('Failed to start voice recognition:', error);
      
      // If recognition is already started, wait and try again
      if (error.name === 'InvalidStateError') {
        console.log('Voice: Recognition already started, waiting...');
        this.updateStatus('Voice already running', '#FF9800');
        setTimeout(() => {
          if (this.isEnabled && !this.isListening) {
            console.log('Voice: Retrying recognition start after delay...');
            this.startListening();
          }
        }, 3000);
      } else {
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
        }, 2000);
      }
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

  activateWakeMode() {
    this.isAwake = true;
    console.log('Voice: Wake mode activated');
    
    // Update button appearance
    if (this.toggleButton) {
      this.toggleButton.innerHTML = '🎤 Hey Schoology!';
      this.toggleButton.style.background = '#FF6B35';
      this.toggleButton.style.animation = 'pulse 1s infinite';
    }
    
    // Add pulse animation
    if (this.toggleButton) {
      this.toggleButton.style.animation = 'pulse 1s infinite';
    }
  }

  deactivateWakeMode() {
    this.isAwake = false;
    console.log('Voice: Wake mode deactivated');
    
    // Update button appearance
    if (this.toggleButton) {
      this.toggleButton.innerHTML = '🎤 Voice On';
      this.toggleButton.style.background = '#4CAF50';
      this.toggleButton.style.animation = 'none';
    }
    
    // Clear timeouts
    if (this.wakeWordTimeout) {
      clearTimeout(this.wakeWordTimeout);
      this.wakeWordTimeout = null;
    }
    
    this.updateStatus('Say "Hey Schoology" to activate', '#9E9E9E');
  }

  processVoiceCommand(command) {
    console.log('Processing voice command:', command);

    // If we're recording a comment, only process "end comment" command
    if (this.isRecordingComment) {
      if (command.includes('end comment')) {
        this.endCommentRecording();
      }
      // Ignore all other commands while recording
      return;
    }

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
    } else if (command.includes('summarize comments') || command.includes('summarize comment')) {
      this.summarizeComments();
    } else if (command.includes('add comment')) {
      this.addComment();
    } else if (command.includes('show comments') || command.includes('view comments')) {
      this.showComments();
    } else if (command.includes('clear comments') || command.includes('delete comments')) {
      this.clearComments();
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
    } else if (command.includes('debug storage') || command.includes('check storage')) {
      this.debugStorage();
    } else if (command.includes('reload comments') || command.includes('refresh comments')) {
      this.forceReloadComments();
    } else if (command.includes('hey schoology') || command.includes('activate') || command.includes('wake up')) {
      this.activateWakeMode();
      this.updateStatus('Hey Schoology! Listening for commands...', '#4CAF50');
    } else if (command.includes('sleep') || command.includes('deactivate') || command.includes('goodbye')) {
      this.deactivateWakeMode();
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

  addComment() {
    console.log('Voice: Adding comment');
    
    // Pause speech if it's currently playing
    if (this.isSpeaking && !this.isPaused) {
      this.pauseSpeaking();
    }
    
    // Calculate current position for the comment
    let position = 0;
    if (this.isSpeaking || this.isPaused) {
      // Estimate position based on time elapsed
      const wordsPerSecond = 2.5;
      const estimatedWordsSpoken = Math.floor((Date.now() - this.speechStartTime) / 1000 * wordsPerSecond);
      const words = this.currentText.split(' ');
      position = Math.min(estimatedWordsSpoken, words.length);
    }
    
    this.currentCommentPosition = position;
    this.showCommentDialog();
    this.updateStatus('Comment mode - say "stop comment" when done', '#2196F3');
    
    // Stop main voice recognition completely
    this.stopMainVoiceRecognition();
    
    // Start comment-only voice recognition
    this.startCommentOnlyRecognition();
  }

  showCommentDialog() {
    // Remove existing dialog
    if (this.commentDialog) {
      this.commentDialog.remove();
    }
    
    // Create voice comment dialog
    this.commentDialog = document.createElement('div');
    this.commentDialog.id = 'comment-dialog';
    this.commentDialog.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 10002;
      background: white;
      border: 2px solid #2196F3;
      border-radius: 10px;
      padding: 20px;
      min-width: 500px;
      max-width: 700px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    `;
    
    this.commentDialog.innerHTML = `
      <div style="margin-bottom: 15px; font-weight: bold; color: #2196F3; font-size: 16px;">🎤 Voice Comment</div>
      <div style="margin-bottom: 10px; color: #666; font-size: 12px;">
        Position: Word ${this.currentCommentPosition} of ${this.currentText ? this.currentText.split(' ').length : 0}
      </div>
      <div id="voice-status" style="
        margin-bottom: 15px;
        padding: 10px;
        background: #e8f5e8;
        border-radius: 5px;
        text-align: center;
        font-weight: bold;
        color: #2e7d32;
      ">🎤 Recording... Say "stop comment" when finished</div>
      <div id="voice-transcript" style="
        width: 100%;
        height: 250px;
        padding: 15px;
        border: 2px solid #4CAF50;
        border-radius: 5px;
        background: #f8fff8;
        font-family: inherit;
        font-size: 16px;
        line-height: 1.5;
        overflow-y: auto;
        margin-bottom: 15px;
        color: #333;
      ">Your comment will appear here as you speak...</div>
      <div style="text-align: center; color: #666; font-size: 12px;">
        Say "stop comment" to save and close
      </div>
    `;
    
    // Initialize voice recording variables
    this.commentRecognition = null;
    this.commentTranscript = '';
    this.isRecordingComment = false;
    
    // Add to DOM
    document.body.appendChild(this.commentDialog);
    console.log('Voice: Comment dialog created');
  }

  stopMainVoiceRecognition() {
    console.log('Voice: Stopping main voice recognition');
    
    // Set flag to prevent auto-restart
    this.isEnabled = false;
    this.isListening = false;
    
    if (this.recognition) {
      // Remove all event listeners to prevent conflicts
      this.recognition.onstart = null;
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      this.recognition.onend = null;
      this.recognition.stop();
      this.recognition = null;
    }
    
    // Update button state
    if (this.toggleButton) {
      this.toggleButton.innerHTML = '🎤 Voice Off';
      this.toggleButton.style.background = '#9E9E9E';
    }
  }

  startCommentOnlyRecognition() {
    console.log('Voice: Starting comment-only recognition');
    
    // Check if speech recognition is supported
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      alert('Speech recognition not supported in this browser');
      return;
    }
    
    // Initialize speech recognition for comments only
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.commentRecognition = new SpeechRecognition();
    
    this.commentRecognition.continuous = true;
    this.commentRecognition.interimResults = true;
    this.commentRecognition.lang = 'en-US';
    
    // Set up event handlers
    this.commentRecognition.onstart = () => {
      this.isRecordingComment = true;
      const statusElement = document.getElementById('voice-status');
      if (statusElement) {
        statusElement.textContent = '🎤 Recording comment... Say "stop comment" when done';
        statusElement.style.background = '#e8f5e8';
        statusElement.style.color = '#2e7d32';
      }
      console.log('Voice: Comment-only recognition started');
    };
    
    this.commentRecognition.onresult = async (event) => {
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
      
      // Check for "stop comment" command
      const fullText = (finalTranscript + interimTranscript).toLowerCase();
      if (fullText.includes('stop comment')) {
        console.log('Voice: Stop comment command detected');
        // Only process if we haven't already processed this command
        if (this.isRecordingComment) {
          await this.stopCommentAndSave();
        }
        return;
      }
      
      // Add to comment transcript
      if (finalTranscript) {
        this.commentTranscript += finalTranscript + ' ';
        this.updateCommentDisplay();
      }
      
      if (interimTranscript) {
        this.updateCommentDisplay(interimTranscript);
      }
    };
    
    this.commentRecognition.onerror = async (event) => {
      console.error('Comment recognition error:', event.error);
      const statusElement = document.getElementById('voice-status');
      if (statusElement) {
        statusElement.textContent = `Error: ${event.error}`;
        statusElement.style.background = '#ffebee';
        statusElement.style.color = '#c62828';
      }
      await this.stopCommentAndSave();
    };
    
    this.commentRecognition.onend = () => {
      console.log('Voice: Comment recognition ended');
      if (this.isRecordingComment) {
        // Auto-restart if still recording
        setTimeout(() => {
          if (this.isRecordingComment) {
            this.commentRecognition.start();
          }
        }, 100);
      }
    };
    
    // Start recording
    try {
      this.commentRecognition.start();
    } catch (error) {
      console.error('Failed to start comment recognition:', error);
      const statusElement = document.getElementById('voice-status');
      if (statusElement) {
        statusElement.textContent = 'Failed to start recording';
        statusElement.style.background = '#ffebee';
        statusElement.style.color = '#c62828';
      }
    }
  }

  stopCommentRecording() {
    console.log('Voice: Stopping comment recording');
    
    this.isRecordingComment = false;
    
    if (this.commentRecognition) {
      this.commentRecognition.stop();
      this.commentRecognition = null;
    }
    
    // Restart main voice recognition if it was enabled
    if (this.isEnabled && !this.isListening) {
      console.log('Voice: Restarting main recognition after comment recording');
      setTimeout(() => {
        if (this.isEnabled && !this.isListening) {
          this.startListening();
        }
      }, 1000);
    }
    
    if (document.getElementById('voice-status')) {
      document.getElementById('voice-status').textContent = 'Recording stopped';
      document.getElementById('voice-status').style.background = '#f0f0f0';
      document.getElementById('voice-status').style.color = '#666';
    }
    
    if (document.getElementById('start-recording')) {
      document.getElementById('start-recording').style.display = 'inline-block';
    }
    if (document.getElementById('stop-recording')) {
      document.getElementById('stop-recording').style.display = 'none';
    }
  }

  async stopCommentAndSave() {
    console.log('Voice: Stopping comment and saving');
    
    // Stop comment recognition
    this.isRecordingComment = false;
    if (this.commentRecognition) {
      this.commentRecognition.stop();
      this.commentRecognition = null;
    }
    
    // Save comment if there's content
    if (this.commentTranscript.trim()) {
      await this.saveComment(this.commentTranscript);
      this.updateStatus('Comment saved and dialog closed', '#4CAF50');
    } else {
      this.updateStatus('No comment to save', '#FF9800');
    }
    
    // Close dialog
    if (this.commentDialog) {
      this.commentDialog.remove();
      this.commentDialog = null;
    }
    
    // Re-enable and create fresh main voice recognition
    this.isEnabled = true;
    setTimeout(() => {
      if (this.isEnabled) {
        this.initializeVoiceRecognition();
        this.startListening();
        
        // Update button state to show voice is on
        if (this.toggleButton) {
          this.toggleButton.innerHTML = '🎤 Voice On';
          this.toggleButton.style.background = '#4CAF50';
        }
      }
    }, 1000);
  }

  async saveAndCloseComment() {
    console.log('Voice: Saving and closing comment');
    
    if (this.commentTranscript.trim()) {
      await this.saveComment(this.commentTranscript);
      this.stopCommentRecording();
      this.commentDialog.remove();
      this.commentDialog = null;
      this.updateStatus('Comment saved and dialog closed', '#4CAF50');
      
      // Restart main voice recognition
      if (this.isEnabled && !this.isListening) {
        setTimeout(() => {
          if (this.isEnabled && !this.isListening) {
            this.startListening();
          }
        }, 1000);
      }
    } else {
      this.updateStatus('No comment to save', '#FF9800');
    }
  }

  updateCommentDisplay(interimText = '') {
    const transcriptElement = document.getElementById('voice-transcript');
    if (transcriptElement) {
      let displayText = this.commentTranscript;
      if (interimText) {
        displayText += '<span style="color: #999; font-style: italic;">' + interimText + '</span>';
      }
      transcriptElement.innerHTML = displayText;
      
      // Auto-scroll to bottom
      transcriptElement.scrollTop = transcriptElement.scrollHeight;
    }
  }

  async saveComment(text) {
    // Get current assignment ID from URL
    const assignmentId = this.getCurrentAssignmentId();
    
    const comment = {
      id: Date.now(),
      text: text,
      position: this.currentCommentPosition,
      timestamp: new Date().toLocaleString(),
      fileName: cachedFileData ? cachedFileData.fileName : 'Unknown file',
      assignmentId: assignmentId
    };
    
    this.comments.push(comment);
    await this.saveCommentsToStorage();
    
    this.updateStatus(`Comment saved at position ${this.currentCommentPosition}`, '#4CAF50');
    console.log('Voice: Comment saved:', comment);
  }

  getCurrentAssignmentId() {
    // Extract assignment ID from URL
    const url = window.location.href;
    const match = url.match(/assignment\/(\d+)/);
    return match ? match[1] : 'unknown';
  }

  async showComments() {
    console.log('Voice: Showing comments');
    
    // Remove existing display
    if (this.commentDisplay) {
      this.commentDisplay.remove();
    }
    
    // Load comments from storage first, then show them
    await this.loadCommentsFromStorage(() => {
      this.displayComments();
    });
  }

  displayComments() {
    // Filter comments for current assignment
    const currentAssignmentId = this.getCurrentAssignmentId();
    console.log('Voice: Getting assignment ID from URL:', window.location.href);
    console.log('Voice: Found assignment ID:', currentAssignmentId, 'using pattern:', /assignment\/(\d+)/);
    console.log('Voice: Displaying comments for assignment ID:', currentAssignmentId);
    console.log('Voice: Total comments available:', this.comments.length);
    console.log('Voice: All comments:', this.comments);
    
    const assignmentComments = this.comments.filter(comment => comment.assignmentId === currentAssignmentId);
    console.log('Voice: Filtered comments for current assignment:', assignmentComments.length);
    
    // Create comment display
    this.commentDisplay = document.createElement('div');
    this.commentDisplay.id = 'comment-display';
    this.commentDisplay.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 10002;
      background: white;
      border: 2px solid #4CAF50;
      border-radius: 10px;
      padding: 20px;
      min-width: 500px;
      max-width: 700px;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    `;
    
    if (assignmentComments.length === 0) {
      // If no assignment-specific comments, show all comments as fallback
      const allComments = this.comments.length > 0 ? this.comments : [];
      console.log('Voice: No assignment-specific comments found, showing all comments:', allComments.length);
      
      if (allComments.length === 0) {
        this.commentDisplay.innerHTML = `
          <div style="margin-bottom: 15px; font-weight: bold; color: #4CAF50; font-size: 16px;">💬 Comments</div>
          <div style="margin-bottom: 10px; color: #666; font-size: 12px;">
            Assignment ID: ${currentAssignmentId}
          </div>
          <div style="text-align: center; color: #666; padding: 20px;">
            No comments for this assignment yet. Say "Add comment" to create one!
          </div>
          <div style="display: flex; justify-content: flex-end; margin-top: 15px;">
            <button id="close-comments" style="
              padding: 8px 16px;
              background: #9E9E9E;
              color: white;
              border: none;
              border-radius: 5px;
              cursor: pointer;
              font-size: 14px;
            ">Close</button>
          </div>
        `;
      } else {
        // Show all comments as fallback
        this.displayAllComments(allComments, currentAssignmentId);
      }
    } else {
      let commentsHTML = `
        <div style="margin-bottom: 15px; font-weight: bold; color: #4CAF50; font-size: 16px;">
          💬 Comments (${assignmentComments.length})
        </div>
        <div style="margin-bottom: 10px; color: #666; font-size: 12px;">
          Assignment ID: ${currentAssignmentId}
        </div>
      `;
      
      assignmentComments.forEach((comment, index) => {
        commentsHTML += `
          <div style="
            border: 1px solid #ddd;
            border-radius: 5px;
            padding: 15px;
            margin-bottom: 10px;
            background: #f9f9f9;
          ">
            <div style="font-weight: bold; color: #333; margin-bottom: 5px;">
              Comment ${index + 1} - Position ${comment.position}
            </div>
            <div style="color: #666; font-size: 12px; margin-bottom: 8px;">
              ${comment.timestamp} • ${comment.fileName}
            </div>
            <div style="color: #333; line-height: 1.4;">
              ${comment.text}
            </div>
            <div style="margin-top: 10px;">
              <button onclick="voiceSystem.jumpToComment(${comment.position})" style="
                padding: 4px 8px;
                background: #2196F3;
                color: white;
                border: none;
                border-radius: 3px;
                cursor: pointer;
                font-size: 12px;
                margin-right: 5px;
              ">Jump to Position</button>
              <button onclick="voiceSystem.deleteComment(${comment.id})" style="
                padding: 4px 8px;
                background: #F44336;
                color: white;
                border: none;
                border-radius: 3px;
                cursor: pointer;
                font-size: 12px;
              ">Delete</button>
            </div>
          </div>
        `;
      });
      
      commentsHTML += `
        <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 15px;">
          <button id="clear-all-comments" style="
            padding: 8px 16px;
            background: #F44336;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
          ">Clear All</button>
          <button id="close-comments" style="
            padding: 8px 16px;
            background: #9E9E9E;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
          ">Close</button>
        </div>
      `;
      
      this.commentDisplay.innerHTML = commentsHTML;
    }
    
    // Add to DOM first
    document.body.appendChild(this.commentDisplay);
    
    // Add event listeners after DOM is updated
    setTimeout(() => {
      const closeBtn = document.getElementById('close-comments');
      const clearBtn = document.getElementById('clear-all-comments');
      
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          this.commentDisplay.remove();
          this.commentDisplay = null;
        });
      }
      
      if (clearBtn && assignmentComments.length > 0) {
        clearBtn.addEventListener('click', () => {
          if (confirm('Are you sure you want to delete all comments for this assignment?')) {
            this.clearCommentsForAssignment(currentAssignmentId);
            this.commentDisplay.remove();
            this.commentDisplay = null;
          }
        });
      }
      
      console.log('Voice: Comment display event listeners added');
    }, 10);
  }

  displayAllComments(allComments, currentAssignmentId) {
    console.log('Voice: Displaying all comments as fallback');
    
    let commentsHTML = `
      <div style="margin-bottom: 15px; font-weight: bold; color: #4CAF50; font-size: 16px;">
        💬 All Comments (${allComments.length})
      </div>
      <div style="margin-bottom: 10px; color: #666; font-size: 12px;">
        Current Assignment ID: ${currentAssignmentId}
      </div>
      <div style="margin-bottom: 10px; color: #FF9800; font-size: 12px; font-style: italic;">
        Showing all comments (assignment-specific filtering may not be working)
      </div>
    `;
    
    allComments.forEach((comment, index) => {
      commentsHTML += `
        <div style="
          border: 1px solid #ddd;
          border-radius: 5px;
          padding: 15px;
          margin-bottom: 10px;
          background: #f9f9f9;
        ">
          <div style="font-weight: bold; color: #333; margin-bottom: 5px;">
            Comment ${index + 1} - Position ${comment.position}
          </div>
          <div style="color: #666; font-size: 12px; margin-bottom: 8px;">
            ${comment.timestamp} • ${comment.fileName} • Assignment: ${comment.assignmentId}
          </div>
          <div style="color: #333; line-height: 1.4;">
            ${comment.text}
          </div>
          <div style="margin-top: 10px;">
            <button onclick="voiceSystem.jumpToComment(${comment.position})" style="
              padding: 4px 8px;
              background: #2196F3;
              color: white;
              border: none;
              border-radius: 3px;
              cursor: pointer;
              font-size: 12px;
              margin-right: 5px;
            ">Jump to Position</button>
            <button onclick="voiceSystem.deleteComment(${comment.id})" style="
              padding: 4px 8px;
              background: #F44336;
              color: white;
              border: none;
              border-radius: 3px;
              cursor: pointer;
              font-size: 12px;
            ">Delete</button>
          </div>
        </div>
      `;
    });
    
    commentsHTML += `
      <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 15px;">
        <button id="clear-all-comments" style="
          padding: 8px 16px;
          background: #F44336;
          color: white;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          font-size: 14px;
        ">Clear All</button>
        <button id="close-comments" style="
          padding: 8px 16px;
          background: #9E9E9E;
          color: white;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          font-size: 14px;
        ">Close</button>
      </div>
    `;
    
    this.commentDisplay.innerHTML = commentsHTML;
    
    // Add to DOM first
    document.body.appendChild(this.commentDisplay);
    
    // Add event listeners after DOM is updated
    setTimeout(() => {
      const closeBtn = document.getElementById('close-comments');
      const clearBtn = document.getElementById('clear-all-comments');
      
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          this.commentDisplay.remove();
          this.commentDisplay = null;
        });
      }
      
      if (clearBtn && allComments.length > 0) {
        clearBtn.addEventListener('click', () => {
          if (confirm('Are you sure you want to delete all comments?')) {
            this.clearComments();
            this.commentDisplay.remove();
            this.commentDisplay = null;
          }
        });
      }
      
      console.log('Voice: All comments display event listeners added');
    }, 10);
  }

  jumpToComment(position) {
    console.log('Voice: Jumping to comment position:', position);
    
    if (this.currentText) {
      // Stop current speech
      this.synthesis.cancel();
      
      // Calculate text from position
      const words = this.currentText.split(' ');
      const remainingWords = words.slice(position);
      const remainingText = remainingWords.join(' ');
      
      if (remainingText.trim()) {
        this.currentPosition = position;
        this.startSpeaking(remainingText);
        this.updateStatus(`Jumped to comment position ${position}`, '#4CAF50');
      } else {
        this.updateStatus('No text at comment position', '#FF9800');
      }
    } else {
      this.updateStatus('No text available to jump to', '#FF9800');
    }
  }

  async deleteComment(commentId) {
    this.comments = this.comments.filter(comment => comment.id !== commentId);
    await this.saveCommentsToStorage();
    await this.showComments(); // Refresh the display
    this.updateStatus('Comment deleted', '#4CAF50');
  }

  async clearComments() {
    this.comments = [];
    await this.saveCommentsToStorage();
    this.updateStatus('All comments cleared', '#4CAF50');
    console.log('Voice: All comments cleared');
  }

  async clearCommentsForAssignment(assignmentId) {
    this.comments = this.comments.filter(comment => comment.assignmentId !== assignmentId);
    await this.saveCommentsToStorage();
    this.updateStatus(`Comments cleared for assignment ${assignmentId}`, '#4CAF50');
    console.log('Voice: Comments cleared for assignment:', assignmentId);
  }

  async summarizeComments() {
    console.log('Voice: Summarizing comments');
    
    // Load comments from storage first
    await this.loadCommentsFromStorage(() => {
      this.performSummarization();
    });
  }

  async performSummarization() {
    const currentAssignmentId = this.getCurrentAssignmentId();
    const assignmentComments = this.comments.filter(comment => comment.assignmentId === currentAssignmentId);
    
    if (assignmentComments.length === 0) {
      this.updateStatus('No comments to summarize for this assignment', '#FF9800');
      return;
    }

    this.updateStatus('Generating summary...', '#2196F3');

    try {
      // Get PDF text content
      const pdfText = await this.getPDFText();
      
      // Prepare comments text
      const commentsText = assignmentComments.map(comment => 
        `Position ${comment.position}: ${comment.text}`
      ).join('\n');
      
      console.log('Voice: Comments being sent to API:', commentsText);

      // Create prompt for Gemini
      const prompt = `You are helping a teacher write professional feedback to a student. The teacher has made specific comments that need to be converted into formal, academic feedback.

ASSIGNMENT CONTENT:
${pdfText}

TEACHER'S COMMENTS:
${commentsText}

INSTRUCTIONS:
- Convert the teacher's casual comments into formal, professional feedback
- Write in complete, grammatically correct sentences
- Use proper academic language and tone
- Address the student directly but professionally
- Convert short phrases into full, meaningful sentences
- If comments mention formatting, grammar, or structure, provide specific guidance
- Use transitional phrases to connect multiple points
- End with encouragement or next steps
- Write as a single, cohesive paragraph of professional feedback

Write professional, formal feedback that converts the teacher's comments into proper academic feedback.`;

      // Call Gemini API (with fallbacks)
      const summary = await this.callGeminiAPI(prompt);
      
      // Display the summary
      this.showSummaryDialog(summary);
      
    } catch (error) {
      console.error('Error generating summary:', error);
      // Even if there's an error, try to show a basic summary
      try {
        const basicSummary = await this.generateLocalSummary();
        this.showSummaryDialog(basicSummary);
      } catch (fallbackError) {
        console.error('Fallback summary also failed:', fallbackError);
        this.updateStatus('Failed to generate summary', '#F44336');
      }
    }
  }

  async getPDFText() {
    if (!cachedFileData || !cachedFileData.cachedBlob) {
      throw new Error('No PDF data available');
    }

    // Convert base64 back to blob
    const binaryString = atob(cachedFileData.cachedBlob);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'application/pdf' });

    try {
      // Try PDF.js text extraction first
      const text = await this.extractTextFromPDF(blob);
      if (text && text.trim().length > 0) {
        console.log('Voice: PDF text extracted successfully using PDF.js');
        return text;
      }
    } catch (error) {
      console.log('Voice: PDF.js extraction failed, trying OCR:', error);
    }

    // Fallback to OCR if PDF.js fails
    console.log('Voice: Falling back to OCR extraction');
    const text = await extractTextFromImage(blob);
    return text;
  }

  async extractTextFromPDF(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async function() {
        try {
          // Set up PDF.js worker
          if (typeof pdfjsLib !== 'undefined') {
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
          }

          const typedArray = new Uint8Array(reader.result);
          const pdf = await pdfjsLib.getDocument(typedArray).promise;
          let fullText = '';

          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(' ');
            fullText += pageText + '\n';
          }

          resolve(fullText);
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
  }

  async callGeminiAPI(prompt) {
    // Try Gemini API first with correct model name
    try {
      const apiKey = (typeof config !== 'undefined' && config.GEMINI_API_KEY) || 'YOUR_GEMINI_API_KEY_HERE';
      if (apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
        throw new Error('Gemini API key not configured - please set config.GEMINI_API_KEY');
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
      
      console.log('Voice: Attempting Gemini API call with model: gemini-2.0-flash');

      const requestBody = {
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 1024,
        }
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Gemini API error response:', errorText);
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
        return data.candidates[0].content.parts[0].text;
      } else {
        console.error('Unexpected Gemini API response structure:', data);
        throw new Error('Unexpected response structure from Gemini API');
      }
    } catch (error) {
      console.log('Gemini API failed, trying OpenAI API:', error);
      // Fallback to OpenAI API
      return await this.callOpenAIAPI(prompt);
    }
  }

  async callOpenAIAPI(prompt) {
    const apiKey = (typeof config !== 'undefined' && config.OPENAI_API_KEY) || 'YOUR_OPENAI_API_KEY_HERE';
    if (apiKey === 'YOUR_OPENAI_API_KEY_HERE') {
      throw new Error('OpenAI API key not configured - please set config.OPENAI_API_KEY');
    }
    const url = 'https://api.openai.com/v1/chat/completions';
    
    console.log('Voice: Attempting OpenAI API call with key:', apiKey.substring(0, 20) + '...');

    const requestBody = {
      model: 'gpt-3.5-turbo',
      messages: [{
        role: 'user',
        content: prompt
      }],
      max_tokens: 1024,
      temperature: 0.7
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('OpenAI API error response:', errorText);
        throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      if (data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content;
      } else {
        console.error('Unexpected OpenAI API response structure:', data);
        throw new Error('Unexpected response structure from OpenAI API');
      }
    } catch (error) {
      console.log('OpenAI API failed, using local summary generator:', error);
      // Final fallback to local summary generation
      return await this.generateLocalSummary();
    }
  }

  async generateLocalSummary(prompt = '') {
    console.log('Voice: Generating local summary as fallback');
    
    // Get current assignment comments directly instead of parsing prompt
    const currentAssignmentId = this.getCurrentAssignmentId();
    const assignmentComments = this.comments.filter(comment => comment.assignmentId === currentAssignmentId);
    
    // Count comments
    const commentCount = assignmentComments.length;
    
    if (commentCount === 0) {
      return `I have reviewed your assignment and found it to demonstrate good understanding of the material. Keep up the excellent work!`;
    }
    
    // Convert comments to formal teacher feedback
    const formalComments = assignmentComments.map(comment => {
      const text = comment.text.toLowerCase().trim();
      
      // Convert common casual comments to formal feedback
      if (text.includes('fix formatting') || text.includes('formatting')) {
        return `Please review the formatting of your assignment to ensure it follows proper academic standards.`;
      }
      if (text.includes('good') || text.includes('great')) {
        return `Your work demonstrates good understanding of the concepts.`;
      }
      if (text.includes('grammar') || text.includes('spelling')) {
        return `Please review your work for grammar and spelling errors before submission.`;
      }
      if (text.includes('explain') || text.includes('more detail')) {
        return `Please provide more detailed explanations to support your arguments.`;
      }
      if (text.includes('cite') || text.includes('source')) {
        return `Remember to properly cite your sources and provide references.`;
      }
      if (text.includes('structure') || text.includes('organization')) {
        return `Please improve the organization and structure of your response.`;
      }
      if (text.includes('answer') || text.includes('question')) {
        return `Please ensure you have fully addressed all parts of the question.`;
      }
      
      // If it's already a full sentence, capitalize and add period if needed
      if (text.length > 10 && (text.includes('.') || text.includes('!') || text.includes('?'))) {
        return comment.text.charAt(0).toUpperCase() + comment.text.slice(1);
      }
      
      // Convert short phrases to full sentences
      return `Please ${comment.text.toLowerCase()}.`;
    });
    
    // Combine formal comments
    if (commentCount === 1) {
      return formalComments[0];
    }
    
    if (commentCount === 2) {
      return `${formalComments[0]} Additionally, ${formalComments[1].toLowerCase()}`;
    }
    
    // For multiple comments, create a structured response
    let summary = `I have reviewed your assignment and have several areas for improvement. `;
    summary += formalComments.slice(0, -1).join(' ') + ' ';
    summary += `Finally, ${formalComments[formalComments.length - 1].toLowerCase()}`;
    
    return summary;
  }

  analyzeCommentThemes(comments) {
    const themes = [];
    const lowerComments = comments.toLowerCase();
    
    if (lowerComments.includes('good') || lowerComments.includes('great') || lowerComments.includes('excellent')) {
      themes.push('positive aspects');
    }
    if (lowerComments.includes('improve') || lowerComments.includes('better') || lowerComments.includes('suggest')) {
      themes.push('areas for improvement');
    }
    if (lowerComments.includes('grammar') || lowerComments.includes('spelling') || lowerComments.includes('writing')) {
      themes.push('writing quality');
    }
    if (lowerComments.includes('content') || lowerComments.includes('information') || lowerComments.includes('details')) {
      themes.push('content accuracy');
    }
    if (lowerComments.includes('format') || lowerComments.includes('structure') || lowerComments.includes('organization')) {
      themes.push('organization');
    }
    
    return themes.length > 0 ? themes : ['general feedback'];
  }

  showSummaryDialog(summary) {
    // Remove existing dialog
    if (this.summaryDialog) {
      this.summaryDialog.remove();
    }

    // Create summary dialog
    this.summaryDialog = document.createElement('div');
    this.summaryDialog.id = 'summary-dialog';
    this.summaryDialog.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 10002;
      background: white;
      border: 2px solid #2196F3;
      border-radius: 10px;
      padding: 20px;
      min-width: 600px;
      max-width: 800px;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    `;

    this.summaryDialog.innerHTML = `
      <div style="margin-bottom: 15px; font-weight: bold; color: #2196F3; font-size: 16px;">📝 Feedback Summary</div>
      <div style="margin-bottom: 15px; color: #666; font-size: 12px;">
        Generated from your comments for this assignment
      </div>
      <div id="summary-content" style="
        width: 100%;
        height: 300px;
        padding: 15px;
        border: 1px solid #ddd;
        border-radius: 5px;
        background: #f9f9f9;
        font-family: inherit;
        font-size: 14px;
        line-height: 1.5;
        overflow-y: auto;
        margin-bottom: 15px;
        color: #333;
        white-space: pre-wrap;
      ">${summary}</div>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button id="copy-summary" style="
          padding: 8px 16px;
          background: #4CAF50;
          color: white;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          font-size: 14px;
        ">📋 Copy to Clipboard</button>
        <button id="close-summary" style="
          padding: 8px 16px;
          background: #9E9E9E;
          color: white;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          font-size: 14px;
        ">Close</button>
      </div>
    `;

    // Add to DOM
    document.body.appendChild(this.summaryDialog);

    // Add event listeners
    setTimeout(() => {
      const copyBtn = document.getElementById('copy-summary');
      const closeBtn = document.getElementById('close-summary');

      if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(summary);
            copyBtn.textContent = '✅ Copied!';
            copyBtn.style.background = '#28a745';
            setTimeout(() => {
              copyBtn.textContent = '📋 Copy to Clipboard';
              copyBtn.style.background = '#4CAF50';
            }, 2000);
          } catch (error) {
            console.error('Failed to copy:', error);
            copyBtn.textContent = '❌ Copy Failed';
            copyBtn.style.background = '#dc3545';
          }
        });
      }

      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          this.summaryDialog.remove();
          this.summaryDialog = null;
        });
      }

      console.log('Voice: Summary dialog event listeners added');
    }, 10);

    this.updateStatus('Summary generated successfully', '#4CAF50');
  }

  async saveCommentsToStorage() {
    try {
      await browserAPI.storage.local.set({
        'voice_comments': this.comments
      });
      console.log('Voice: Comments saved to storage, count:', this.comments.length);
    } catch (error) {
      console.error('Voice: Error saving comments:', error);
    }
  }

  async loadCommentsFromStorage(callback) {
    try {
      console.log('Voice: Loading comments from storage...');
      const result = await browserAPI.storage.local.get(['voice_comments']);
      console.log('Voice: Storage result:', result);
      
      if (result.voice_comments && Array.isArray(result.voice_comments)) {
        this.comments = result.voice_comments;
        console.log('Voice: Comments loaded from storage:', this.comments.length);
        console.log('Voice: Comments data:', this.comments);
      } else {
        this.comments = [];
        console.log('Voice: No comments found in storage or invalid format');
      }
      
      // Call the callback after comments are loaded
      if (callback) {
        callback();
      }
    } catch (error) {
      console.error('Voice: Error loading comments:', error);
      this.comments = [];
      
      // Call the callback even if there's an error
      if (callback) {
        callback();
      }
    }
  }

  async debugStorage() {
    console.log('Voice: Debugging storage...');
    try {
      const result = await browserAPI.storage.local.get(null);
      console.log('Voice: All storage contents:', result);
      
      const commentsResult = await browserAPI.storage.local.get(['voice_comments']);
      console.log('Voice: Comments storage:', commentsResult);
      
      this.updateStatus(`Storage debug complete - check console`, '#2196F3');
    } catch (error) {
      console.error('Voice: Storage debug failed:', error);
      this.updateStatus('Storage debug failed', '#F44336');
    }
  }

  async forceReloadComments() {
    console.log('Voice: Force reloading comments...');
    await this.loadCommentsFromStorage(() => {
      console.log('Voice: Comments force reloaded, count:', this.comments.length);
      this.updateStatus(`Comments reloaded: ${this.comments.length} found`, '#4CAF50');
    });
  }

  showVoiceCommands() {
    const commands = [
      'Voice Commands:',
      'First say "Hey Schoology" to activate',
      'Then use commands like:',
      '"Download" - Download file directly',
      '"Extract" or "Read" - Extract text & copy to clipboard',
      '"OCR" or "Scan" - OCR text & copy to clipboard',
      '"Speak" or "Read aloud" - Read text with voice',
      '"Pause" - Pause speech',
      '"Resume" or "Continue" - Resume speech',
      '"Skip" or "Forward" - Skip 10 seconds',
      '"Back" or "Rewind" - Go back 10 seconds',
      '"Add comment" - Start voice comment mode',
      '"Show comments" - View all comments',
      '"Summarize comments" - Generate AI summary',
      '"Sleep" or "Goodbye" - Deactivate wake mode',
      '"Help" - Show this help'
    ];
    
    this.updateStatus(commands.join(' | '), '#2196F3');
    setTimeout(() => this.updateStatus('Say "Hey Schoology" to activate', '#9E9E9E'), 5000);
  }
}

// Initialize voice command system when page loads
let voiceSystem = null;

// Initialize the extension
async function initializeExtension() {
  // Load config first
  await loadConfig();
  
  // Initialize voice system
  voiceSystem = new VoiceCommandSystem();
}

// Wait for page to be fully loaded before initializing
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
  initializeExtension();
}