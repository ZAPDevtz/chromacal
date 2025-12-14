import { GoogleGenAI, Type } from "@google/genai";
import { MeasurementPoint, CalibrationResult, CalibrationSettings } from "../types";

// Robust API Key retrieval for both Vite (import.meta.env) and Node/Process (process.env)
const getApiKey = (): string => {
  try {
    // @ts-ignore - Handle Vite environment
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_KEY) {
      // @ts-ignore
      return import.meta.env.VITE_API_KEY;
    }
  } catch (e) {}

  try {
    // Handle Node/Compat environment
    if (typeof process !== 'undefined' && process.env && process.env.API_KEY) {
      return process.env.API_KEY;
    }
  } catch (e) {}

  return '';
};

const apiKey = getApiKey();

// Initialize Google GenAI client
// We pass the key if available, otherwise empty string (we check validity later)
const ai = new GoogleGenAI({ apiKey: apiKey || 'dummy-key' });

export const analyzeCalibration = async (measurements: MeasurementPoint[], settings: CalibrationSettings): Promise<CalibrationResult> => {
  
  // Define Fallback Profile (Offline Mode)
  // We define this here so we can return it easily from catch blocks
  const fallbackResult: CalibrationResult = {
    profileName: `Basic Profile (Offline Mode)`,
    gamma: parseFloat(settings.targetGamma) || 2.2,
    colorTemperature: "Uncalibrated",
    deltaE: 0,
    redGain: 1.0,
    greenGain: 1.0,
    blueGain: 1.0,
    contrastRatio: "N/A",
    feedback: "Connection to AI service failed or API Key is missing. This is a generic fallback profile. Please check your network connection and API configuration."
  };

  try {
    // 1. Validation inside the try block to catch "missing key" gracefully
    if (!apiKey) {
      console.warn("API Key is missing. Returning fallback.");
      return fallbackResult;
    }

    // 2. Prepare Payload
    const measurementData = measurements.map(m => ({
      label: m.label,
      target: `RGB(${m.targetColor.r}, ${m.targetColor.g}, ${m.targetColor.b})`,
      measured: m.measuredColor ? `RGB(${m.measuredColor.r}, ${m.measuredColor.g}, ${m.measuredColor.b})` : 'MISSING_DATA'
    }));

    const prompt = `
      Analyze this screen calibration data and generate a correction profile.
      
      MEASUREMENTS:
      ${JSON.stringify(measurementData, null, 2)}

      TARGET SETTINGS:
      - Gamma: ${settings.targetGamma}
      - White Point: ${settings.targetWhitePoint}

      REQUIREMENTS:
      1. Estimate the current display Gamma based on the grey measurements.
      2. Calculate RGB Gain adjustments (0.0 to 2.0) needed to fix White Point and Greyscale tracking.
      3. Calculate average DeltaE (CIEDE2000 approximation).
      4. Provide a professional summary of the display's errors and the corrections applied.
    `;

    // 3. Call Gemini API
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            profileName: { type: Type.STRING },
            gamma: { type: Type.NUMBER, description: "Estimated measured gamma (e.g. 2.1)" },
            colorTemperature: { type: Type.STRING, description: "Estimated measured CCT (e.g. 6200K)" },
            deltaE: { type: Type.NUMBER, description: "Average color difference" },
            redGain: { type: Type.NUMBER, description: "Correction multiplier for Red channel" },
            greenGain: { type: Type.NUMBER, description: "Correction multiplier for Green channel" },
            blueGain: { type: Type.NUMBER, description: "Correction multiplier for Blue channel" },
            contrastRatio: { type: Type.STRING, description: "Estimated contrast ratio" },
            feedback: { type: Type.STRING, description: "Professional analysis of the results" },
          },
          required: ["profileName", "gamma", "colorTemperature", "deltaE", "redGain", "greenGain", "blueGain", "feedback"]
        }
      }
    });

    // 4. Parse Response
    if (response.text) {
      const cleanedText = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleanedText) as CalibrationResult;
    }
    
    throw new Error("Gemini API returned empty response");

  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    // 5. Return Fallback on ANY error (network, key, parsing)
    // This ensures the UI never receives null/undefined
    return fallbackResult;
  }
};