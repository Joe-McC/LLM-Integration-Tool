// src/services/code-processing/context-builder.service.ts

import { PrismaClient } from '@prisma/client';
import { BinaryCodeProcessor } from './binary-code-processor';
import { TokenCounter } from '../llm/token-counter.service';
import { logger } from '../../utils/logging';

const prisma = new PrismaClient();

export class ContextBuilder {
  private binaryProcessor: BinaryCodeProcessor;
  private tokenCounter: TokenCounter;
  private maxTokens: number;
  
  constructor(maxTokens: number = 8000) {
    this.binaryProcessor = new BinaryCodeProcessor();
    this.tokenCounter = new TokenCounter();
    this.maxTokens = maxTokens;
  }
  
  /**
   * Build context for an issue
   */
  public async buildIssueContext(
    repositoryId: string,
    title: string,
    description: string,
    relevantFiles: string[] = []
  ): Promise<{ context: string; codeMap: Record<string, any> }> {
    try {
      // Reserve tokens for the issue itself and response
      const issueTokens = this.tokenCounter.countTokens(`${title}\n${description}`);
      const reservedTokens = issueTokens + 2000; // Reserve 2000 tokens for response
      
      const availableTokens = this.maxTokens - reservedTokens;
      
      // Get files with prioritization
      const files = await this.getFilesWithPrioritization(
        repositoryId,
        relevantFiles,
        availableTokens
      );
      
      // Build a map of file contents for reference
      const codeMap: Record<string, any> = {};
      
      // Generate context string
      let context = `Repository Context:\n\n`;
      
      // Add file summaries
      for (const file of files) {
        // Store file in map
        codeMap[file.path] = file;
        
        // Add file reference to context
        if (file.useBinary) {
          context += `FILE: ${file.path} (Binary format, ${file.originalSize} bytes, compressed to ${file.binarySize} bytes)\n`;
          context += `REF: ${file.id}\n\n`;
        } else {
          // For small files or files without binary representation, include directly
          context += `FILE: ${file.path}\n\n`;
          context += `\`\`\`${file.language || ''}\n${file.summary || file.content}\n\`\`\`\n\n`;
        }
      }
      
      return {
        context,
        codeMap
      };
    } catch (error) {
      logger.error('Error building issue context:', error);
      throw error;
    }
  }
  
  /**
   * Get files with prioritization for context
   */
  private async getFilesWithPrioritization(
    repositoryId: string,
    relevantFilePaths: string[],
    availableTokens: number
  ): Promise<any[]> {
    try {
      // Get specifically requested files first
      let files = [];
      let usedTokens = 0;
      
      if (relevantFilePaths.length > 0) {
        // Get the specified files
        const relevantFiles = await prisma.file.findMany({
          where: {
            repositoryId,
            path: { in: relevantFilePaths }
          },
          select: {
            id: true,
            path: true,
            content: true,
            language: true,
            binaryRepresentation: true,
            metaData: true
          }
        });
        
        // Process each file
        for (const file of relevantFiles) {
          // Process the file for context
          const { useBinary, binarySize, originalSize, content, summary, tokens } = 
            await this.processFileForContext(file);
          
          // Check if adding this file would exceed token limit
          if (usedTokens + tokens > availableTokens) {
            // If too large, add a summary instead
            const summarized = await this.summarizeFile(file);
            usedTokens += summarized.tokens;
            files.push(summarized);
          } else {
            // Add the file
            usedTokens += tokens;
            files.push({
              id: file.id,
              path: file.path,
              language: file.language,
              content,
              summary,
              useBinary,
              binarySize,
              originalSize,
              tokens
            });
          }
          
          // Stop if we've used up available tokens
          if (usedTokens >= availableTokens) {
            break;
          }
        }
      }
      
      // If we still have tokens available, get additional relevant files
      if (usedTokens < availableTokens) {
        // Get files that might be relevant based on embeddings or recent changes
        // This would typically use vector similarity search
        
        // For now, use a simple heuristic of recently modified files
        const additionalFiles = await prisma.file.findMany({
          where: {
            repositoryId,
            path: { notIn: relevantFilePaths }, // Exclude files we already have
            language: { not: null } // Only include code files
          },
          orderBy: {
            lastModifiedAt: 'desc'
          },
          take: 10,
          select: {
            id: true,
            path: true,
            content: true,
            language: true,
            binaryRepresentation: true,
            metaData: true
          }
        });
        
        // Process each additional file
        for (const file of additionalFiles) {
          // Skip if we're out of tokens
          if (usedTokens >= availableTokens) {
            break;
          }
          
          // Summarize additional files to save tokens
          const summarized = await this.summarizeFile(file);
          
          // Check if we can add this summary
          if (usedTokens + summarized.tokens <= availableTokens) {
            usedTokens += summarized.tokens;
            files.push(summarized);
          }
        }
      }
      
      return files;
    } catch (error) {
      logger.error('Error getting files with prioritization:', error);
      throw error;
    }
  }
  
  /**
   * Process a file for context inclusion
   */
  private async processFileForContext(file: any): Promise<any> {
    try {
      // Check if we have binary representation
      const hasBinary = file.binaryRepresentation !== null;
      
      // Calculate tokens for direct inclusion
      const directTokens = this.tokenCounter.countTokens(file.content);
      
      // If file is small enough, use directly
      if (directTokens < 500) {
        return {
          useBinary: false,
          content: file.content,
          summary: null,
          tokens: directTokens
        };
      }
      
      // For larger files, use binary if available
      if (hasBinary) {
        // Calculate token requirements for binary reference
        const binaryRef = `REF: ${file.id}`;
        const binaryRefTokens = this.tokenCounter.countTokens(binaryRef);
        
        return {
          useBinary: true,
          content: file.content,
          binarySize: file.binaryRepresentation.length,
          originalSize: file.content.length,
          summary: null,
          tokens: binaryRefTokens
        };
      }
      
      // If no binary, create a summary
      const summary = await this.createCodeSummary(file.content, file.language);
      const summaryTokens = this.tokenCounter.countTokens(summary);
      
      return {
        useBinary: false,
        content: file.content,
        summary,
        tokens: summaryTokens
      };
    } catch (error) {
      logger.error(`Error processing file for context: ${file.path}`, error);
      
      // Fallback to a minimal representation
      const fallbackSummary = `[File content not available: ${error.message}]`;
      return {
        useBinary: false,
        content: null,
        summary: fallbackSummary,
        tokens: this.tokenCounter.countTokens(fallbackSummary)
      };
    }
  }
  
  /**
   * Summarize a file for context
   */
  private async summarizeFile(file: any): Promise<any> {
    try {
      // Create a summary of the file
      let summary: string;
      
      if (file.content && file.content.length > 0) {
        // Extract key elements from the file
        if (file.language === 'javascript' || file.language === 'typescript') {
          summary = this.extractJsFileStructure(file.content);
        } else {
          // For other languages, extract structural elements
          summary = this.extractFileStructure(file.content, file.language);
        }
      } else {
        summary = '[File content not available]';
      }
      
      const tokens = this.tokenCounter.countTokens(summary);
      
      return {
        id: file.id,
        path: file.path,
        language: file.language,
        content: null, // Don't include full content in summary
        summary,
        useBinary: false,
        tokens
      };
    } catch (error) {
      logger.error(`Error summarizing file: ${file.path}`, error);
      
      // Fallback
      const fallbackSummary = `[File summary not available: ${error.message}]`;
      return {
        id: file.id,
        path: file.path,
        language: file.language,
        content: null,
        summary: fallbackSummary,
        useBinary: false,
        tokens: this.tokenCounter.countTokens(fallbackSummary)
      };
    }
  }
  
  /**
   * Extract JavaScript/TypeScript file structure
   */
  private extractJsFileStructure(content: string): string {
    // Basic extraction of imports, exports, function signatures, class declarations
    const lines = content.split('\n');
    const structureLines = lines.filter(line => {
      const trimmed = line.trim();
      return (
        trimmed.startsWith('import ') ||
        trimmed.startsWith('export ') ||
        trimmed.startsWith('function ') ||
        trimmed.startsWith('class ') ||
        trimmed.startsWith('interface ') ||
        trimmed.startsWith('type ') ||
        trimmed.startsWith('const ') && (trimmed.includes(' = function') || trimmed.includes(' = (') || trimmed.includes(' = async'))
      );
    });
    
    return structureLines.join('\n');
  }
  
  /**
   * Extract file structure for other languages
   */
  private extractFileStructure(content: string, language: string | null): string {
    // Basic heuristic to extract structural elements
    const lines = content.split('\n');
    
    // Look for patterns that indicate structure
    const structureLines = lines.filter(line => {
      const trimmed = line.trim();
      
      // Common patterns across languages
      if (
        trimmed.startsWith('import ') ||
        trimmed.startsWith('class ') ||
        trimmed.startsWith('function ') ||
        trimmed.startsWith('def ') ||
        trimmed.startsWith('public ') ||
        trimmed.startsWith('private ') ||
        trimmed.startsWith('static ') ||
        trimmed.includes(' function(') ||
        trimmed.includes(' class ') ||
        trimmed.includes(' interface ') ||
        trimmed.startsWith('if ') ||
        trimmed.startsWith('for ') ||
        trimmed.startsWith('while ')
      ) {
        return true;
      }
      
      return false;
    });
    
    // Add a note about the summary
    return `// Summary of key structural elements\n${structureLines.join('\n')}`;
  }
  
  /**
   * Create a code summary for a file
   */
  private async createCodeSummary(content: string, language: string | null): Promise<string> {
    // Extract structural elements
    const structure = language === 'javascript' || language === 'typescript'
      ? this.extractJsFileStructure(content)
      : this.extractFileStructure(content, language);
    
    // If structure is short enough, use it
    if (structure.length < 1000) {
      return structure;
    }
    
    // Otherwise, truncate
    return structure.substring(0, 1000) + '\n// ... [truncated] ...';
  }
}
