# GitHub-LLM Integration Project

This project integrates GitHub repositories with Large Language Models to enhance code development. It consists of a monorepo with several components:

1. **Backend Service**: API and processing engine that integrates with LLMs and GitHub
2. **VS Code Extension**: Client-side component that runs in the user's editor
3. **GitHub Actions Integration**: Workflow files and webhook handlers for CI/CD automation

## Key Features

- Repository-wide understanding for context-aware assistance
- Binary code processing for efficient token usage
- Chat history with conversation memory
- Multi-file changes and code generation
- GitHub integration for PRs and issue processing

## Getting Started

### Prerequisites
- Node.js 18+
- npm

### Installation

```powershell
# Clone the repository
git clone https://github.com/yourusername/github-llm-integration.git
cd github-llm-integration

# Install dependencies
npm install

# Bootstrap packages
npx lerna bootstrap
```

### Development

```powershell
# Start development servers
npm run dev
```

## Implementation Details

The project implements several advanced features:

1. **Binary Code Processing**: Converts code to compact binary representations to fit more context in LLM windows

2. **Chat History**: Maintains conversation memory to build on previous interactions

3. **GitHub Actions Integration**: Automates building, testing, and deploying code

## Project Structure

This is a monorepo with the following components:

- `packages/backend`: Backend API service
- `packages/vscode-extension`: VS Code extension
- `packages/github-actions`: GitHub Actions integration
- `packages/shared`: Shared code and types

## License

MIT
