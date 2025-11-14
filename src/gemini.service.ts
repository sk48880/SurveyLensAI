import { Injectable, signal } from '@angular/core';
import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";

export interface SurveyResponse {
  rowId: number;
  [key: string]: any;
}

export interface AnalysisResult extends SurveyResponse {
  date?: Date; // Added for time-series analysis
  analysis?: {
    sentiment: 'positive' | 'neutral' | 'negative';
    sentiment_score: number;
    intent: 'feedback' | 'complaint' | 'praise' | 'suggestion' | 'question' | 'rant' | 'other';
    emotions: string[];
    topics: string[];
    explanation: string;
    confidence: number;
    redacted_excerpt: string;
  };
  error?: string;
}

const TOPIC_HIERARCHY = {
  "Product Experience": [
    "Product quality or durability issues",
    "Product not matching description/image",
    "Wrong or missing item received",
    "Product packaging quality",
    "Product variety or availability"
  ],
  "Delivery & Logistics": [
    "Delivery speed",
    "Delivery tracking accuracy",
    "Delivery person behavior",
    "Package condition",
    "Wrong or partial delivery"
  ],
  "Return, Refund & Replacement": [
    "Return pickup experience",
    "Refund processing time",
    "Replacement process",
    "Policy clarity",
    "Communication during refund"
  ],
  "Customer Service / Support": [
    "Issue resolution",
    "Response time",
    "Agent politeness",
    "Difficulty reaching support",
    "Escalation handling"
  ],
  "Pricing & Offers": [
    "Price fairness",
    "Discounts or coupons",
    "Hidden charges",
    "Value for money"
  ],
  "Website / App Usability": [
    "Ease of browsing",
    "Search and filter accuracy",
    "Checkout or payment process",
    "App performance issues",
    "Account management"
  ],
  "Order & Inventory Management": [
    "Out of stock issues",
    "Order cancellation",
    "Inventory accuracy",
    "Pre-order delays"
  ],
  "Overall Experience & Brand Trust": [
    "Overall satisfaction",
    "Brand trust",
    "Recommendation likelihood",
    "Repeat purchase intention"
  ]
};

@Injectable({ providedIn: 'root' })
export class GeminiService {
  private ai: GoogleGenAI | null = null;
  apiKey = signal<string>(process.env.API_KEY || '');
  isApiKeyValid = signal<boolean | null>(null);

  constructor() {
    if(this.apiKey()) {
      this.ai = new GoogleGenAI({ apiKey: this.apiKey() });
      this.isApiKeyValid.set(true);
    } else {
       this.isApiKeyValid.set(false);
    }
  }

  private readonly analysisSchema = {
    type: Type.OBJECT,
    properties: {
      sentiment: { type: Type.STRING, enum: ['positive', 'neutral', 'negative'] },
      sentiment_score: { type: Type.NUMBER, description: 'A score from -1.0 to 1.0' },
      intent: { type: Type.STRING, enum: ['feedback', 'complaint', 'praise', 'suggestion', 'question', 'rant', 'other'] },
      emotions: {
        type: Type.ARRAY,
        items: { type: Type.STRING, enum: ['joy', 'frustration', 'anger', 'sadness', 'confusion', 'gratitude'] }
      },
      topics: {
        type: Type.ARRAY,
        description: 'A list of 1 or 2 topics. The first is the main topic, the second is the sub-topic. e.g., ["Delivery & Logistics", "Delivery speed"]',
        items: { type: Type.STRING }
      },
      explanation: { type: Type.STRING, description: 'A brief explanation for the classification.' },
      confidence: { type: Type.INTEGER, description: 'Confidence score from 0 to 100.' },
      redacted_excerpt: { type: Type.STRING, description: 'The original text with PII (names, emails, phone numbers) redacted.' }
    },
    required: ['sentiment', 'sentiment_score', 'intent', 'emotions', 'topics', 'explanation', 'confidence', 'redacted_excerpt']
  };

  async analyzeSurveyResponse(responseText: string): Promise<any> {
    if (!this.ai) {
      throw new Error('Gemini AI client not initialized. Check API Key.');
    }
    try {
      const response = await this.ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: `Your task is to act as a survey analyst. Analyze the following customer feedback response. Classify the feedback into exactly one main topic and, if applicable, one sub-topic from the provided hierarchy. The "topics" array in your response should contain the main topic as the first element and the sub-topic as the second (if one applies). In your explanation, identify the core issue or praise. The feedback is: "${responseText}".\n\nHere is the topic hierarchy you MUST use:\n${JSON.stringify(TOPIC_HIERARCHY, null, 2)}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: this.analysisSchema
        }
      });
      return JSON.parse(response.text);
    } catch (error: any) {
      console.error('Error analyzing response:', error);
      let message = 'Failed to analyze response.';
      if (error?.message) {
        if (error.message.includes('429')) {
          message = 'API rate limit was reached. The process is being slowed down automatically. If this persists, please try a smaller file.';
        } else if (error.message.includes('404')) {
            message = `The specified model was not found. Please ensure you are using a valid Gemini model name.`;
        } else {
          message = error.message;
        }
      } else if (typeof error === 'string') {
        message = error;
      }
      return { error: message };
    }
  }

  async getChatbotResponse(query: string, context: AnalysisResult[]): Promise<string> {
    if (!this.ai) {
      throw new Error('Gemini AI client not initialized. Check API Key.');
    }
    const prompt = `
      System Instruction: You are an expert survey data analyst AI. Your primary goal is to provide detailed, grounded, and well-structured answers based *only* on the provided JSON data. **Your entire response MUST be valid HTML.** You must adhere to the specified HTML output format strictly. Do not use Markdown.

      User Prompt:
      Based *only* on the customer feedback data provided below in JSON format, answer the following question.

      **Data:**
      ${JSON.stringify(context.slice(0, 200))} <!-- Limit context size -->

      **Question:**
      ${query}

      **Required HTML Output Format (Follow this precisely):**
      1.  <strong>Summary:</strong> Begin with a concise, analytical summary that directly answers the user's question. This should be a 2-4 sentence synthesis of the findings. Quantify your findings where possible (e.g., "Based on the <strong>5</strong> relevant responses, the primary issue is..."). Use <strong> HTML tags to make numbers bold.
      2.  <strong>Detailed Breakdown:</strong> Under this header, provide a more exhaustive explanation using an unordered list (<ul><li>...</li></ul>).
      3.  <strong>Supporting Evidence:</strong> Under this header, list up to 3 of the most relevant feedback entries as an ordered list (<ol><li>...</li></ol>).
          *   Each item must be formatted exactly as: <li>(Row 42) <em>"The redacted verbatim excerpt..."</em> - Confidence: 92%</li>
          *   Use <em> HTML tags for the excerpt.
      4.  <strong>Conclusion:</strong> If applicable, provide a concluding sentence.
      5.  <strong>Audit Trail:</strong> Conclude with two separate lines, exactly as follows:
          <p>Source rows: [row_id_1, row_id_2, ...]</p>
          <p>Query confidence: [a percentage from 0-100 representing your confidence in the answer's relevance and accuracy based on the provided data]</p>
      6.  <strong>No Data:</strong> If no relevant data is found to answer the question, your entire response must be only: "<p>I could not find any relevant feedback in the provided data to answer your question.</p>"
    `;

    try {
      const response: GenerateContentResponse = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });
      return response.text;
    } catch (error: any) {
      console.error('Error getting chatbot response:', error);
      return `Sorry, I encountered an error while processing your request: ${error?.message || 'Unknown issue'}`;
    }
  }

  async generateRecommendations(context: AnalysisResult[], filterDescription: string): Promise<string> {
    if (!this.ai) {
      throw new Error('Gemini AI client not initialized. Check API Key.');
    }
    const prompt = `
      System Instruction: You are a senior business strategist and operations analyst AI. Your task is to generate actionable, plausible, and data-driven recommendations based on a specific subset of customer feedback. You must ground every recommendation in the provided data. **Your entire response MUST be valid HTML.** Do not use Markdown.

      **Provided Data (A subset of survey responses focusing on ${filterDescription}):**
      ${JSON.stringify(context.slice(0, 200))} <!-- Limit context size -->

      **Task:**
      Analyze the provided feedback to identify the root causes of customer sentiment. Based *only* on this data, generate a set of actionable recommendations to address the issues or amplify the positives.

      **Required HTML Output Format (Follow this precisely):**

      <h3>Actionable Recommendations for ${filterDescription}</h3>

      <strong>1. Recommendation Title (e.g., Improve Proactive Communication on Shipping Delays)</strong>
      <ul>
        <li><strong>Justification:</strong> Explain *why* this recommendation is necessary, citing evidence from the data. Quantify if possible (e.g., "<strong>7</strong> out of the <strong>10</strong> provided negative comments explicitly mention frustration with a lack of updates on their order status."). Use <em> for direct quotes.</li>
        <li><strong>Proposed Action:</strong> Describe a concrete, plausible action that could be taken (e.g., "Implement an automated email/SMS notification system that alerts customers when their package has been delayed by more than 24 hours from the original estimate.").</li>
      </ul>

      <strong>2. Recommendation Title (e.g., Review Packaging Standards for Fragile Items)</strong>
      <ul>
       <li><strong>Justification:</strong> ...</li>
       <li><strong>Proposed Action:</strong> ...</li>
      </ul>

      (Generate 2-4 distinct recommendations based on the most prominent themes in the data.)

      <p><strong>Concluding Summary:</strong>
      Provide a brief concluding paragraph that summarizes the strategic importance of addressing this feedback.</p>

      <strong>Constraint:</strong> Do NOT invent information or suggest actions that cannot be directly linked to the provided customer quotes. The goal is data-driven advice, not speculation.
    `;
     try {
      const response: GenerateContentResponse = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });
      return response.text;
    } catch (error: any) {
      console.error('Error getting recommendations:', error);
      return `Sorry, I encountered an error while generating recommendations: ${error?.message || 'Unknown issue'}`;
    }
  }

  async generateExecutiveSummary(context: AnalysisResult[], filterDescription: string): Promise<string> {
    if (!this.ai) {
      throw new Error('Gemini AI client not initialized. Check API Key.');
    }
    const prompt = `
      System Instruction: You are a senior data analyst AI. Your task is to generate a concise, analytical, and data-driven executive summary based on the provided customer feedback data. **Your entire response MUST be valid HTML.** Do not use Markdown.

      **Provided Data (A subset of survey responses from: ${filterDescription}):**
      ${JSON.stringify(context.slice(0, 250))} <!-- Limit context size -->

      **Task:**
      Analyze the provided feedback to identify the most significant trends, themes, and sentiments. Generate a concise executive summary of 100-150 words using bullet points for readability.

      **Required HTML Output Format (Follow this precisely):**
      
      <h4>Executive Summary</h4>
      <p>Based on the analysis of <strong>${context.length}</strong> responses:</p>
      <ul>
        <li>
          Start with a key finding. For example: "Negative sentiment comprises <strong>45%</strong> of the feedback, primarily driven by '<strong>Delivery & Logistics</strong>' issues."
          <ul>
            <li>Use sub-bullets for supporting details. For example: "Within this topic, '<strong>Delivery speed</strong>' was mentioned in <strong>15</strong> distinct complaints, making it the most critical sub-topic."</li>
          </ul>
        </li>
        <li>
          Provide another distinct insight. For example: "Positive feedback (<strong>35%</strong>) is strongly associated with '<strong>Product Experience</strong>', with '<strong>Product quality</strong>' frequently cited as a driver of praise."
        </li>
        <li>
          Mention any other significant patterns, for example, related to '<strong>intent</strong>'. "The most common intent is '<strong>complaint</strong>' (<strong>50%</strong>), followed by '<strong>feedback</strong>' (<strong>25%</strong>)."
        </li>
      </ul>
      <p>
        <strong>Key Insight:</strong> Conclude with the single most important, actionable insight a business leader should take away from this data subset.
      </p>

      <strong>Constraint:</strong> Ground ALL statements and numbers directly in the provided data. Do not speculate or invent information. Use <strong> tags for all numbers, percentages, topics, intents, and other significant keywords.
    `;
     try {
      const response: GenerateContentResponse = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });
      return response.text;
    } catch (error: any) {
      console.error('Error generating executive summary:', error);
      return `<p>Sorry, I encountered an error while generating the summary: ${error?.message || 'Unknown issue'}</p>`;
    }
  }
}