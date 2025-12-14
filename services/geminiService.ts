import { GoogleGenAI, Type } from "@google/genai";
import { MeasurementPoint, CalibrationResult, CalibrationSettings } from "../types";

// Access API key from environment variable as required
const apiKey = process.env.API_KEY;

// Initialize Google GenAI client
// Note: We pass the key even if undefined to satisfy the constructor type, but we check before calling.
const ai = new GoogleGenAI({ apiKey: apiKey || '' });

export const analyzeCalibration = async (measurements: MeasurementPoint[], settings: CalibrationSettings): Promise<CalibrationResult> => {
  // 1. Validation
  if (!apiKey) {
    console.error("ERROR: API_KEY is missing from process.env. Analysis cannot proceed.");
    throw new Error("API Key is missing");
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

  try {
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
      // Robust parsing: strip potential markdown code blocks if present
      const cleanedText = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleanedText) as CalibrationResult;
    }
    
    throw new Error("Gemini API returned empty response");

  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    
    // 5. Fallback (Safe Mode)
    // We return a 'safe' result so the app doesn't crash, but indicate it's a fallback.
    return {
      profileName: `Basic Profile (Offline Mode)`,
      gamma: parseFloat(settings.targetGamma) || 2.2,
      colorTemperature: "Uncalibrated",
      deltaE: 0,
      redGain: 1.0,
      greenGain: 1.0,
      blueGain: 1.0,
      contrastRatio: "N/A",
      feedback: "Connection to AI service failed. This is a generic fallback profile. Please check your network connection and API configuration."
    };
  }
};