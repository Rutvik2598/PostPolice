# PostPolice 🛡️

PostPolice is a Chrome extension that detects and verifies claims on web pages in real-time. It uses a local Node.js proxy to securely handle AI requests through Groq and caches results using Valkey for high performance and low latency.

## Prerequisites

- **Node.js** (v18 or higher)
- **Homebrew** (for installing Valkey)
- **Valkey** (A high-performance Redis-compatible data store)
- **Groq API Key** (Get one at [console.groq.com](https://console.groq.com))

## Getting Started

### 1. Install & Start Valkey
```bash
# Install Valkey
brew install valkey

# Start the service
brew services start valkey
```

### 2. Project Setup
Clone the repository and install server dependencies:
```bash
cd PostPolice/server
npm install
```

### 3. Configure Environment
Create a `.env` file in the **root** of the project:
```bash
# In PostPolice/.env
GROQ_API_KEY=your_api_key_here
```

### 4. Start the Cache Server
Run the local bridge server:
```bash
cd PostPolice/server
npm start
```
The server will be running at `http://localhost:3000`.

### 5. Install the Chrome Extension
1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `PostPolice` directory (the root folder containing `manifest.json`).

## Features

- **Real-time Summarization**: Automatically extracts verifiable claims from pages.
- **Fact Verification**: Checks claims against whitelisted news sources using Groq LLM logic.
- **High Performance Caching**: Uses Valkey to store summaries for 10 minutes, saving costs and latency.
- **Secure Handling**: API keys are stored server-side and never exposed to the client.

## Monitoring & Management

Visit the built-in dashboard to monitor cache performance:
👉 **[http://localhost:3000/metrics](http://localhost:3000/metrics)**

From the dashboard, you can:
- View Hit/Miss rates and memory usage.
- **Clear Cache**: Instantly purge all cached data.
- **Reset Stats**: Zero out the performance counters.

## License
MIT