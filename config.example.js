// Configuration file for SchoologyRemastered
// Copy this file to config.js and add your actual API keys

const config = {
  // Google Gemini API Key
  // Get your key from: https://ai.google.dev/
  GEMINI_API_KEY: 'YOUR_GEMINI_API_KEY_HERE',
  
  // OpenAI API Key  
  // Get your key from: https://platform.openai.com/api-keys
  OPENAI_API_KEY: 'YOUR_OPENAI_API_KEY_HERE'
};

// Make config available globally
if (typeof window !== 'undefined') {
  window.config = config;
}