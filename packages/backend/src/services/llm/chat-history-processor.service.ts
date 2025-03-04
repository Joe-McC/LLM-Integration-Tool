// src/services/llm/chat-history-processor.service.ts

import { PrismaClient } from '@prisma/client';
import { Anthropic } from '@anthropic-ai/sdk';
import { TokenCounter } from './token-counter.service';
import { logger } from '../../utils/logging';

const prisma = new PrismaClient();

export class ChatHistoryProcessor {
  private anthropic: Anthropic;
  private tokenCounter: TokenCounter;
  private maxContextTokens: number;
  
  constructor(maxContextTokens: number = 16000) {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    this.tokenCounter = new TokenCounter();
    this.maxContextTokens = maxContextTokens;
  }
  
  /**
   * Get relevant conversations for a new request
   */
  public async getRelevantConversations(
    repositoryId: string,
    userId: string,
    prompt: string,
    limit: number = 3
  ): Promise<any[]> {
    try {
      // In a real system, this would use embeddings and vector similarity
      // For now, we'll use a simpler keyword-based approach
      
      // Extract keywords from prompt
      const keywords = this.extractKeywords(prompt);
      
      // Get recent conversations for this repository and user
      const conversations = await prisma.conversation.findMany({
        where: {
          repositoryId,
          userId
        },
        include: {
          messages: {
            orderBy: {
              createdAt: 'asc'
            }
          }
        },
        orderBy: {
          updatedAt: 'desc'
        },
        take: 10 // Get more than we need for filtering
      });
      
      // Score conversations based on keyword matches
      const scoredConversations = conversations.map(conversation => {
        // Combine all messages
        const allText = conversation.messages
          .map(msg => msg.content)
          .join('\n');
        
        // Calculate score based on keyword matches
        let score = 0;
        for (const keyword of keywords) {
          const regex = new RegExp(keyword, 'gi');
          const matches = allText.match(regex);
          if (matches) {
            score += matches.length;
          }
        }
        
        return {
          conversation,
          score
        };
      });
      
      // Sort by score and take the top ones
      const topConversations = scoredConversations
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(item => item.conversation);
      
      return topConversations;
    } catch (error) {
      logger.error('Error getting relevant conversations:', error);
      return [];
    }
  }
  
  /**
   * Process conversations to extract insights
   */
  public async processConversationsForInsights(
    conversations: any[],
    currentPrompt: string
  ): Promise<string> {
    try {
      // Build context from conversations
      const conversationContext = this.buildConversationContext(conversations);
      
      // Check token count
      const promptTokens = this.tokenCounter.countTokens(currentPrompt);
      const contextTokens = this.tokenCounter.countTokens(conversationContext);
      
      // If we have too many tokens, summarize conversations
      if (promptTokens + contextTokens > this.maxContextTokens) {
        return await this.summarizeConversations(conversations, currentPrompt);
      }
      
      // Build prompt for insights
      const prompt = `
You are analyzing past conversations related to a GitHub repository to provide insights for a new request.

Past conversations:
${conversationContext}

Current request:
${currentPrompt}

Based on the past conversations, provide insights that would be helpful for addressing the current request. Focus on:
1. Relevant context from past conversations
2. Previous solutions or approaches that were discussed
3. User preferences or requirements mentioned earlier
4. Any challenges or issues encountered previously

Format your response as a clear, concise summary that can guide the implementation of the current request.`;
      
      // Call LLM
      const response = await this.anthropic.messages.create({
        model: 'claude-3-opus-20240229',
        max_tokens: 1500,
        temperature: 0.2,
        messages: [
          { role: 'user', content: prompt }
        ]
      });
      
      return response.content[0].text;
    } catch (error) {
      logger.error('Error processing conversations for insights:', error);
      return '';
    }
  }
  
  /**
   * Create a summary of past conversations
   */
  private async summarizeConversations(
    conversations: any[],
    currentPrompt: string
  ): Promise<string> {
    try {
      // Build summaries of each conversation
      const conversationSummaries = await Promise.all(
        conversations.map(async (conversation) => {
          // Check if we already have a summary
          if (conversation.summary) {
            return `Conversation "${conversation.title}" (${new Date(conversation.createdAt).toLocaleDateString()}):\n${conversation.summary}`;
          }
          
          // Create a summary
          const conversationText = conversation.messages
            .map(msg => `${msg.role.toUpperCase()}: ${msg.content}`)
            .join('\n\n');
          
          // Build prompt for summarization
          const summaryPrompt = `
Summarize the following conversation related to a GitHub repository. Focus on:
1. The main topics or issues discussed
2. Any solutions or code implementations proposed
3. Decisions made or preferences expressed by the user
4. Outstanding questions or problems

Conversation:
${conversationText}

Provide a concise summary in 3-5 sentences.`;
          
          try {
            // Call LLM for summary
            const response = await this.anthropic.messages.create({
              model: 'claude-3-haiku-20240307',
              max_tokens: 300,
              temperature: 0.2,
              messages: [
                { role: 'user', content: summaryPrompt }
              ]
            });
            
            const summary = response.content[0].text;
            
            // Store summary in database
            await prisma.conversation.update({
              where: { id: conversation.id },
              data: { summary }
            });
            
            return `Conversation "${conversation.title}" (${new Date(conversation.createdAt).toLocaleDateString()}):\n${summary}`;
          } catch (summaryError) {
            logger.error('Error creating conversation summary:', summaryError);
            return `Conversation "${conversation.title}" (${new Date(conversation.createdAt).toLocaleDateString()}):\n[Summary not available]`;
          }
        })
      );
      
      // Combine summaries
      const combinedSummaries = conversationSummaries.join('\n\n');
      
      // Build prompt for insights
      const insightsPrompt = `
You are analyzing summaries of past conversations related to a GitHub repository to provide insights for a new request.

Past conversation summaries:
${combinedSummaries}

Current request:
${currentPrompt}

Based on these past conversations, provide insights that would be helpful for addressing the current request. Focus on:
1. Relevant context from past conversations
2. Previous solutions or approaches that were discussed
3. User preferences or requirements mentioned earlier
4. Any challenges or issues encountered previously

Format your response as a clear, concise summary that can guide the implementation of the current request.`;
      
      // Call LLM
      const response = await this.anthropic.messages.create({
        model: 'claude-3-opus-20240229',
        max_tokens: 1000,
        temperature: 0.2,
        messages: [
          { role: 'user', content: insightsPrompt }
        ]
      });
      
      return response.content[0].text;
    } catch (error) {
      logger.error('Error summarizing conversations:', error);
      return '';
    }
  }
  
  /**
   * Build conversation context from multiple conversations
   */
  private buildConversationContext(conversations: any[]): string {
    let context = '';
    
    for (const conversation of conversations) {
      context += `Conversation "${conversation.title}" (${new Date(conversation.createdAt).toLocaleDateString()}):\n\n`;
      
      for (const message of conversation.messages) {
        context += `${message.role.toUpperCase()}: ${message.content}\n\n`;
      }
      
      context += '---\n\n';
    }
    
    return context;
  }
  
  /**
   * Extract keywords from a prompt
   */
  private extractKeywords(prompt: string): string[] {
    // Simple keyword extraction
    const words = prompt.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3)
      .filter(word => !this.isStopWord(word));
    
    // Count frequency
    const wordCounts: Record<string, number> = {};
    for (const word of words) {
      wordCounts[word] = (wordCounts[word] || 0) + 1;
    }
    
    // Sort by frequency
    const sortedWords = Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .map(entry => entry[0]);
    
    // Take top keywords
    return sortedWords.slice(0, 10);
  }
  
  /**
   * Check if a word is a stop word (common word with little meaning)
   */
  private isStopWord(word: string): boolean {
    const stopWords = [
      'the', 'and', 'that', 'have', 'for', 'not', 'this', 'with', 'you', 'but',
      'from', 'they', 'will', 'would', 'there', 'their', 'what', 'about', 'which',
      'when', 'make', 'like', 'time', 'just', 'know', 'take', 'into', 'year', 'your',
      'good', 'some', 'could', 'them', 'than', 'then', 'look', 'only', 'come', 'over',
      'think', 'also', 'back', 'after', 'work', 'first', 'well', 'even', 'want', 'because',
      'these', 'give', 'most', 'very'
    ];
    
    return stopWords.includes(word);
  }
  
  /**
   * Store a new conversation
   */
  public async storeConversation(
    userId: string,
    repositoryId: string | null,
    title: string,
    messages: { role: string; content: string }[]
  ): Promise<string> {
    try {
      // Create conversation
      const conversation = await prisma.conversation.create({
        data: {
          title,
          user: { connect: { id: userId } },
          ...(repositoryId ? { repository: { connect: { id: repositoryId } } } : {}),
          messages: {
            create: messages.map(msg => ({
              role: msg.role,
              content: msg.content
            }))
          }
        }
      });
      
      return conversation.id;
    } catch (error) {
      logger.error('Error storing conversation:', error);
      throw error;
    }
  }
  
  /**
   * Add a message to an existing conversation
   */
  public async addMessageToConversation(
    conversationId: string,
    role: string,
    content: string,
    referencedFiles: { fileId: string; snippet?: string; lineStart?: number; lineEnd?: number }[] = []
  ): Promise<string> {
    try {
      // Create message
      const message = await prisma.message.create({
        data: {
          role,
          content,
          conversation: { connect: { id: conversationId } },
          referencedFiles: {
            create: referencedFiles.map(ref => ({
              file: { connect: { id: ref.fileId } },
              snippet: ref.snippet,
              lineStart: ref.lineStart,
              lineEnd: ref.lineEnd
            }))
          }
        }
      });
      
      // Update conversation updated timestamp
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() }
      });
      
      return message.id;
    } catch (error) {
      logger.error('Error adding message to conversation:', error);
      throw error;
    }
  }
}
