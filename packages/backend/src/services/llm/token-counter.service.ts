// src/services/llm/token-counter.service.ts

import { logger } from '../../utils/logging';

/**
 * Service for counting tokens in text for LLM APIs
 */
export class TokenCounter {
  /**
   * Count tokens in a string
   * This is a simple approximation; in production, use a proper tokenizer 
   * matching the LLM model's tokenization
   */
  public countTokens(text: string): number {
    if (!text) return 0;
    
    try {
      // Very rough approximation for English text
      // For Claude/GPT, ~4 characters per token on average
      const charCount = text.length;
      return Math.ceil(charCount / 4);
      
      // In a real implementation, you would use the actual tokenizer
      // Example for OpenAI:
      // return encoding.encode(text).length;
      
      // Example for Anthropic:
      // return claude.getNumTokens(text);
    } catch (error) {
      logger.error('Error counting tokens:', error);
      // Fallback approximation
      return Math.ceil(text.length / 4);
    }
  }
}
