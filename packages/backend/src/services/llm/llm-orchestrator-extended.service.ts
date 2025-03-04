// src/services/llm/llm-orchestrator-extended.service.ts

import { PrismaClient } from '@prisma/client';
import { Anthropic } from '@anthropic-ai/sdk';
import { OpenAI } from 'openai';
import { BinaryCodeProcessor } from '../code-processing/binary-code-processor';
import { CodeChunker } from '../code-processing/chunker';
import { ContextBuilder } from '../code-processing/context-builder.service';
import { PromptBuilder } from './prompt-builder.service';
import { ChatHistoryProcessor } from './chat-history-processor.service';
import { logger } from '../../utils/logging';

const prisma = new PrismaClient();

export class LlmOrchestratorExtended {
  private anthropic: Anthropic;
  private openai: OpenAI;
  private binaryCodeProcessor: BinaryCodeProcessor;
  private codeChunker: CodeChunker;
  private contextBuilder: ContextBuilder;
  private promptBuilder: PromptBuilder;
  private chatHistoryProcessor: ChatHistoryProcessor;
  
  constructor() {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    this.binaryCodeProcessor = new BinaryCodeProcessor();
    this.codeChunker = new CodeChunker();
    this.contextBuilder = new ContextBuilder();
    this.promptBuilder = new PromptBuilder();
    this.chatHistoryProcessor = new ChatHistoryProcessor();
  }
  
  /**
   * Process a prompt with historical context
   */
  public async processPromptWithHistory(
    userId: string,
    repositoryId: string,
    prompt: string,
    conversationId?: string,
    options: {
      useHistory?: boolean;
      useCodeContext?: boolean;
      relevantFiles?: string[];
    } = {}
  ): Promise<{ response: string; conversationId: string; fileChanges?: any[] }> {
    try {
      logger.info(`Processing prompt with history: ${prompt.substring(0, 100)}...`);
      
      // Default options
      const useHistory = options.useHistory !== false;
      const useCodeContext = options.useCodeContext !== false;
      
      // Build context
      let context = '';
      let codeMap = {};
      
      // Use code context if requested
      if (useCodeContext) {
        const { context: codeContext, codeMap: codeFileMap } = await this.contextBuilder.buildIssueContext(
          repositoryId,
          'User prompt',
          prompt,
          options.relevantFiles
        );
        
        context += codeContext;
        codeMap = codeFileMap;
      }
      
      // Use historical context if requested
      let historicalInsights = '';
      if (useHistory) {
        // Get relevant past conversations
        const relevantConversations = await this.chatHistoryProcessor.getRelevantConversations(
          repositoryId,
          userId,
          prompt
        );
        
        if (relevantConversations.length > 0) {
          // Process conversations for insights
          historicalInsights = await this.chatHistoryProcessor.processConversationsForInsights(
            relevantConversations,
            prompt
          );
          
          if (historicalInsights) {
            context += `\n\n## Historical Context\n\n${historicalInsights}\n\n`;
          }
        }
      }
      
      // Get or create conversation
      let conversation;
      if (conversationId) {
        // Check that conversation exists and belongs to user
        conversation = await prisma.conversation.findFirst({
          where: {
            id: conversationId,
            userId
          },
          include: {
            messages: {
              orderBy: {
                createdAt: 'asc'
              }
            }
          }
        });
        
        if (!conversation) {
          throw new Error('Conversation not found or access denied');
        }
      } else {
        // Create a new conversation
        const title = this.generateConversationTitle(prompt);
        
        conversationId = await this.chatHistoryProcessor.storeConversation(
          userId,
          repositoryId,
          title,
          [{ role: 'user', content: prompt }]
        );
        
        conversation = {
          id: conversationId,
          messages: [{ role: 'user', content: prompt }]
        };
      }
      
      // Build full prompt
      const fullPrompt = this.buildFullPrompt(conversation.messages, prompt, context);
      
      // Call LLM
      const response = await this.callLlmWithPrompt(fullPrompt);
      
      // Process response for code changes if needed
      let fileChanges;
      if (useCodeContext) {
        fileChanges = await this.parseResponseForChanges(response, codeMap);
      }
      
      // Store assistant response in conversation
      await this.chatHistoryProcessor.addMessageToConversation(
        conversationId,
        'assistant',
        response
      );
      
      return {
        response,
        conversationId,
        fileChanges
      };
    } catch (error) {
      logger.error('Error processing prompt with history:', error);
      throw error;
    }
  }
  
  /**
   * Generate a title for a new conversation
   */
  private generateConversationTitle(prompt: string): string {
    // Simple title generation: take the first 50 characters of the prompt
    let title = prompt.substring(0, 50).trim();
    
    // Add ellipsis if truncated
    if (prompt.length > 50) {
      title += '...';
    }
    
    return title;
  }
  
  /**
   * Build full prompt with conversation history and context
   */
  private buildFullPrompt(
    messages: any[],
    currentPrompt: string,
    context: string
  ): string {
    // If this is the first message, include full context
    if (messages.length <= 1) {
      return `${context}\n\n${currentPrompt}`;
    }
    
    // Otherwise, include conversation history
    let conversationHistory = '';
    for (const message of messages.slice(0, -1)) { // Exclude current prompt
      conversationHistory += `${message.role.toUpperCase()}: ${message.content}\n\n`;
    }
    
    return `${context}\n\nPrevious conversation:\n\n${conversationHistory}\n\nCurrent request:\n${currentPrompt}`;
  }
  
  /**
   * Call LLM with prompt
   */
  private async callLlmWithPrompt(prompt: string): Promise<string> {
    try {
      // Choose LLM based on configuration or context
      const provider = process.env.PREFERRED_LLM_PROVIDER || 'anthropic';
      
      if (provider === 'anthropic') {
        const response = await this.anthropic.messages.create({
          model: 'claude-3-opus-20240229',
          max_tokens: 4000,
          temperature: 0.2,
          messages: [
            { role: 'user', content: prompt }
          ]
        });
        
        return response.content[0].text;
      } else {
        // OpenAI
        const response = await this.openai.chat.completions.create({
          model: 'gpt-4-turbo',
          max_tokens: 4000,
          temperature: 0.2,
          messages: [
            { role: 'user', content: prompt }
          ]
        });
        
        return response.choices[0].message.content || '';
      }
    } catch (error) {
      logger.error('Error calling LLM:', error);
      throw error;
    }
  }
  
  /**
   * Parse LLM response to extract code changes
   */
  private async parseResponseForChanges(
    response: string,
    codeMap: Record<string, any>
  ): Promise<any[]> {
    try {
      // Extract code blocks from response
      const codeBlocks = this.extractCodeBlocks(response);
      
      // Create a list of file changes
      const changes = [];
      
      for (const block of codeBlocks) {
        const { language, code, filepath } = block;
        
        if (!filepath) {
          logger.warn('Code block without filepath, skipping');
          continue;
        }
        
        // Check if this is a modification to an existing file
        if (codeMap[filepath]) {
          // This is a modification
          const originalFile = codeMap[filepath];
          
          // If we have binary representation, decode it for comparison
          let originalCode = originalFile.content;
          if (originalFile.useBinary) {
            const binary = Buffer.from(originalFile.base64, 'base64');
            originalCode = await this.binaryCodeProcessor.binaryToCode(
              binary,
              originalFile.language
            );
          }
          
          changes.push({
            path: filepath,
            content: code,
            type: 'update',
            description: this.generateChangeDescription(originalCode, code)
          });
        } else {
          // This is a new file
          changes.push({
            path: filepath,
            content: code,
            type: 'create',
            description: 'Created new file'
          });
        }
      }
      
      return changes;
    } catch (error) {
      logger.error('Error parsing LLM response:', error);
      throw error;
    }
  }
  
  /**
   * Extract code blocks from LLM response
   */
  private extractCodeBlocks(response: string): any[] {
    // Extract code blocks with language and filepath
    // Example format: ```language:filepath
    // code
    // ```
    const regex = /```(\w+)(?::([^\s]+))?\s*\n([\s\S]*?)```/g;
    const blocks = [];
    let match;
    
    while ((match = regex.exec(response)) !== null) {
      const language = match[1];
      const filepath = match[2];
      const code = match[3];
      
      blocks.push({
        language,
        filepath,
        code: code.trim()
      });
    }
    
    return blocks;
  }
  
  /**
   * Generate description of changes between two code versions
   */
  private generateChangeDescription(originalCode: string, newCode: string): string {
    // Simple implementation - in a real system, you'd want to use a diff library
    // to generate a more meaningful description
    const originalLines = originalCode.split('\n').length;
    const newLines = newCode.split('\n').length;
    const lineDiff = newLines - originalLines;
    
    if (lineDiff > 0) {
      return `Added ${lineDiff} lines`;
    } else if (lineDiff < 0) {
      return `Removed ${Math.abs(lineDiff)} lines`;
    } else {
      return 'Modified without changing line count';
    }
  }
}
