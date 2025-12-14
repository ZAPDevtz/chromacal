import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Camera, RefreshCw, XCircle, Crosshair, Lock, Unlock, AlertCircle, CheckCircle2, Scan } from 'lucide-react';
import { RGB } from '../types';

interface SensorModeProps {
  onBack: () => void;
}

// Define extended types for Image Capture API properties not in standard DOM types
interface ExtendedMediaTrackSettings extends MediaTrackSettings {
  exposureMode?: string;
  exposureTime?: number;
  whiteBalanceMode?: string;
  iso?: number;
  focusMode?: string;
  focusDistance?: number;
  colorTemperature?: number;
  zoom?: number;
}

interface ExtendedMediaTrackCapabilities extends MediaTrackCapabilities {
  exposureMode?: string[];
  whiteBalanceMode?: string[];
  focusMode?: string[];
}

export const SensorMode: React.FC<SensorModeProps> = ({ onBack }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<RGB[]>([]); 
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [measuredRGB, setMeasuredRGB] = useState<RGB>({ r: 0, g: 0, b: 0 });
  const [isFrozen, setIsFrozen] = useState(false);
  const [isStable, setIsStable] = useState(false);
  const [error, setError] = useState<string>('');
  
  // New State for Calibration Workflow
  const [calibrationStage, setCalibrationStage] = useState<'SETUP' | 'MEASURING'>('SETUP');
  const [isHardwareLocked, setIsHardwareLocked] = useState(false);
  const [referenceWhite, setReferenceWhite] = useState<RGB | null>(null);

  // Focus State
  const [focusPoint, setFocusPoint] = useState<{x: number, y: number} | null>(null);

  const startCamera = async () => {
    try {
      const constraints = {
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          // Request simple continuous mode initially
          // @ts-ignore - Non-standard constraints
          exposureMode: 'continuous',
          // @ts-ignore
          whiteBalanceMode: 'continuous',
          // @ts-ignore
          focusMode: 'continuous'
        } as MediaTrackConstraints
      };
      
      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
      setError('');
    } catch (err) {
      console.error("Camera access denied:", err);
      setError("Unable to access camera. Please check permissions.");
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
  };

  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, []);

  // --- Tap to Focus Logic ---
  const handleTapToFocus = async (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
    // Only allow focus changes in SETUP mode to avoid breaking lock
    if (calibrationStage !== 'SETUP' || !stream || !containerRef.current) return;

    // Get coordinates
    const rect = containerRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;

    const x = clientX - rect.left;
    const y = clientY - rect.top;

    // 1. Visual Feedback
    setFocusPoint({ x, y });
    // Remove focus ring after animation
    setTimeout(() => setFocusPoint(null), 1000);

    // 2. Apply Camera Constraint
    const track = stream.getVideoTracks()[0];
    const capabilities = (track.getCapabilities ? track.getCapabilities() : {}) as ExtendedMediaTrackCapabilities;

    // Calculate normalized coordinates (0.0 - 1.0)
    const normX = x / rect.width;
    const normY = y / rect.height;

    try {
      // Try using experimental pointsOfInterest if available (Chrome Android)
      const constraints: any = { 
        advanced: [{ 
          pointsOfInterest: [{ x: normX, y: normY }],
          focusMode: 'continuous' // Ensure it triggers a seek
        }] 
      };
      
      await track.applyConstraints(constraints);
    } catch (err) {
      // Fallback: Just try to trigger standard continuous focus
      try {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as any);
      } catch (e) {
        console.debug("Focus constraint failed", e);
      }
    }
  };

  // --- Lock Exposure Logic ---
  const handleLockExposure = async (e?: React.MouseEvent) => {
    if(e) e.stopPropagation(); // Prevent tap-to-focus when clicking button
    
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    
    // 1. Capture current Reference White
    setReferenceWhite(measuredRGB);

    // 2. Attempt Hardware Lock
    try {
      const capabilities = (track.getCapabilities ? track.getCapabilities() : {}) as ExtendedMediaTrackCapabilities;
      const settings = track.getSettings() as ExtendedMediaTrackSettings;
      
      const advancedConstraints: any = {};
      let hasAdvanced = false;

      // Logic: If device supports manual mode, switch to 'manual' using current settings as values if possible.
      // This preserves the focus distance set by the previous Tap-to-Focus interaction.
      
      if (capabilities.exposureMode && capabilities.exposureMode.includes('manual')) {
        advancedConstraints.exposureMode = 'manual';
        if (settings.exposureTime) advancedConstraints.exposureTime = settings.exposureTime;
        if (settings.iso) advancedConstraints.iso = settings.iso;
        hasAdvanced = true;
      }

      if (capabilities.whiteBalanceMode && capabilities.whiteBalanceMode.includes('manual')) {
        advancedConstraints.whiteBalanceMode = 'manual';
        if (settings.colorTemperature) advancedConstraints.colorTemperature = settings.colorTemperature;
        hasAdvanced = true;
      }

      if (capabilities.focusMode && capabilities.focusMode.includes('manual')) {
        advancedConstraints.focusMode = 'manual';
        // IMPORTANT: Lock at current focus distance (set by auto-focus or tap-to-focus)
        if (settings.focusDistance) advancedConstraints.focusDistance = settings.focusDistance;
        hasAdvanced = true;
      }

      if (hasAdvanced && track.applyConstraints) {
        await track.applyConstraints({ advanced: [advancedConstraints] });
        setIsHardwareLocked(true);
      } else {
        console.warn("Hardware locking not fully supported, relying on software reference.");
        setIsHardwareLocked(false); 
      }
      
      setCalibrationStage('MEASURING');
    } catch (e) {
      console.error("Lock failed:", e);
      // Fallback: Just proceed
      setCalibrationStage('MEASURING');
    }
  };

  // Handle video playback state based on frozen status
  useEffect(() => {
    if (videoRef.current && videoRef.current.srcObject) {
      if (isFrozen) {
        videoRef.current.pause();
      } else {
        videoRef.current.play().catch(e => console.error("Resume play failed:", e));
      }
    }
  }, [isFrozen]);

  const processFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || isFrozen) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    if (!ctx) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Analyze center 50x50 area
      const centerX = Math.floor(canvas.width / 2);
      const centerY = Math.floor(canvas.height / 2);
      const sampleSize = 50;
      const offset = Math.floor(sampleSize / 2);

      const frameData = ctx.getImageData(centerX - offset, centerY - offset, sampleSize, sampleSize);
      const data = frameData.data;

      let r = 0, g = 0, b = 0;
      const pixelCount = data.length / 4;

      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
      }

      const newRGB = {
        r: Math.round(r / pixelCount),
        g: Math.round(g / pixelCount),
        b: Math.round(b / pixelCount)
      };

      setMeasuredRGB(newRGB);

      // --- Stability Check Logic ---
      const history = historyRef.current;
      history.push(newRGB);
      if (history.length > 10) history.shift();

      if (history.length >= 5) {
        let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
        
        for (const val of history) {
            minR = Math.min(minR, val.r); maxR = Math.max(maxR, val.r);
            minG = Math.min(minG, val.g); maxG = Math.max(maxG, val.g);
            minB = Math.min(minB, val.b); maxB = Math.max(maxB, val.b);
        }
        
        const variance = Math.max(maxR - minR, maxG - minG, maxB - minB);
        setIsStable(variance < 6);
      } else {
        setIsStable(false);
      }
    }

    requestAnimationFrame(processFrame);
  }, [isFrozen]);

  useEffect(() => {
    const handle = requestAnimationFrame(processFrame);
    return () => cancelAnimationFrame(handle);
  }, [processFrame]);

  const toggleFreeze = () => {
    setIsFrozen(!isFrozen);
  };

  const rgbString = `rgb(${measuredRGB.r}, ${measuredRGB.g}, ${measuredRGB.b})`;
  const hexString = `#${((1 << 24) + (measuredRGB.r << 16) + (measuredRGB.g << 8) + measuredRGB.b).toString(16).slice(1).toUpperCase()}`;

  return (
    <div className="flex flex-col h-screen bg-black text-white select-none">
      {/* Header */}
      <div className="p-4 flex items-center justify-between border-b border-white/10 bg-zinc-900/50 backdrop-blur z-20">
        <button onClick={onBack} className="p-2 hover:bg-white/10 rounded-full transition-colors">
          <XCircle className="w-6 h-6 text-zinc-400" />
        </button>
        <div className="flex flex-col items-center">
          <h2 className="text-lg font-bold tracking-tight">
            {calibrationStage === 'SETUP' ? 'Calibration Setup' : 'Sensor Mode'}
          </h2>
          {calibrationStage === 'MEASURING' && (
            <div className="flex items-center gap-1 text-[10px] uppercase font-bold text-green-500 tracking-wider">
               <Lock className="w-3 h-3" /> Exposure Locked
            </div>
          )}
        </div>
        <div className="w-10"></div>
      </div>

      {/* Main Viewport */}
      <div 
        ref={containerRef}
        className="relative flex-1 bg-black flex items-center justify-center overflow-hidden cursor-crosshair touch-none"
        onClick={handleTapToFocus}
        onTouchEnd={(e) => {
          // Prevent ghost clicks but allow handler
          // handleTapToFocus will extract touch data
          handleTapToFocus(e);
        }}
      >
        {error ? (
          <div className="text-red-400 p-8 text-center max-w-xs">{error}</div>
        ) : (
          <>
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              muted 
              className="absolute inset-0 w-full h-full object-cover opacity-80"
            />
            <canvas ref={canvasRef} className="hidden" />

            {/* Focus Ring Animation */}
            {focusPoint && (
              <div 
                className="absolute w-16 h-16 border-2 border-yellow-400 rounded-lg -translate-x-1/2 -translate-y-1/2 pointer-events-none z-30 animate-[ping_0.5s_ease-out_1]"
                style={{ top: focusPoint.y, left: focusPoint.x }}
              >
                <div className="absolute inset-0 border border-white/50 rounded-lg"></div>
              </div>
            )}
            
            {/* STAGE 1: SETUP OVERLAY */}
            {calibrationStage === 'SETUP' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 z-10 animate-in fade-in pointer-events-none">
                 {/* Background Blur only on bottom/text area so we can see camera */}
                 <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-black/40"></div>
                 
                 <div className="max-w-md w-full text-center space-y-6 pointer-events-auto">
                    {/* Top Guide */}
                    <div className="absolute top-8 left-0 right-0 text-center">
                       <p className="text-white/70 text-sm font-medium bg-black/40 inline-block px-4 py-2 rounded-full backdrop-blur-md">
                         <Scan className="w-4 h-4 inline mr-2" /> Tap screen to focus
                       </p>
                    </div>

                    <div className="mt-40">
                      <h3 className="text-2xl font-bold mb-2 drop-shadow-md">Exposure Lock</h3>
                      <p className="text-zinc-300 drop-shadow-md text-sm mb-6">
                        Point camera at the white patch.
                      </p>
                      
                      <div className="bg-zinc-900/80 backdrop-blur-md border border-white/10 p-4 rounded-xl text-left mb-6 shadow-xl">
                         <h4 className="font-bold text-blue-400 text-xs uppercase mb-2">Instructions</h4>
                         <ol className="list-decimal pl-4 text-xs text-zinc-200 space-y-2">
                           <li>Ensure <strong>"Reference White"</strong> is on screen.</li>
                           <li>Tap screen to <strong>Focus</strong> on center.</li>
                           <li>Wait for stable reading.</li>
                           <li><strong>Lock Exposure</strong> before measuring colors.</li>
                         </ol>
                      </div>

                      <div>
                        <div className="text-xs text-zinc-400 mb-2 font-mono">Current: {rgbString}</div>
                        <button 
                          onClick={handleLockExposure}
                          className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold text-lg shadow-lg shadow-blue-900/40 transition-transform active:scale-95 flex items-center justify-center gap-2"
                        >
                          <Lock className="w-5 h-5" /> Lock Exposure & Start
                        </button>
                      </div>
                    </div>
                 </div>
              </div>
            )}

            {/* STAGE 2: MEASURING UI */}
            {calibrationStage === 'MEASURING' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div 
                  className={`relative w-64 h-64 border-2 rounded-full flex items-center justify-center transition-all duration-300 ${
                    isStable 
                      ? 'border-green-400 shadow-[0_0_30px_rgba(74,222,128,0.4)] scale-105' 
                      : 'border-white/30'
                  }`}
                >
                  <div className={`w-16 h-1 absolute transition-colors duration-300 ${isStable ? 'bg-green-400' : 'bg-white/50'}`}></div>
                  <div className={`w-1 h-16 absolute transition-colors duration-300 ${isStable ? 'bg-green-400' : 'bg-white/50'}`}></div>
                  <div className="w-12 h-12 border-2 border-yellow-400 rounded-lg shadow-[0_0_15px_rgba(250,204,21,0.5)] bg-transparent"></div>
                </div>
                
                <div className="mt-8 bg-black/60 backdrop-blur px-4 py-2 rounded-full text-xs font-mono text-zinc-300 flex items-center gap-2 transition-all">
                  {isStable ? (
                    <>
                      <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                      <span className="text-green-400 font-bold tracking-wider">STABLE</span>
                    </>
                  ) : (
                    <span>Align with patch</span>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Control Panel (Only visible in Measuring stage) */}
      {calibrationStage === 'MEASURING' && (
        <div className="p-6 bg-zinc-900 border-t border-white/10 animate-in slide-in-from-bottom duration-300">
          <div className="flex items-center gap-6">
            {/* Measured Swatch */}
            <div 
              className="w-24 h-24 rounded-2xl shadow-inner border-4 border-white/10 relative overflow-hidden"
              style={{ backgroundColor: rgbString }}
            >
              <div className="absolute inset-0 bg-gradient-to-tr from-black/20 to-transparent"></div>
            </div>

            {/* Values */}
            <div className="flex-1 space-y-3">
              <div className="flex justify-between items-baseline">
                <span className="text-xs text-zinc-500 uppercase font-bold">Hex</span>
                <span className="font-mono text-xl">{hexString}</span>
              </div>
              <div className="flex justify-between text-sm font-mono text-zinc-400">
                <span>R <span className="text-white ml-2">{measuredRGB.r}</span></span>
                <span>G <span className="text-white ml-2">{measuredRGB.g}</span></span>
                <span>B <span className="text-white ml-2">{measuredRGB.b}</span></span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3 mt-6">
            <button 
               onClick={() => setCalibrationStage('SETUP')}
               className="col-span-1 py-4 rounded-xl font-medium bg-zinc-800 text-zinc-400 hover:text-white flex flex-col items-center justify-center gap-1 text-xs"
               title="Unlock Exposure"
            >
               <Unlock className="w-5 h-5" /> Reset
            </button>
            <button 
              onClick={toggleFreeze}
              className={`col-span-3 py-4 rounded-xl font-bold text-lg flex items-center justify-center gap-2 transition-all shadow-lg ${
                isFrozen 
                ? 'bg-amber-500 text-black hover:bg-amber-400 shadow-amber-900/20' 
                : 'bg-white text-black hover:bg-zinc-200 shadow-white/10'
              }`}
            >
              {isFrozen ? (
                <>Unfreeze Sensor <RefreshCw className="w-5 h-5" /></>
              ) : (
                <>Capture Measurement <Camera className="w-5 h-5" /></>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};