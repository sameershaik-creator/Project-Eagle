const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('outputCanvas');
const canvasCtx = canvasElement.getContext('2d');
const toggleBtn = document.getElementById('toggleBtn');
const dismissBtn = document.getElementById('dismissBtn');
const appMainWrapper = document.getElementById('appMainWrapper');
const systemStatus = document.getElementById('systemStatus');
const threatTimerDisplay = document.getElementById('threatTimer');
const peopleCountDisplay = document.getElementById('peopleCount');
const verifyOverlay = document.getElementById('verifyOverlay');
const verifyText = document.getElementById('verifyText');
const alertModal = document.getElementById('alertModal');
const thresholdSelect = document.getElementById('thresholdSelect');
const stealthBtn = document.getElementById('stealthBtn');
const observerConfidence = document.getElementById('observerConfidence');

let currentState = 'IDLE';
let detectionEngine = null;
let streamInstance = null;
let loopWorker = null;
let isProcessingFrame = false;
let verificationStartTime = null;
let lastFrameTime = Date.now();
let activeThreatThreshold = parseInt(thresholdSelect.value);

const activeConfidenceThreshold = 61; // Fixed 61% (Likely Observer) threshold for triggers

// Face centroid tracking state
let trackedFaces = new Map(); // id -> faceObject
let nextFaceId = 1;
let primaryFaceId = null;

const STABILITY_THRESHOLD = 0.015; // max center displacement between frames to be considered stable
const MIN_STABLE_FRAMES = 8;       // number of frames to confirm stability
const PERSISTENCE_THRESHOLD_MS = 1500; // time to keep face alive after last seen

let titleFlashId = null;
let audioCtx = null;
let sirenIntervalId = null;
let activeNotification = null;

// Display mode options
let isStealthMode = false;
let radarAngle = 0;

// Threat History session tracking
let threatIncremented = false;

const VERIFICATION_DURATION_MS = 5000;

thresholdSelect.addEventListener('change', () => {
    activeThreatThreshold = parseInt(thresholdSelect.value);
});

async function initNotificationPermissions() {
    if ('Notification' in window) {
        if (Notification.permission === 'default') {
            await Notification.requestPermission();
        }
    }
}

function startAudioSiren() {
    if (sirenIntervalId) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    let count = 0;
    sirenIntervalId = setInterval(() => {
        // High-end double-chirp digital alarm (similar to a real premium security system)
        let index = count % 4;
        count++;
        if (index > 1) return; // Silent gap for pulsing effect

        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();

        osc.type = 'sine'; // Crystal-clear sine wave (no harsh digital noise)
        osc.frequency.setValueAtTime(1400, audioCtx.currentTime); // High pitch (1400Hz)
        osc.frequency.exponentialRampToValueAtTime(1800, audioCtx.currentTime + 0.12); // Urgent sweep up

        // High volume gain (0.9)
        gain.gain.setValueAtTime(0.9, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.12);

        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc.start();
        osc.stop(audioCtx.currentTime + 0.13);
    }, 180);
}

function stopAudioSiren() {
    clearInterval(sirenIntervalId);
    sirenIntervalId = null;
}

function triggerDesktopAlert() {
    if ('Notification' in window && Notification.permission === 'granted' && !activeNotification) {
        activeNotification = new Notification("⚠️ EAGLE PRIVACY ALERT", {
            body: "Potential Observer Detected",
            requireInteraction: true
        });
        activeNotification.onclick = function (event) {
            event.preventDefault();
            window.focus();
            window.parent.focus();
            this.close();
        };
    }
}

function clearDesktopAlert() {
    if (activeNotification) {
        activeNotification.close();
        activeNotification = null;
    }
}

function startTitleFlashing() {
    if (titleFlashId) return;
    let toggled = false;
    titleFlashId = setInterval(() => {
        document.title = toggled ? "⚠️ THREAT DETECTED ⚠️" : "🚨 LOCKDOWN 🚨";
        toggled = !toggled;
    }, 500);
}

function stopTitleFlashing() {
    clearInterval(titleFlashId);
    titleFlashId = null;
    document.title = "Project Eagle - Privacy Shield";
}

function updateUI() {
    switch (currentState) {
        case 'IDLE':
            systemStatus.textContent = 'IDLE'; systemStatus.className = 'status-offline';
            verifyOverlay.style.opacity = '1'; verifyText.textContent = 'Click Start Protection to Begin';
            toggleBtn.textContent = 'Start Protection'; toggleBtn.style.background = '#2563eb';
            alertModal.classList.remove('show'); appMainWrapper.classList.remove('breached');
            threatTimerDisplay.textContent = '0.0s'; thresholdSelect.disabled = false;
            peopleCountDisplay.textContent = '0';
            stopAudioSiren(); stopTitleFlashing(); clearDesktopAlert();
            break;
        case 'VERIFICATION':
            systemStatus.textContent = 'VERIFYING'; systemStatus.className = 'status-warn';
            verifyOverlay.style.opacity = '1'; toggleBtn.textContent = 'Stop Protection';
            toggleBtn.style.background = '#ef4444'; thresholdSelect.disabled = true;
            break;
        case 'MONITORING':
            systemStatus.textContent = 'SAFE'; systemStatus.className = 'status-safe';
            verifyOverlay.style.opacity = '0'; alertModal.classList.remove('show');
            appMainWrapper.classList.remove('breached'); threatTimerDisplay.textContent = '0.0s';
            thresholdSelect.disabled = true;
            stopAudioSiren(); stopTitleFlashing(); clearDesktopAlert();
            break;
        case 'THREAT_DETECTED':
            systemStatus.textContent = 'POTENTIAL OBSERVER'; systemStatus.className = 'status-warn';
            break;
        case 'BREACH':
            systemStatus.textContent = 'BREACH'; systemStatus.className = 'status-danger';
            appMainWrapper.classList.add('breached'); alertModal.classList.add('show');
            startAudioSiren(); startTitleFlashing(); triggerDesktopAlert();
            break;
    }
}

function getFaceBounds(landmarks) {
    if (!landmarks || landmarks.length === 0) return null;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    landmarks.forEach(pt => {
        if (pt.x < xMin) xMin = pt.x;
        if (pt.x > xMax) xMax = pt.x;
        if (pt.y < yMin) yMin = pt.y;
        if (pt.y > yMax) yMax = pt.y;
    });

    let normWidth = xMax - xMin;
    let normHeight = yMax - yMin;
    let centerX = (xMin + xMax) / 2;
    let centerY = (yMin + yMax) / 2;

    let absWidth = normWidth * canvasElement.width;
    let absHeight = normHeight * canvasElement.height;
    let area = absWidth * absHeight;
    let ratio = absWidth / absHeight;

    return {
        xMin, xMax, yMin, yMax,
        normWidth, normHeight,
        centerX, centerY,
        area, ratio
    };
}

function getFaceArea(landmarks) {
    let bounds = getFaceBounds(landmarks);
    if (!bounds) return 0;
    
    // Aspect ratio filter: human faces are roughly 0.6-0.9 aspect ratio.
    // Allow wide margins [0.3 to 1.5] for tilts, glasses, and wide-angle webcam distortion
    if (bounds.ratio < 0.3 || bounds.ratio > 1.5) return 0;

    // Max size filter: reject enormous background patterns (e.g. wall shadows/textures)
    if (bounds.normWidth > 0.65 || bounds.normHeight > 0.75) return 0;
    
    return bounds.area;
}

// Center-Weighted Area Scoring function to classify the Primary User
function getPrimaryScore(faceBounds) {
    if (!faceBounds) return 0;
    // Euclidean distance from center of screen (0.5, 0.5)
    const distToCenter = Math.sqrt(
        Math.pow(faceBounds.centerX - 0.5, 2) + 
        Math.pow(faceBounds.centerY - 0.5, 2)
    );
    // Score favors larger area and closer to horizontal/vertical center
    return faceBounds.area / (1.0 + 4.0 * distToCenter);
}

function calculateOrientationScore(landmarks) {
    if (!landmarks || landmarks.length < 468) return 0;

    // Horizontal check (Yaw)
    const leftX = (landmarks[33].x + landmarks[61].x + landmarks[234].x) / 3;
    const rightX = (landmarks[263].x + landmarks[291].x + landmarks[454].x) / 3;
    const centerX = (landmarks[1].x + landmarks[4].x) / 2;
    const totalWidth = Math.abs(rightX - leftX);
    if (totalWidth === 0) return 0;
    const yawRatio = Math.abs(centerX - leftX) / totalWidth;

    // Vertical check (Pitch)
    const eyeY = (landmarks[33].y + landmarks[263].y) / 2;
    const mouthY = (landmarks[61].y + landmarks[291].y) / 2;
    const noseY = landmarks[1].y;
    const heightSpan = Math.abs(mouthY - eyeY);
    if (heightSpan === 0) return 0;
    const pitchRatio = (noseY - eyeY) / heightSpan;

    // Calculate horizontal score: deviation runs [0.0, 0.25] mapped to [1.0, 0.0]
    const yawDeviation = Math.abs(yawRatio - 0.5);
    const yawScore = Math.max(0, 1 - (yawDeviation / 0.25));

    // Calculate vertical score: deviation runs [0.0, 0.4] mapped to [1.0, 0.0]
    // Assume normal pitchRatio is around 0.45
    const pitchDeviation = Math.abs(pitchRatio - 0.45);
    const pitchScore = Math.max(0, 1 - (pitchDeviation / 0.4));

    return yawScore * pitchScore;
}

function calculateStabilityScore(trackedFace) {
    if (trackedFace.history.length === 0) return 0;
    const sumDisp = trackedFace.history.reduce((sum, h) => sum + h.displacement, 0);
    const avgDisplacement = sumDisp / trackedFace.history.length;

    // Max stability at avgDisplacement <= 0.005, min stability at >= 0.04
    const stabilityScore = Math.max(0, Math.min(1, 1 - (avgDisplacement - 0.005) / 0.035));
    return stabilityScore;
}

function calculateVisibilityQualityScore(bounds) {
    if (!bounds) return 0;
    // Aspect ratio score: how close to typical face aspect ratio (around 0.75)
    const arDeviation = Math.abs(bounds.ratio - 0.75);
    const arScore = Math.max(0, Math.min(1, 1 - arDeviation / 0.45));

    // Do not penalize being near the edges of the frame
    return arScore;
}

function calculatePersistenceDurationScore(trackedFace) {
    const elapsed = Date.now() - trackedFace.firstSeen;
    // Linearly scales to 1.0 over 1000ms (1 second) for responsive detection
    return Math.min(1.0, elapsed / 1000);
}

function getClassificationLabel(confidence, classification) {
    if (classification === 'Unknown') return 'Unknown';
    if (confidence <= 30) return 'Insufficient Evidence';
    if (confidence <= 60) return 'Possible Observer';
    if (confidence <= 80) return 'Likely Observer';
    return 'High Confidence Observer';
}

function drawRadarBackground() {
    const width = canvasElement.width;
    const height = canvasElement.height;

    // Dark cyber radar grid
    canvasCtx.fillStyle = '#060a13';
    canvasCtx.fillRect(0, 0, width, height);

    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = Math.min(width, height) * 0.45;

    // Draw sonar rings
    canvasCtx.strokeStyle = 'rgba(56, 189, 248, 0.15)';
    canvasCtx.lineWidth = 1;
    for (let r = 0.2; r <= 1.0; r += 0.2) {
        canvasCtx.beginPath();
        canvasCtx.arc(centerX, centerY, maxRadius * r, 0, 2 * Math.PI);
        canvasCtx.stroke();

        // Ring labels
        canvasCtx.fillStyle = 'rgba(56, 189, 248, 0.3)';
        canvasCtx.font = '8px Roboto Mono, monospace';
        canvasCtx.fillText(`${Math.round(r * 100)}m`, centerX + 5, centerY - maxRadius * r + 10);
    }

    // Draw grid crosshairs
    canvasCtx.beginPath();
    canvasCtx.moveTo(centerX - maxRadius, centerY);
    canvasCtx.lineTo(centerX + maxRadius, centerY);
    canvasCtx.moveTo(centerX, centerY - maxRadius);
    canvasCtx.lineTo(centerX, centerY + maxRadius);
    canvasCtx.stroke();

    // Sonar sweep rotation
    radarAngle += 0.035;
    if (radarAngle > 2 * Math.PI) radarAngle = 0;

    canvasCtx.beginPath();
    canvasCtx.moveTo(centerX, centerY);
    const sweepX = centerX + maxRadius * Math.cos(radarAngle);
    const sweepY = centerY + maxRadius * Math.sin(radarAngle);
    canvasCtx.lineTo(sweepX, sweepY);

    // Glow trace sweep
    const sweepGrad = canvasCtx.createRadialGradient(centerX, centerY, 5, centerX, centerY, maxRadius);
    sweepGrad.addColorStop(0, 'rgba(56, 189, 248, 0.2)');
    sweepGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');
    canvasCtx.strokeStyle = sweepGrad;
    canvasCtx.lineWidth = 4;
    canvasCtx.stroke();
}

function drawRadarBlip(trackedFace) {
    const bounds = trackedFace.bounds;
    const width = canvasElement.width;
    const height = canvasElement.height;

    // Map normalized coordinates directly onto output canvas pixels
    const xVal = bounds.centerX * width;
    const yVal = bounds.centerY * height;

    const isPrimary = (trackedFace.id === primaryFaceId);
    let color = '#94a3b8'; // Slate/Gray default
    let label = `Face #${trackedFace.id}: Unknown`;

    if (isPrimary) {
        color = '#10b981'; // Green
        label = `Face #${trackedFace.id}: Primary`;
    } else {
        if (trackedFace.classification === 'Unknown') {
            color = '#94a3b8'; // Gray
            label = `Face #${trackedFace.id}: Unknown`;
        } else if (trackedFace.classification === 'Neutral') {
            color = '#38bdf8'; // Blue
            label = `Face #${trackedFace.id}: Neutral`;
        } else if (trackedFace.classification === 'Possible Observer') {
            color = '#f59e0b'; // Yellow/Orange
            label = `Face #${trackedFace.id}: Possible`;
        } else if (trackedFace.classification === 'Likely Observer') {
            color = '#ef4444'; // Red
            label = `Face #${trackedFace.id}: Likely`;
        } else if (trackedFace.classification === 'High Confidence Observer') {
            color = '#ef4444'; // Red
            label = `Face #${trackedFace.id}: High Conf`;
        }
    }

    // Draw blip indicator
    canvasCtx.fillStyle = color;
    canvasCtx.shadowColor = color;
    canvasCtx.shadowBlur = 15;
    canvasCtx.beginPath();
    canvasCtx.arc(xVal, yVal, 7, 0, 2 * Math.PI);
    canvasCtx.fill();
    canvasCtx.shadowBlur = 0;

    // Draw ripple rings
    const ringRadius = 7 + (Date.now() % 1000) * 0.012;
    const ringOpacity = 1 - (Date.now() % 1000) / 1000;
    canvasCtx.strokeStyle = color;
    canvasCtx.lineWidth = 1.5;
    canvasCtx.globalAlpha = ringOpacity;
    canvasCtx.beginPath();
    canvasCtx.arc(xVal, yVal, ringRadius, 0, 2 * Math.PI);
    canvasCtx.stroke();
    canvasCtx.globalAlpha = 1.0;

    // Draw vector gaze pointer
    if (!isPrimary && trackedFace.classification !== 'Unknown' && trackedFace.orientationScore > 0) {
        canvasCtx.strokeStyle = color;
        canvasCtx.lineWidth = 2;
        canvasCtx.beginPath();
        canvasCtx.moveTo(xVal, yVal);
        const vectorLen = 25;
        canvasCtx.lineTo(xVal, yVal - vectorLen);
        canvasCtx.stroke();
    }

    // Render Blip Label
    canvasCtx.fillStyle = '#ffffff';
    canvasCtx.font = 'bold 9px Roboto Mono, monospace';
    canvasCtx.fillText(label, xVal + 12, yVal - 5);

    // Render coordinates
    canvasCtx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    canvasCtx.font = '7px Roboto Mono, monospace';
    canvasCtx.fillText(`[${bounds.centerX.toFixed(2)}, ${bounds.centerY.toFixed(2)}]`, xVal + 12, yVal + 5);
}

function drawFaceHUD(trackedFace) {
    const landmarks = trackedFace.landmarks;
    const bounds = trackedFace.bounds;
    const x = bounds.xMin * canvasElement.width;
    const y = bounds.yMin * canvasElement.height;
    const w = bounds.normWidth * canvasElement.width;
    const h = bounds.normHeight * canvasElement.height;

    const isPrimary = (trackedFace.id === primaryFaceId);
    let color = '#94a3b8'; // Slate/Gray default
    let label = `Face #${trackedFace.id}: Unknown`;

    if (isPrimary) {
        color = '#10b981'; // Green
        label = `Face #${trackedFace.id}: Primary User`;
    } else {
        if (trackedFace.classification === 'Unknown') {
            color = '#94a3b8'; // Gray
            label = `Face #${trackedFace.id}: Unknown`;
        } else if (trackedFace.classification === 'Neutral') {
            color = '#38bdf8'; // Blue
            label = `Face #${trackedFace.id}: Neutral`;
        } else if (trackedFace.classification === 'Possible Observer') {
            color = '#f59e0b'; // Yellow/Orange
            label = `Face #${trackedFace.id}: Possible Observer`;
        } else if (trackedFace.classification === 'Likely Observer') {
            color = '#ef4444'; // Red
            label = `Face #${trackedFace.id}: Likely Observer`;
        } else if (trackedFace.classification === 'High Confidence Observer') {
            color = '#ef4444'; // Red
            label = `Face #${trackedFace.id}: High Confidence Observer`;
        }
    }

    // Draw Sleek Cyber Corner Brackets (dashed if Unknown)
    canvasCtx.strokeStyle = color;
    canvasCtx.lineWidth = 3;
    if (trackedFace.classification === 'Unknown' && !isPrimary) {
        canvasCtx.setLineDash([4, 4]);
    } else {
        canvasCtx.setLineDash([]);
    }
    const bracketLen = Math.min(w * 0.2, 30);

    // Top-Left
    canvasCtx.beginPath();
    canvasCtx.moveTo(x, y + bracketLen);
    canvasCtx.lineTo(x, y);
    canvasCtx.lineTo(x + bracketLen, y);
    canvasCtx.stroke();

    // Top-Right
    canvasCtx.beginPath();
    canvasCtx.moveTo(x + w, y + bracketLen);
    canvasCtx.lineTo(x + w, y);
    canvasCtx.lineTo(x + w - bracketLen, y);
    canvasCtx.stroke();

    // Bottom-Left
    canvasCtx.beginPath();
    canvasCtx.moveTo(x, y + h - bracketLen);
    canvasCtx.lineTo(x, y + h);
    canvasCtx.lineTo(x + bracketLen, y + h);
    canvasCtx.stroke();

    // Bottom-Right
    canvasCtx.beginPath();
    canvasCtx.moveTo(x + w, y + h - bracketLen);
    canvasCtx.lineTo(x + w, y + h);
    canvasCtx.lineTo(x + w - bracketLen, y + h);
    canvasCtx.stroke();

    // Reset line dash
    canvasCtx.setLineDash([]);

    // Draw Status Pill Background
    canvasCtx.fillStyle = color;
    canvasCtx.font = 'bold 11px Inter, -apple-system, sans-serif';
    const labelWidth = canvasCtx.measureText(label).width;
    canvasCtx.fillRect(x, y - 25, labelWidth + 12, 20);

    // Draw Status Pill Text
    canvasCtx.fillStyle = '#ffffff';
    canvasCtx.fillText(label, x + 6, y - 11);

    // Draw Diagnostics Underneath
    let diagText = '';
    if (isPrimary) {
        diagText = `Primary Session Authenticated`;
    } else {
        diagText = `Conf: ${trackedFace.confidence}% | Stab: ${calculateStabilityScore(trackedFace).toFixed(2)} | Qual: ${calculateVisibilityQualityScore(bounds).toFixed(2)}`;
    }
    canvasCtx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    canvasCtx.font = '9px Roboto Mono, monospace';
    canvasCtx.fillText(diagText, x, y + h + 15);
}

function processFrameResults(results) {
    if (canvasElement.width === 0 || canvasElement.height === 0) return;

    let now = Date.now();
    let dt = now - lastFrameTime;
    if (dt > 1000) dt = 100;
    lastFrameTime = now;

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // If stealth mode is active, render the grid radar background
    if (isStealthMode && currentState !== 'IDLE') {
        drawRadarBackground();
    }

    let rawFaces = results.multiFaceLandmarks ? [...results.multiFaceLandmarks] : [];
    let detectedFaces = [];

    rawFaces.forEach(landmarks => {
        let area = getFaceArea(landmarks);
        // Minimum threshold of 2500 pixels (50x50 area equivalent)
        if (area > 2500) {
            landmarks._bounds = getFaceBounds(landmarks);
            detectedFaces.push(landmarks);
        }
    });

    // Centroid face tracking & association
    let matchedIds = new Set();
    let currentFrameTracked = [];

    detectedFaces.forEach(face => {
        const bounds = face._bounds;
        const center = { x: bounds.centerX, y: bounds.centerY };

        let bestMatchId = null;
        let minDistance = Infinity;

        for (let [id, tf] of trackedFaces.entries()) {
            if (matchedIds.has(id)) continue;
            const dist = Math.sqrt(
                Math.pow(center.x - tf.center.x, 2) +
                Math.pow(center.y - tf.center.y, 2)
            );
            if (dist < 0.15 && dist < minDistance) {
                minDistance = dist;
                bestMatchId = id;
            }
        }

        if (bestMatchId !== null) {
            matchedIds.add(bestMatchId);
            let tf = trackedFaces.get(bestMatchId);

            const displacement = Math.sqrt(
                Math.pow(center.x - tf.center.x, 2) +
                Math.pow(center.y - tf.center.y, 2)
            );
            tf.history.push({ center, time: now, displacement });
            if (tf.history.length > 10) tf.history.shift();

            if (displacement < STABILITY_THRESHOLD) {
                tf.consecutiveStableFrames++;
            } else if (displacement > STABILITY_THRESHOLD * 2.5) {
                tf.consecutiveStableFrames = 0;
            }
            tf.isStable = (tf.consecutiveStableFrames >= MIN_STABLE_FRAMES);

            tf.center = center;
            tf.bounds = bounds;
            tf.landmarks = face;
            tf.lastSeen = now;

            currentFrameTracked.push(tf);
        } else {
            const newId = nextFaceId++;
            const newTracked = {
                id: newId,
                center,
                bounds,
                landmarks: face,
                firstSeen: now,
                lastSeen: now,
                history: [{ center, time: now, displacement: 0 }],
                consecutiveStableFrames: 0,
                isStable: false,
                threatDuration: 0,
                confidence: 0,
                classification: 'Neutral',
                orientationScore: 0
            };
            trackedFaces.set(newId, newTracked);
            currentFrameTracked.push(newTracked);
        }
    });

    // Clean up stale tracked faces
    for (let [id, tf] of trackedFaces.entries()) {
        if (now - tf.lastSeen > PERSISTENCE_THRESHOLD_MS) {
            trackedFaces.delete(id);
            if (primaryFaceId === id) {
                primaryFaceId = null;
            }
        }
    }

    // For any tracked face that is not in the current frame, reset its threat duration to 0
    for (let [id, tf] of trackedFaces.entries()) {
        if (!currentFrameTracked.some(cft => cft.id === id)) {
            tf.threatDuration = 0;
        }
    }

    let totalDetections = currentFrameTracked.length;
    peopleCountDisplay.textContent = totalDetections;

    // Dynamically update primaryFaceId to the face with the highest primary user score
    if (currentState === 'MONITORING' || currentState === 'THREAT_DETECTED' || currentState === 'BREACH') {
        let bestFaceId = null;
        let maxPrimaryScore = -1;
        currentFrameTracked.forEach(tf => {
            const score = getPrimaryScore(tf.bounds);
            if (score > maxPrimaryScore) {
                maxPrimaryScore = score;
                bestFaceId = tf.id;
            }
        });
        if (bestFaceId !== null) {
            primaryFaceId = bestFaceId;
        }
    }

    // Calculate scores, classification, and confidence for secondary faces
    currentFrameTracked.forEach(tf => {
        if (tf.id === primaryFaceId) {
            tf.classification = 'Primary User';
            tf.confidence = 0;
            tf.orientationScore = 0;
            return;
        }

        const orientationScore = calculateOrientationScore(tf.landmarks);
        tf.orientationScore = orientationScore;

        const stabilityScore = calculateStabilityScore(tf);
        const visibilityQualityScore = calculateVisibilityQualityScore(tf.bounds);
        const persistenceDurationScore = calculatePersistenceDurationScore(tf);

        // Uncertainty "Unknown" check - only filter if visibility quality (aspect ratio) is extremely bad
        if (visibilityQualityScore < 0.25) {
            tf.classification = 'Unknown';
            tf.confidence = 0;
        } else if (orientationScore > 0.0) {
            // Gaze orientation is the primary indicator of screen-watching (85% weight)
            // stability and quality are minor secondary factors (5% and 10% weight)
            const rawConf = (orientationScore * 0.85 + stabilityScore * 0.05 + visibilityQualityScore * 0.1) * 100;
            let finalConf = Math.round(rawConf * persistenceDurationScore);

            // Normalize confidence: Scale confidence upwards towards 100% based on threatDuration (staring duration)
            if (tf.threatDuration > 0 && activeThreatThreshold > 0) {
                const growthFactor = tf.threatDuration / activeThreatThreshold;
                finalConf = Math.min(100, Math.round(finalConf + growthFactor * (100 - finalConf)));
            }

            tf.confidence = finalConf;
            tf.classification = getClassificationLabel(tf.confidence, 'Neutral');
        } else {
            tf.confidence = 0;
            tf.classification = 'Neutral';
        }

        // Threat Assessment & Timer updates
        // We require the face to have been tracked for at least 500ms (persistenceDurationScore >= 0.5) to filter out single-frame glitches.
        // We do not require strict stability (tf.isStable) since looking at the screen can happen while moving.
        const isThreatObserver = 
            (persistenceDurationScore >= 0.5) &&
            (tf.orientationScore > 0.1) && 
            (tf.confidence >= activeConfidenceThreshold) &&
            tf.classification !== 'Unknown';

        if (isThreatObserver) {
            tf.threatDuration += dt;
            if (tf.threatDuration > activeThreatThreshold) {
                tf.threatDuration = activeThreatThreshold;
            }
        } else {
            // Freeze the timer when looking away: do not increment, do not reset.
        }
    });

    // Gather overall stats
    let maxThreatDuration = 0;
    let maxConfidence = 0;
    let maxConfidenceClass = 'Neutral';
    let secondaryFacesCount = 0;
    let activeObserverDetected = false;

    currentFrameTracked.forEach(tf => {
        if (tf.id === primaryFaceId) return;
        secondaryFacesCount++;

        if (tf.confidence > maxConfidence) {
            maxConfidence = tf.confidence;
            maxConfidenceClass = tf.classification;
        }
        if (tf.threatDuration > maxThreatDuration) {
            maxThreatDuration = tf.threatDuration;
        }
        if (tf.threatDuration > 0) {
            activeObserverDetected = true;
        }
    });

    // Update Live Observer Confidence display
    if (observerConfidence) {
        if (secondaryFacesCount > 0) {
            // Check if the worst face is in the Unknown state and has 0% confidence
            const hasUnknown = currentFrameTracked.some(tf => tf.id !== primaryFaceId && tf.classification === 'Unknown');
            if (maxConfidence === 0 && hasUnknown) {
                observerConfidence.textContent = '0% (Unknown)';
            } else {
                observerConfidence.textContent = `${maxConfidence}% (${getClassificationLabel(maxConfidence, maxConfidenceClass)})`;
            }
        } else {
            observerConfidence.textContent = '0%';
        }
    }

    // Draw HUD elements for all active faces
    if (document.visibilityState === 'visible' && currentState !== 'IDLE') {
        currentFrameTracked.forEach(tf => {
            if (isStealthMode) {
                drawRadarBlip(tf);
            } else {
                drawFaceHUD(tf);
            }
        });
    }

    // Main App State Machine
    if (currentState === 'VERIFICATION') {
        if (totalDetections >= 1) {
            if (!verificationStartTime) verificationStartTime = Date.now();
            const elapsed = Date.now() - verificationStartTime;
            verifyText.textContent = `Verifying Primary User... ${(elapsed / 1000).toFixed(1)}s / 5s`;
            if (elapsed >= VERIFICATION_DURATION_MS) {
                // Lock the face ID closest to center
                let bestFace = null;
                let minCenterDist = Infinity;
                trackedFaces.forEach(tf => {
                    const dist = Math.sqrt(Math.pow(tf.center.x - 0.5, 2) + Math.pow(tf.center.y - 0.5, 2));
                    if (dist < minCenterDist) {
                        minCenterDist = dist;
                        bestFace = tf;
                    }
                });
                if (bestFace) {
                    primaryFaceId = bestFace.id;
                }
                currentState = 'MONITORING'; 
                updateUI();
            }
        } else {
            verificationStartTime = null; 
            verifyText.textContent = 'Look at the camera to complete verification...';
        }
    }
    else if (currentState === 'MONITORING' || currentState === 'THREAT_DETECTED' || currentState === 'BREACH') {
        if (currentState === 'BREACH') {
            // Manual dismissal only, do not transition automatically.
        } else if (maxThreatDuration >= activeThreatThreshold) {
            if (currentState !== 'BREACH') {
                currentState = 'BREACH'; 
                updateUI();
            }
        } else if (activeObserverDetected) {
            if (currentState !== 'THREAT_DETECTED') {
                currentState = 'THREAT_DETECTED'; 
                updateUI();
            }
        } else {
            if (currentState !== 'MONITORING') {
                currentState = 'MONITORING'; 
                updateUI();
            }
        }

        if (currentState !== 'BREACH') {
            if (maxThreatDuration > 0) {
                const countdownLeft = Math.max(0, ((activeThreatThreshold - maxThreatDuration) / 1000)).toFixed(1);
                threatTimerDisplay.textContent = `${countdownLeft}s`;
            } else {
                threatTimerDisplay.textContent = '0.0s';
            }
        } else {
            threatTimerDisplay.textContent = '0.0s';
        }
    }

    canvasCtx.restore();
}

function initLoopWorker() {
    if (loopWorker) return;
    const workerCode = `
        let isRunning = false;
        function loop() {
            if (!isRunning) return;
            self.postMessage('tick');
        }
        self.onmessage = function(e) {
            if (e.data === 'start') {
                isRunning = true;
                loop();
            } else if (e.data === 'stop') {
                isRunning = false;
            } else if (e.data === 'next') {
                setTimeout(loop, 33);
            }
        };
    `;
    const blob = new Blob([workerCode], {type: 'application/javascript'});
    loopWorker = new Worker(URL.createObjectURL(blob));
    loopWorker.onmessage = async (e) => {
        if (e.data === 'tick' && currentState !== 'IDLE' && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
            if (!isProcessingFrame && detectionEngine) {
                isProcessingFrame = true;
                if (canvasElement.width === 0 || canvasElement.height === 0) {
                    canvasElement.width = videoElement.videoWidth || 640;
                    canvasElement.height = videoElement.videoHeight || 480;
                }
                try {
                    await detectionEngine.send({ image: videoElement });
                } catch(err) {
                    console.error("Frame processing error:", err);
                }
                isProcessingFrame = false;
                loopWorker.postMessage('next');
            } else {
                loopWorker.postMessage('next');
            }
        } else if (e.data === 'tick') {
            setTimeout(() => loopWorker.postMessage('next'), 100);
        }
    };
}

async function startApplication() {
    await initNotificationPermissions();
    try {
        if (typeof FaceMesh !== 'undefined') {
            if (!detectionEngine) {
                detectionEngine = new FaceMesh({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
                // Higher confidence options (0.75) to prevent background static noise hallucinations
                detectionEngine.setOptions({ 
                    maxNumFaces: 4, 
                    refineLandmarks: false, 
                    minDetectionConfidence: 0.75, 
                    minTrackingConfidence: 0.75 
                });
                detectionEngine.onResults(processFrameResults);
            }

            trackedFaces.clear();
            nextFaceId = 1;
            primaryFaceId = null;
            currentState = 'VERIFICATION'; verificationStartTime = null; lastFrameTime = Date.now(); updateUI();

            videoElement.onloadedmetadata = () => {
                canvasElement.width = videoElement.videoWidth || 640;
                canvasElement.height = videoElement.videoHeight || 480;
            };

            initLoopWorker();
            
            if (!streamInstance) {
                streamInstance = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
                videoElement.srcObject = streamInstance;
            }
            await videoElement.play();
            loopWorker.postMessage('start');
        } else {
            alert("MediaPipe FaceMesh scripts failed to load. Check your internet connection.");
        }
    } catch (err) {
        currentState = 'IDLE'; updateUI(); alert("Webcam access failed or was denied.");
    }
}

function stopApplication() {
    currentState = 'IDLE';
    if (loopWorker) {
        loopWorker.postMessage('stop');
    }
    if (streamInstance) {
        streamInstance.getTracks().forEach(track => track.stop());
        streamInstance = null;
    }
    videoElement.srcObject = null; 
    trackedFaces.clear();
    nextFaceId = 1;
    primaryFaceId = null;
    updateUI(); 
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
}

function dismissShieldCountermeasures() {
    trackedFaces.forEach(tf => {
        tf.threatDuration = 0;
    });
    currentState = 'MONITORING';
    updateUI();
}

toggleBtn.addEventListener('click', () => { 
    // Explicit user gesture: Initialize and resume AudioContext
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    if (currentState === 'IDLE') startApplication(); 
    else stopApplication(); 
});
dismissBtn.addEventListener('click', dismissShieldCountermeasures);

if (stealthBtn) {
    stealthBtn.addEventListener('click', () => {
        isStealthMode = !isStealthMode;
        if (isStealthMode) {
            stealthBtn.textContent = 'Stealth Radar Active';
            stealthBtn.classList.add('active');
            videoElement.style.opacity = '0'; // Hide camera feed visually
        } else {
            stealthBtn.textContent = 'Camera Feed Active';
            stealthBtn.classList.remove('active');
            videoElement.style.opacity = '1'; // Show camera feed visually
        }
    });
}

// App initialized